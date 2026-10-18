import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as IssueAttemptReactor from "./IssueAttemptReactor.ts";
import { IssueService } from "./IssueService.ts";
import {
  BOARD_ID,
  makeIssueHarness,
  remoteFailure,
  withDatabase,
  type IssueHarness,
} from "./IssueService.test.helpers.ts";

type AttemptEventType =
  | "run.created"
  | "run.updated"
  | "thread.pull-request-link-updated"
  | "thread.pull-request-synced"
  | "thread.deleted";

/** The reactor reads only an event's type and thread, so the rest of the payload is left out. */
const domainEvent = (type: AttemptEventType, threadId: ThreadId) =>
  ({ type, threadId }) as OrchestrationV2DomainEvent;

/**
 * Wires the reactor to the harness's service and a fake domain event stream. `emit` returns once
 * the reactor has queued the event's work and that work has drained; `sweepReceipt` yields after
 * each sweep the reactor runs.
 */
const makeReactor = Effect.fn("makeIssueAttemptReactor")(function* (test: IssueHarness) {
  const inbox = yield* Queue.unbounded<{
    readonly event: OrchestrationV2DomainEvent;
    readonly consumed: Deferred.Deferred<void>;
  }>();
  const sweeps = yield* Queue.unbounded<void>();
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
  const reactor = yield* IssueAttemptReactor.make.pipe(
    Effect.provideService(IssueService, {
      ...test.service,
      sweep: test.service.sweep.pipe(Effect.ensuring(Queue.offer(sweeps, undefined))),
    }),
    Effect.provide(Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents })),
  );
  const sweepReceipt = Queue.take(sweeps).pipe(Effect.andThen(reactor.drain));
  return {
    /** Starts the reactor and waits for its startup sweep. */
    start: reactor.start().pipe(Effect.andThen(sweepReceipt)),
    emit: (type: AttemptEventType, threadId: ThreadId) =>
      Effect.gen(function* () {
        const consumed = yield* Deferred.make<void>();
        yield* Queue.offer(inbox, { event: domainEvent(type, threadId), consumed });
        yield* Deferred.await(consumed);
        yield* reactor.drain;
      }),
    minuteSweep: TestClock.adjust("1 minute").pipe(Effect.andThen(sweepReceipt)),
  };
});

/** A configured board, a started reactor, and an attempt on ticket 1 still launching. */
const launched = (mapping: Parameters<IssueHarness["configureBoard"]>[0] = {}) =>
  Effect.gen(function* () {
    const test = yield* makeIssueHarness();
    yield* test.configureBoard(mapping);
    const reactor = yield* makeReactor(test);
    yield* reactor.start;
    const { threadId, attempt } = yield* test.startAttempt(1);
    return { test, reactor, threadId, attemptId: attempt.id };
  });

/** As `launched`, with the first run reaching running and the ticket in In progress. */
const working = (mapping: Parameters<IssueHarness["configureBoard"]>[0] = {}) =>
  Effect.gen(function* () {
    const fixture = yield* launched(mapping);
    yield* fixture.test.threadRunning(fixture.threadId);
    yield* fixture.reactor.emit("run.updated", fixture.threadId);
    return fixture;
  });

/** As `working`, with a ready pull request 7 linked and the ticket in In PR. */
const inPullRequest = (mapping: Parameters<IssueHarness["configureBoard"]>[0] = {}) =>
  Effect.gen(function* () {
    const fixture = yield* working(mapping);
    yield* fixture.test.linkPullRequest(fixture.threadId, 7, "open");
    yield* fixture.reactor.emit("thread.pull-request-link-updated", fixture.threadId);
    return fixture;
  });

const attemptOf = (test: IssueHarness, attemptId: string) =>
  test.attemptsOf(1).pipe(Effect.map((attempts) => attempts.find((a) => a.id === attemptId)!));

