import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as FactoryReactor from "./FactoryReactor.ts";
import {
  type FactoryMergedPullRequest,
  type FactoryObservedThread,
  FactoryService,
} from "./FactoryService.ts";

const LEAD_THREAD = ThreadId.make("thread-lead");
const CHILD_THREAD = ThreadId.make("thread-child");

type Call =
  | { readonly _tag: "sweep" }
  | { readonly _tag: "thread"; readonly threadId: ThreadId }
  | { readonly _tag: "observe"; readonly thread: FactoryObservedThread }
  | { readonly _tag: "merged"; readonly merged: FactoryMergedPullRequest };

/** The reactor reads only an event's type, thread and new thread's lineage and model. */
const domainEvent = (type: OrchestrationV2DomainEvent["type"], threadId: ThreadId) =>
  ({ type, threadId }) as OrchestrationV2DomainEvent;

/**
 * A fake stream for the reactor to pull from. `push` returns once the reactor pulled the value and
 * queued its work, which it does before pulling the next one.
 */
const handshakeStream = <A>() =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<{
      readonly value: A;
      readonly consumed: Deferred.Deferred<void>;
    }>();
    let previous: Deferred.Deferred<void> | undefined;
    const stream = Stream.fromEffectRepeat(
      Effect.gen(function* () {
        if (previous) yield* Deferred.succeed(previous, undefined);
        const next = yield* Queue.take(inbox);
        previous = next.consumed;
        return next.value;
      }),
    );
    const push = (value: A) =>
      Effect.gen(function* () {
        const consumed = yield* Deferred.make<void>();
        yield* Queue.offer(inbox, { value, consumed });
        yield* Deferred.await(consumed);
      });
    return { stream, push };
  });

/**
 * A started reactor over a recording service and fake domain event and merge streams. `emit` and
 * `merge` return once the reactor has queued the work and that work has drained; `minuteSweep`
 * returns once the next periodic sweep ran.
 */
const startReactor = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
  const sweeps = yield* Queue.unbounded<void>();
  const events = yield* handshakeStream<OrchestrationV2DomainEvent>();
  const merges = yield* handshakeStream<PullRequestService.PullRequestMergeEvent>();
  const record = (call: Call) => Ref.update(calls, (recorded) => [...recorded, call]);
  const reactor = yield* FactoryReactor.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(FactoryService)({
          sweep: record({ _tag: "sweep" }).pipe(Effect.ensuring(Queue.offer(sweeps, undefined))),
          reconcileThread: (threadId) => record({ _tag: "thread", threadId }),
          reconcileMerge: (merged) => record({ _tag: "merged", merged }),
          observeThread: (thread) => record({ _tag: "observe", thread }),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: events.stream }),
        Layer.mock(PullRequestService.PullRequestService)({
          subscribeMerges: Effect.succeed(merges.stream),
        }),
      ),
    ),
  );
  const sweepReceipt = Queue.take(sweeps).pipe(Effect.andThen(reactor.drain));
  const emitEvent = (event: OrchestrationV2DomainEvent) =>
    events.push(event).pipe(Effect.andThen(reactor.drain));
  yield* reactor.start();
  yield* sweepReceipt;
  return {
    calls: Ref.get(calls),
    emit: (type: OrchestrationV2DomainEvent["type"], threadId: ThreadId) =>
      emitEvent(domainEvent(type, threadId)),
    emitEvent,
    merge: (event: PullRequestService.PullRequestMergeEvent) =>
      merges.push(event).pipe(Effect.andThen(reactor.drain)),
    minuteSweep: TestClock.adjust("1 minute").pipe(Effect.andThen(sweepReceipt)),
  };
});

describe("FactoryReactor", () => {
  it.effect("sweeps once at startup", () =>
    Effect.gen(function* () {
      const reactor = yield* startReactor;
      assert.deepStrictEqual(yield* reactor.calls, [{ _tag: "sweep" }]);
    }),
  );

  it.effect("reconciles the thread of a run event and ignores unrelated events", () =>
    Effect.gen(function* () {
      const reactor = yield* startReactor;
      yield* reactor.emit("message.updated", LEAD_THREAD);
      assert.deepStrictEqual(yield* reactor.calls, [{ _tag: "sweep" }]);

      yield* reactor.emit("run.updated", LEAD_THREAD);
      yield* reactor.emit("thread.deleted", LEAD_THREAD);
      assert.deepStrictEqual(yield* reactor.calls, [
        { _tag: "sweep" },
        { _tag: "thread", threadId: LEAD_THREAD },
        { _tag: "thread", threadId: LEAD_THREAD },
      ]);
    }),
  );

  it.effect("reconciles the thread when one of its requests changes", () =>
    Effect.gen(function* () {
      const reactor = yield* startReactor;
      yield* reactor.emit("runtime-request.updated", LEAD_THREAD);
      assert.deepStrictEqual(yield* reactor.calls, [
        { _tag: "sweep" },
        { _tag: "thread", threadId: LEAD_THREAD },
      ]);
    }),
  );

  it.effect("reconciles the thread when a pull request is linked or unlinked", () =>
    Effect.gen(function* () {
      const reactor = yield* startReactor;
      yield* reactor.emit("thread.pull-request-link-updated", LEAD_THREAD);
      assert.deepStrictEqual(yield* reactor.calls, [
        { _tag: "sweep" },
        { _tag: "thread", threadId: LEAD_THREAD },
      ]);
    }),
  );

  it.effect("reconciles the thread when its pull requests sync", () =>
    Effect.gen(function* () {
      const reactor = yield* startReactor;
      yield* reactor.emit("thread.pull-request-synced", LEAD_THREAD);
      assert.deepStrictEqual(yield* reactor.calls, [
        { _tag: "sweep" },
        { _tag: "thread", threadId: LEAD_THREAD },
      ]);
    }),
  );

  it.effect("observes a new thread with its parent and model", () =>
    Effect.gen(function* () {
      const reactor = yield* startReactor;
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      yield* reactor.emitEvent({
        type: "thread.created",
        threadId: CHILD_THREAD,
        payload: {
          id: CHILD_THREAD,
          modelSelection,
          lineage: {
            rootThreadId: LEAD_THREAD,
            parentThreadId: LEAD_THREAD,
            relationshipToParent: "subagent",
          },
        },
      } as OrchestrationV2DomainEvent);
      assert.deepStrictEqual(yield* reactor.calls, [
        { _tag: "sweep" },
        {
          _tag: "observe",
          thread: { threadId: CHILD_THREAD, parentThreadId: LEAD_THREAD, modelSelection },
        },
      ]);
    }),
  );

  it.effect("reconciles a pull request the user merges, without waiting for its sync", () =>
    Effect.gen(function* () {
      const reactor = yield* startReactor;
      yield* reactor.merge({
        projectId: ProjectId.make("project-1"),
        repository: "acme/atlas",
        number: 42,
        mergedAt: "2026-10-24T09:00:00.000Z",
      });
      assert.deepStrictEqual(yield* reactor.calls, [
        { _tag: "sweep" },
        { _tag: "merged", merged: { repository: "acme/atlas", number: 42 } },
      ]);
    }),
  );

  it.effect("sweeps again every minute", () =>
    Effect.gen(function* () {
      const reactor = yield* startReactor;
      yield* reactor.minuteSweep;
      yield* reactor.minuteSweep;
      assert.deepStrictEqual(yield* reactor.calls, [
        { _tag: "sweep" },
        { _tag: "sweep" },
        { _tag: "sweep" },
      ]);
    }),
  );
});
