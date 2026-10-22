import { assert, describe, it } from "@effect/vitest";
import { type OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as FactoryReactor from "./FactoryReactor.ts";
import { FactoryService } from "./FactoryService.ts";

const LEAD_THREAD = ThreadId.make("thread-lead");

type Call = { readonly _tag: "sweep" } | { readonly _tag: "thread"; readonly threadId: ThreadId };

/** The reactor reads only an event's type and thread, so the rest of the payload is left out. */
const domainEvent = (type: OrchestrationV2DomainEvent["type"], threadId: ThreadId) =>
  ({ type, threadId }) as OrchestrationV2DomainEvent;

/**
 * A started reactor over a recording service and a fake domain event stream. `emit` returns once
 * the reactor has queued the event's work and that work has drained; `minuteSweep` returns once
 * the next periodic sweep ran.
 */
const startReactor = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
  const sweeps = yield* Queue.unbounded<void>();
  const inbox = yield* Queue.unbounded<{
    readonly event: OrchestrationV2DomainEvent;
    readonly consumed: Deferred.Deferred<void>;
  }>();
  let previous: Deferred.Deferred<void> | undefined;
  // The reactor pulls the next event only after it queued work for the previous one.
  const streamDomainEvents = Stream.fromEffectRepeat(
    Effect.gen(function* () {
      if (previous) yield* Deferred.succeed(previous, undefined);
      const next = yield* Queue.take(inbox);
      previous = next.consumed;
      return next.event;
    }),
  );
  const record = (call: Call) => Ref.update(calls, (recorded) => [...recorded, call]);
  const reactor = yield* FactoryReactor.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(FactoryService)({
          sweep: record({ _tag: "sweep" }).pipe(Effect.ensuring(Queue.offer(sweeps, undefined))),
          reconcileThread: (threadId) => record({ _tag: "thread", threadId }),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents }),
      ),
    ),
  );
  const sweepReceipt = Queue.take(sweeps).pipe(Effect.andThen(reactor.drain));
  yield* reactor.start();
  yield* sweepReceipt;
  return {
    calls: Ref.get(calls),
    emit: (type: OrchestrationV2DomainEvent["type"], threadId: ThreadId) =>
      Effect.gen(function* () {
        const consumed = yield* Deferred.make<void>();
        yield* Queue.offer(inbox, { event: domainEvent(type, threadId), consumed });
        yield* Deferred.await(consumed);
        yield* reactor.drain;
      }),
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