describe("IssueAttemptReactor", () => {
  it.effect("moves the ticket to In progress exactly once when the first run reaches running", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* launched();
        yield* test.threadRunning(threadId);
        yield* reactor.emit("run.created", threadId);
        yield* reactor.emit("run.updated", threadId);
        yield* reactor.emit("run.updated", threadId);

        assert.deepStrictEqual(test.writes, [{ ticket: 1, columnId: "progress" }]);
        const attempt = yield* attemptOf(test, attemptId);
        assert.strictEqual(attempt.status, "working");
        assert.strictEqual(attempt.active, true);
        assert.strictEqual(attempt.worktreePath, "/repo/.t3/worktrees/thread-1");
        assert.strictEqual(attempt.automaticMoves, "on");
      }),
    ),
  );

  it.effect("an automatic move held up by an unreachable host is applied by a later sweep", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId } = yield* launched();
        yield* test.fail("readItem", remoteFailure());
        yield* test.threadRunning(threadId);
        yield* reactor.emit("run.updated", threadId);
        const held = yield* test.latestMove(1);
        assert.deepStrictEqual([held?.origin, held?.status], ["automatic", "pending"]);

        yield* test.fail("readItem", null);
        yield* reactor.minuteSweep;
        assert.strictEqual((yield* test.latestMove(1))?.status, "applied");
        assert.deepStrictEqual(test.writes, [{ ticket: 1, columnId: "progress" }]);
      }),
    ),
  );

  it.effect("a launch whose first run fails leaves the ticket and the earlier attempt alone", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, attemptId: earlier } = yield* working();
        yield* test.moveByHand(1, "ready");
        const restart = yield* test.startAttempt(1, "restart");
        yield* test.firstRunFailed(restart.threadId);
        yield* reactor.emit("run.updated", restart.threadId);

        assert.deepStrictEqual(test.writes, [{ ticket: 1, columnId: "progress" }]);
        assert.strictEqual(test.remoteColumn(1), "ready");
        assert.deepStrictEqual(
          (yield* test.attemptsOf(1)).map((attempt) => [
            attempt.id,
            attempt.status,
            attempt.active,
          ]),
          [
            [earlier, "working", true],
            [restart.attempt.id, "failed", false],
          ],
        );
      }),
    ),
  );

  it.effect("a draft pull request moves the ticket to In PR and marking it ready does not", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* working();
        yield* test.linkPullRequest(threadId, 7, "draft");
        yield* reactor.emit("thread.pull-request-link-updated", threadId);
        yield* test.setPullRequest(threadId, 7, "open");
        yield* reactor.emit("thread.pull-request-synced", threadId);

        assert.deepStrictEqual(test.writes, [
          { ticket: 1, columnId: "progress" },
          { ticket: 1, columnId: "pr" },
        ]);
        const attempt = yield* attemptOf(test, attemptId);
        assert.strictEqual(attempt.status, "in-pr");
        assert.deepStrictEqual(attempt.controllingPullRequest, {
          host: "github.com",
          repository: "acme/app",
          number: 7,
          url: "https://github.com/acme/app/pull/7",
        });
      }),
    ),
  );

  it.effect("a pull request closed without merging returns the ticket to In progress", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* inPullRequest();
        yield* test.setPullRequest(threadId, 7, "closed");
        yield* reactor.emit("thread.pull-request-synced", threadId);

        assert.strictEqual(test.remoteColumn(1), "progress");
        assert.strictEqual((yield* attemptOf(test, attemptId)).status, "working");
      }),
    ),
  );

  it.effect("a merged pull request moves the ticket to Done when the switch is on", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* inPullRequest();
        yield* test.setPullRequest(threadId, 7, "merged");
        yield* reactor.emit("thread.pull-request-synced", threadId);

        assert.strictEqual(test.remoteColumn(1), "done");
        assert.strictEqual((yield* attemptOf(test, attemptId)).status, "merged");
      }),
    ),
  );

  it.effect("a merged pull request leaves the ticket in In PR when the switch is off", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* inPullRequest({
          moveOnMerge: false,
        });
        yield* test.setPullRequest(threadId, 7, "merged");
        yield* reactor.emit("thread.pull-request-synced", threadId);

        assert.strictEqual(test.remoteColumn(1), "pr");
        assert.strictEqual(test.writes.length, 2);
        assert.strictEqual((yield* attemptOf(test, attemptId)).status, "merged");
      }),
    ),
  );

  it.effect("a newer pull request takes control, so the earlier one closing changes nothing", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* inPullRequest();
        yield* test.linkPullRequest(threadId, 8, "open");
        yield* reactor.emit("thread.pull-request-link-updated", threadId);
        yield* test.setPullRequest(threadId, 7, "closed");
        yield* reactor.emit("thread.pull-request-synced", threadId);

        assert.deepStrictEqual(test.writes, [
          { ticket: 1, columnId: "progress" },
          { ticket: 1, columnId: "pr" },
        ]);
        const attempt = yield* attemptOf(test, attemptId);
        assert.strictEqual(attempt.status, "in-pr");
        assert.strictEqual(attempt.controllingPullRequest?.number, 8);
      }),
    ),
  );

  it.effect("unlinking the controlling pull request returns the ticket to In progress", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* inPullRequest();
        yield* test.unlinkPullRequest(threadId, 7);
        yield* reactor.emit("thread.pull-request-link-updated", threadId);

        assert.strictEqual(test.remoteColumn(1), "progress");
        const attempt = yield* attemptOf(test, attemptId);
        assert.strictEqual(attempt.status, "working");
        assert.strictEqual(attempt.controllingPullRequest, null);
      }),
    ),
  );

  it.effect("a ticket moved by hand skips the automatic move and pauses the attempt", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* inPullRequest();
        yield* test.moveByHand(1, "blocked");
        yield* test.setPullRequest(threadId, 7, "closed");
        yield* reactor.emit("thread.pull-request-synced", threadId);

        assert.strictEqual(test.remoteColumn(1), "blocked");
        const skipped = yield* test.latestMove(1);
        assert.strictEqual(skipped?.status, "skipped");
        assert.strictEqual(skipped?.error, "Moved by hand to Blocked.");
        assert.strictEqual(skipped?.columnId, "progress");

        yield* test.openBoard(true);
        yield* test.service.drainRefreshes;
        assert.strictEqual((yield* attemptOf(test, attemptId)).automaticMoves, "paused");
      }),
    ),
  );

  it.effect("Retry on a skipped move applies it and automatic moves resume from there", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* inPullRequest();
        yield* test.moveByHand(1, "blocked");
        yield* test.setPullRequest(threadId, 7, "closed");
        yield* reactor.emit("thread.pull-request-synced", threadId);
        const skipped = (yield* test.latestMove(1))!;

        const retried = yield* test.service.retryMove({ requestId: "retry", moveId: skipped.id });
        assert.strictEqual(retried.status, "applied");
        assert.strictEqual(retried.origin, "manual");
        assert.strictEqual(test.remoteColumn(1), "progress");
        assert.strictEqual((yield* attemptOf(test, attemptId)).automaticMoves, "on");

        yield* test.linkPullRequest(threadId, 8, "open");
        yield* reactor.emit("thread.pull-request-link-updated", threadId);
        assert.strictEqual(test.remoteColumn(1), "pr");
      }),
    ),
  );

  it.effect("putting the ticket back where the attempt left it resumes automatic moves", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* inPullRequest();
        yield* test.moveByHand(1, "blocked");
        yield* test.openBoard(true);
        yield* test.service.drainRefreshes;
        assert.strictEqual((yield* attemptOf(test, attemptId)).automaticMoves, "paused");

        yield* test.moveByHand(1, "pr");
        yield* test.openBoard(true);
        yield* test.service.drainRefreshes;
        assert.strictEqual((yield* attemptOf(test, attemptId)).automaticMoves, "on");

        yield* test.setPullRequest(threadId, 7, "closed");
        yield* reactor.emit("thread.pull-request-synced", threadId);
        assert.strictEqual(test.remoteColumn(1), "progress");
      }),
    ),
  );

  it.effect("Stop ends the attempt and later thread events no longer move the ticket", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* working();
        const stopped = yield* test.service.endAttempt({ requestId: "stop", attemptId });
        assert.deepStrictEqual(
          [stopped.status, stopped.active, stopped.endedReason],
          ["ended", false, "user"],
        );

        yield* test.linkPullRequest(threadId, 7, "open");
        yield* reactor.emit("thread.pull-request-link-updated", threadId);
        assert.strictEqual(test.remoteColumn(1), "progress");
        assert.strictEqual((yield* attemptOf(test, attemptId)).status, "ended");
      }),
    ),
  );

  it.effect("Stop with a return column moves the ticket back to Ready", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, attemptId } = yield* working();
        const refused = yield* test.service
          .endAttempt({ requestId: "stop-to-done", attemptId, returnToColumnId: "done" })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "invalid");

        yield* test.service.endAttempt({ requestId: "stop", attemptId, returnToColumnId: "ready" });
        assert.strictEqual(test.remoteColumn(1), "ready");
        const move = yield* test.latestMove(1);
        assert.deepStrictEqual([move?.origin, move?.status], ["manual", "applied"]);
      }),
    ),
  );

  it.effect("Resume after Stop picks up from the ticket's current column", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* working();
        yield* test.service.endAttempt({ requestId: "stop", attemptId, returnToColumnId: "ready" });

        const resumed = yield* test.service.resumeAttempt({ requestId: "resume", attemptId });
        assert.deepStrictEqual(
          [resumed.status, resumed.active, resumed.endedReason],
          ["working", true, null],
        );
        assert.strictEqual(test.remoteColumn(1), "progress");

        yield* test.linkPullRequest(threadId, 7, "open");
        yield* reactor.emit("thread.pull-request-link-updated", threadId);
        assert.strictEqual(test.remoteColumn(1), "pr");
      }),
    ),
  );

  it.effect("a new attempt supersedes the active one only when it reaches working", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, attemptId: earlier } = yield* working();
        yield* test.moveByHand(1, "ready");
        const restart = yield* test.startAttempt(1, "restart");
        assert.deepStrictEqual(
          (yield* test.attemptsOf(1)).map((attempt) => [attempt.id, attempt.active]),
          [
            [earlier, true],
            [restart.attempt.id, false],
          ],
        );

        yield* test.threadRunning(restart.threadId);
        yield* reactor.emit("run.updated", restart.threadId);
        assert.deepStrictEqual(
          (yield* test.attemptsOf(1)).map((attempt) => [
            attempt.id,
            attempt.status,
            attempt.active,
            attempt.endedReason,
          ]),
          [
            [restart.attempt.id, "working", true, null],
            [earlier, "ended", false, "superseded"],
          ],
        );
        assert.strictEqual(test.remoteColumn(1), "progress");
      }),
    ),
  );

  it.effect("deleting the thread ends its attempt", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* working();
        yield* test.deleteThread(threadId);
        yield* reactor.emit("thread.deleted", threadId);

        const attempt = yield* attemptOf(test, attemptId);
        assert.deepStrictEqual(
          [attempt.status, attempt.active, attempt.endedReason],
          ["ended", false, "thread-deleted"],
        );
        assert.strictEqual(test.remoteColumn(1), "progress");
      }),
    ),
  );

  it.effect("a disconnected board keeps its attempts and the sweep catches up on reconnect", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* working();
        yield* test.service.disconnectBoard({ requestId: "disconnect", boardId: BOARD_ID });
        yield* test.linkPullRequest(threadId, 7, "open");
        yield* reactor.emit("thread.pull-request-link-updated", threadId);
        assert.strictEqual(test.remoteColumn(1), "progress");

        yield* test.configureBoard({}, "reconnect");
        const kept = yield* attemptOf(test, attemptId);
        assert.deepStrictEqual([kept.status, kept.active], ["working", true]);

        yield* reactor.minuteSweep;
        assert.strictEqual(test.remoteColumn(1), "pr");
        assert.strictEqual((yield* attemptOf(test, attemptId)).status, "in-pr");
      }),
    ),
  );

  it.effect("the startup sweep recovers a transition that happened while nothing listened", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* makeIssueHarness();
        yield* test.configureBoard();
        const { threadId, attempt } = yield* test.startAttempt(1);
        yield* test.threadRunning(threadId);
        yield* test.linkPullRequest(threadId, 7, "open");
        assert.deepStrictEqual(test.writes, []);

        yield* (yield* makeReactor(test)).start;
        assert.deepStrictEqual(test.writes, [{ ticket: 1, columnId: "pr" }]);
        assert.strictEqual((yield* attemptOf(test, attempt.id)).status, "in-pr");
      }),
    ),
  );

  it.effect("the minute sweep picks up a transition without an event", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, reactor, threadId, attemptId } = yield* launched();
        yield* test.threadRunning(threadId);
        assert.deepStrictEqual(test.writes, []);

        yield* reactor.minuteSweep;
        assert.deepStrictEqual(test.writes, [{ ticket: 1, columnId: "progress" }]);
        assert.strictEqual((yield* attemptOf(test, attemptId)).status, "working");
      }),
    ),
  );
});
