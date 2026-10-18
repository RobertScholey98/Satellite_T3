import { assert, describe, it } from "@effect/vitest";
import type { IssueBoardSyncEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  authenticationFailure,
  BOARD_ID,
  EPOCH,
  issueRef,
  makeIssueHarness,
  PROJECT_ID,
  remoteFailure,
  withDatabase,
  type IssueHarness,
} from "./IssueService.test.helpers.ts";

const AFTER_31S = "1970-01-01T00:00:31.000Z";

const sync = (revision: number, syncedAt: string, syncing = false) => ({
  revision,
  syncedAt,
  syncing,
  failure: null,
});

/** Collects `count` sync events, returning once the subscription has delivered its first one. */
const collectSyncEvents = Effect.fn("collectSyncEvents")(function* (
  test: IssueHarness,
  count: number,
) {
  const events: IssueBoardSyncEvent[] = [];
  const subscribed = yield* Deferred.make<void>();
  const fiber = yield* test.service
    .subscribeBoard({ projectId: PROJECT_ID, boardId: BOARD_ID })
    .pipe(
      Stream.take(count),
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(Deferred.succeed(subscribed, undefined)),
        ),
      ),
      Effect.forkChild,
    );
  yield* Deferred.await(subscribed);
  return { events, done: Fiber.join(fiber) };
});

const configured = Effect.gen(function* () {
  const test = yield* makeIssueHarness();
  yield* test.configureBoard();
  return test;
});

describe("IssueService stored copy", () => {
  it.effect("opens a configured board from its stored copy, even after a restart", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        assert.strictEqual(test.calls.reads, 1);

        const view = yield* test.openBoard();
        assert.deepStrictEqual(view.sync, sync(1, EPOCH));
        assert.strictEqual(view.board.title, "Acme roadmap");
        assert.deepStrictEqual(
          view.items.map((item) => [item.issue.ref.number, item.columnId]),
          [
            [1, "ready"],
            [2, "ready"],
            [3, "ready"],
          ],
        );

        const restarted = yield* test.restart;
        const reopened = yield* restarted.openBoard({ projectId: PROJECT_ID, boardId: BOARD_ID });
        assert.deepStrictEqual(reopened.sync, sync(1, EPOCH));
        assert.strictEqual(reopened.items.length, 3);
        assert.strictEqual(test.calls.reads, 1);
      }),
    ),
  );

  it.effect("serves the stored copy while one background refresh reads an aged board", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* TestClock.adjust("31 seconds");
        yield* test.moveByHand(1, "progress");
        const held = yield* test.holdNextRead;

        const views = yield* Effect.forEach([1, 2, 3, 4, 5], () => test.openBoard());
        for (const view of views) {
          assert.deepStrictEqual(view.sync, sync(1, EPOCH, true));
          assert.strictEqual(view.items[0]?.columnId, "ready");
        }

        yield* Deferred.succeed(held.release, undefined);
        yield* test.service.drainRefreshes;
        const refreshed = yield* test.openBoard();
        assert.deepStrictEqual(refreshed.sync, sync(2, AFTER_31S));
        assert.strictEqual(refreshed.items[0]?.columnId, "progress");
        assert.strictEqual(test.calls.reads, 2);
      }),
    ),
  );

  it.effect("keeps the revision when a refresh finds the board unchanged", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* TestClock.adjust("31 seconds");
        yield* test.openBoard();
        yield* test.service.drainRefreshes;

        assert.deepStrictEqual((yield* test.openBoard()).sync, sync(1, AFTER_31S));
        assert.strictEqual(test.calls.reads, 2);
      }),
    ),
  );

  it.effect("a refresh that read the board before a move never undoes the move", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* TestClock.adjust("31 seconds");
        const held = yield* test.holdNextRead;
        yield* test.openBoard();
        yield* Deferred.await(held.started);

        const move = yield* test.service.move({
          requestId: "move-during-refresh",
          boardId: BOARD_ID,
          issue: issueRef(1),
          columnId: "progress",
          expectedPlacement: "ready",
        });
        assert.strictEqual(move.status, "applied");

        yield* Deferred.succeed(held.release, undefined);
        yield* test.service.drainRefreshes;
        assert.strictEqual(yield* test.storedColumn(1), "progress");
        assert.strictEqual(test.remoteColumn(1), "progress");
      }),
    ),
  );

  it.effect("a failed refresh keeps the stored board and records the failure", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* TestClock.adjust("31 seconds");
        yield* test.fail("read", remoteFailure("Board unavailable"));
        yield* test.openBoard();
        yield* test.service.drainRefreshes;

        const failed = yield* test.openBoard();
        assert.deepStrictEqual(failed.sync, {
          revision: 1,
          syncedAt: EPOCH,
          syncing: false,
          failure: { at: AFTER_31S, message: "Board unavailable" },
        });
        assert.strictEqual(failed.items.length, 3);

        yield* test.fail("read", null);
        yield* test.openBoard(true);
        yield* test.service.drainRefreshes;
        assert.deepStrictEqual((yield* test.openBoard()).sync, sync(1, AFTER_31S));
        assert.strictEqual(test.calls.reads, 3);
      }),
    ),
  );

  it.effect("a subscription follows the stored revision through a refresh and a move", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const subscription = yield* collectSyncEvents(test, 5);
        yield* TestClock.adjust("31 seconds");
        yield* test.openBoard();
        yield* test.service.drainRefreshes;
        yield* test.service.move({
          requestId: "move-while-subscribed",
          boardId: BOARD_ID,
          issue: issueRef(1),
          columnId: "progress",
        });
        yield* subscription.done;

        assert.deepStrictEqual(
          subscription.events.map((event) => event.sync),
          [
            sync(1, EPOCH),
            sync(1, EPOCH, true),
            sync(1, AFTER_31S),
            sync(2, AFTER_31S),
            sync(3, AFTER_31S),
          ],
        );
      }),
    ),
  );

  it.effect("disconnecting publishes a null sync and leaves nothing stored", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const subscription = yield* collectSyncEvents(test, 2);
        yield* test.service.disconnectBoard({ requestId: "disconnect", boardId: BOARD_ID });
        yield* subscription.done;

        assert.deepStrictEqual(subscription.events, [
          { boardId: BOARD_ID, sync: sync(1, EPOCH) },
          { boardId: BOARD_ID, sync: null },
        ]);
        const reopened = yield* test.openBoard().pipe(Effect.flip);
        assert.strictEqual(reopened.reason, "not-found");
      }),
    ),
  );

  it.effect(
    "the five-minute sweep refreshes boards with a live subscriber or an active attempt",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const test = yield* configured;
          const sweepAfterSixMinutes = Effect.gen(function* () {
            yield* TestClock.adjust("6 minutes");
            yield* test.service.refreshStaleBoards;
            yield* test.service.drainRefreshes;
          });

          yield* sweepAfterSixMinutes;
          assert.strictEqual(test.calls.reads, 1, "an idle board is left alone");

          const subscription = yield* collectSyncEvents(test, 3);
          yield* sweepAfterSixMinutes;
          yield* subscription.done;
          assert.strictEqual(test.calls.reads, 2, "a watched board is refreshed");

          const { threadId } = yield* test.startAttempt(1);
          yield* test.threadRunning(threadId);
          yield* test.service.reconcileThread(threadId);
          yield* sweepAfterSixMinutes;
          assert.strictEqual(test.calls.reads, 3, "a worked board is refreshed");
        }),
      ),
  );

  it.effect("keeps a 300-ticket board view under 160 KB", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* makeIssueHarness({ tickets: 300 });
        const view = yield* test.configureBoard();
        assert.strictEqual(view.items.length, 300);
        assert.isBelow(JSON.stringify(view).length, 160 * 1024);
      }),
    ),
  );
});

describe("IssueService manual moves", () => {
  it.effect("writes a move and stores the placement the host confirmed", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const move = yield* test.service.move({
          requestId: "move",
          boardId: BOARD_ID,
          issue: issueRef(1),
          columnId: "progress",
          expectedPlacement: "ready",
        });

        assert.strictEqual(move.status, "applied");
        assert.strictEqual(move.origin, "manual");
        assert.deepStrictEqual(test.writes, [{ ticket: 1, columnId: "progress" }]);
        assert.strictEqual(yield* test.storedColumn(1), "progress");
      }),
    ),
  );

  it.effect("refuses a move when the ticket moved elsewhere since the board was read", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* test.moveByHand(1, "blocked");
        const refused = yield* test.service
          .move({
            requestId: "move",
            boardId: BOARD_ID,
            issue: issueRef(1),
            columnId: "progress",
            expectedPlacement: "ready",
          })
          .pipe(Effect.flip);

        assert.strictEqual(refused.reason, "conflict");
        assert.strictEqual(
          refused.message,
          "This ticket moved on another device. Refresh before moving it again.",
        );
        assert.deepStrictEqual(test.writes, []);
        assert.strictEqual(yield* test.storedColumn(1), "blocked");
      }),
    ),
  );

  it.effect(
    "keeps a move pending through a transient failure and applies it after the retry time",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const test = yield* configured;
          yield* test.fail("move", remoteFailure());
          const move = yield* test.service.move({
            requestId: "move",
            boardId: BOARD_ID,
            issue: issueRef(1),
            columnId: "progress",
          });
          assert.strictEqual(move.status, "pending");
          assert.strictEqual(move.error, "The repository host did not answer.");

          yield* test.fail("move", null);
          yield* test.service.sweep;
          assert.strictEqual((yield* test.latestMove(1))?.status, "pending");
          assert.deepStrictEqual(test.writes, []);

          yield* TestClock.adjust("1 minute");
          yield* test.service.sweep;
          assert.strictEqual((yield* test.latestMove(1))?.status, "applied");
          assert.deepStrictEqual(test.writes, [{ ticket: 1, columnId: "progress" }]);
        }),
      ),
  );

  it.effect("fails a move on a lasting failure and Retry applies it", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* test.fail("move", authenticationFailure());
        const failed = yield* test.service.move({
          requestId: "move",
          boardId: BOARD_ID,
          issue: issueRef(1),
          columnId: "progress",
        });
        assert.strictEqual(failed.status, "failed");
        assert.strictEqual(failed.error, "The GitHub token has expired.");

        yield* test.fail("move", null);
        const retried = yield* test.service.retryMove({ requestId: "retry", moveId: failed.id });
        assert.strictEqual(retried.id, failed.id);
        assert.strictEqual(retried.status, "applied");
        assert.strictEqual(test.remoteColumn(1), "progress");
      }),
    ),
  );

  it.effect("replays a repeated request id and refuses one reused for a different move", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const input = {
          requestId: "move",
          boardId: BOARD_ID,
          issue: issueRef(1),
          columnId: "progress",
        };
        const first = yield* test.service.move(input);
        const again = yield* test.service.move(input);
        assert.deepStrictEqual(again, first);
        assert.deepStrictEqual(test.writes, [{ ticket: 1, columnId: "progress" }]);

        const reused = yield* test.service.move({ ...input, columnId: "done" }).pipe(Effect.flip);
        assert.strictEqual(reused.reason, "conflict");
        assert.strictEqual(
          reused.message,
          "This request ID was already used for a different issue operation.",
        );
        assert.strictEqual(test.remoteColumn(1), "progress");
      }),
    ),
  );
});

describe("IssueService Start", () => {
  it.effect("refuses Start unless the remote board shows the ticket in a Ready column", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* test.moveByHand(1, "progress");
        const refused = yield* test.startAttempt(1).pipe(Effect.flip);

        assert.strictEqual(refused.reason, "conflict");
        assert.deepStrictEqual(test.launches, []);
        assert.deepStrictEqual(yield* test.attemptsOf(1), []);
      }),
    ),
  );

  it.effect("launches one worktree thread with the prompt and the attached ticket", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const started = yield* test.startAttempt(1, "start-request");

        assert.strictEqual(started.threadId, "thread-1");
        assert.strictEqual(started.attempt.status, "launching");
        assert.strictEqual(started.attempt.active, false);
        assert.deepStrictEqual(
          test.launches.map(({ commandId, threadId, title, text, branch, baseRef }) => ({
            commandId,
            threadId,
            title,
            text,
            branch,
            baseRef,
          })),
          [
            {
              commandId: "issue-attempt:start-request",
              threadId: "thread-1",
              title: "#1 Ticket 1: make the board load faster on large projects",
              text: "Fix this ticket.\n\n<attached_issue>\nRepository host: github.com\nIssue: #1 Ticket 1: make the board load faster on large projects\nURL: https://github.com/acme/app/issues/1\n\nSteps to reproduce ticket 1.\n</attached_issue>",
              branch: "issue-1",
              baseRef: "main",
            },
          ],
        );
        assert.deepStrictEqual(test.writes, []);
      }),
    ),
  );

  it.effect("pressing Start twice with one request id gives one attempt on one thread", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const first = yield* test.startAttempt(1, "start-request");
        const second = yield* test.startAttempt(1, "start-request");

        assert.strictEqual(second.threadId, first.threadId);
        assert.strictEqual(second.attempt.id, first.attempt.id);
        assert.strictEqual((yield* test.attemptsOf(1)).length, 1);
        // Upstream's launch is idempotent on the command id, so a repeat launches nothing new.
        assert.deepStrictEqual(
          test.launches.map((launch) => [launch.commandId, launch.threadId]),
          [
            ["issue-attempt:start-request", "thread-1"],
            ["issue-attempt:start-request", "thread-1"],
          ],
        );
      }),
    ),
  );

  it.effect("a failed launch marks the attempt failed and leaves the ticket alone", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* test.fail("launch", remoteFailure("The thread could not be launched."));
        const failure = yield* test.startAttempt(1).pipe(Effect.flip);

        assert.strictEqual(failure.message, "The thread could not be launched.");
        assert.deepStrictEqual(
          (yield* test.attemptsOf(1)).map((attempt) => [attempt.status, attempt.active]),
          [["failed", false]],
        );
        assert.strictEqual(test.remoteColumn(1), "ready");
        assert.deepStrictEqual(test.writes, []);
      }),
    ),
  );

  it.effect("a failed ticket read fails the attempt instead of leaving it launching", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* test.fail("get", remoteFailure("GitHub did not answer the issue read."));
        const failure = yield* test.startAttempt(1).pipe(Effect.flip);

        assert.strictEqual(failure.message, "GitHub did not answer the issue read.");
        assert.deepStrictEqual(
          (yield* test.attemptsOf(1)).map((attempt) => [attempt.status, attempt.active]),
          [["failed", false]],
        );
        assert.deepStrictEqual(test.launches, []);
        assert.strictEqual(test.remoteColumn(1), "ready");
      }),
    ),
  );
});

describe("IssueService after a hand move, a disconnect, a merge or a failed run", () => {
  it.effect("drops a retried manual move once the ticket was moved by hand on the host", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* test.fail("move", remoteFailure());
        const pending = yield* test.service.move({
          requestId: "drag",
          boardId: BOARD_ID,
          issue: issueRef(1),
          columnId: "progress",
          expectedPlacement: "ready",
        });
        assert.strictEqual(pending.status, "pending");
        yield* test.fail("move", null);
        yield* test.moveByHand(1, "blocked");
        yield* TestClock.adjust("1 minute");
        yield* test.service.sweep;

        assert.deepStrictEqual(
          {
            remote: test.remoteColumn(1),
            writes: test.writes,
            stored: yield* test.storedColumn(1),
          },
          { remote: "blocked", writes: [], stored: "blocked" },
        );
        const move = yield* test.latestMove(1);
        assert.deepStrictEqual(
          [move?.status, move?.error],
          ["skipped", "Moved by hand to Blocked before this move reached the board."],
        );
      }),
    ),
  );

  it.effect("applies a retried manual move whose ticket is still where the person saw it", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* test.fail("move", remoteFailure());
        yield* test.service.move({
          requestId: "drag",
          boardId: BOARD_ID,
          issue: issueRef(1),
          columnId: "progress",
          expectedPlacement: "ready",
        });
        yield* test.fail("move", null);
        yield* TestClock.adjust("1 minute");
        yield* test.service.sweep;

        assert.deepStrictEqual(test.writes, [{ ticket: 1, columnId: "progress" }]);
        assert.strictEqual((yield* test.latestMove(1))?.status, "applied");
      }),
    ),
  );

  it.effect("queues the attempt's move again after a disconnect superseded it", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const { threadId } = yield* test.startAttempt(1);
        yield* test.fail("move", remoteFailure());
        yield* test.threadRunning(threadId);
        yield* test.service.reconcileThread(threadId);
        assert.strictEqual((yield* test.latestMove(1))?.status, "pending");
        yield* test.fail("move", null);
        yield* test.service.disconnectBoard({ requestId: "disconnect", boardId: BOARD_ID });
        // Reconnecting applies the due move itself, without waiting for the minute sweep.
        yield* test.configureBoard({}, "reconnect");

        const [attempt] = yield* test.attemptsOf(1);
        assert.deepStrictEqual(
          {
            remote: test.remoteColumn(1),
            status: attempt?.status,
            active: attempt?.active,
            automaticMoves: attempt?.automaticMoves,
          },
          { remote: "progress", status: "working", active: true, automaticMoves: "on" },
        );
      }),
    ),
  );

  it.effect("ends a merged attempt, so unlinking its pull request leaves the ticket in Done", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const { threadId } = yield* test.startAttempt(1);
        yield* test.threadRunning(threadId);
        yield* test.service.reconcileThread(threadId);
        yield* test.linkPullRequest(threadId, 7, "open");
        yield* test.service.reconcileThread(threadId);
        yield* test.setPullRequest(threadId, 7, "merged");
        yield* test.service.reconcileThread(threadId);
        assert.strictEqual(test.remoteColumn(1), "done");
        const [merged] = yield* test.attemptsOf(1);
        assert.deepStrictEqual(
          [merged?.status, merged?.active, merged?.endedReason],
          ["merged", false, "completed"],
        );

        yield* test.unlinkPullRequest(threadId, 7);
        yield* test.service.reconcileThread(threadId);
        assert.strictEqual(test.remoteColumn(1), "done");
      }),
    ),
  );

  it.effect(
    "resumes an attempt whose first run failed, and its pull request then moves the ticket",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const test = yield* configured;
          const { threadId, attempt } = yield* test.startAttempt(1);
          yield* test.firstRunFailed(threadId);
          yield* test.service.reconcileThread(threadId);
          assert.deepStrictEqual(
            (yield* test.attemptsOf(1)).map((entry) => [entry.status, entry.endedReason]),
            [["failed", null]],
          );

          const resumed = yield* test.service.resumeAttempt({
            requestId: "resume",
            attemptId: attempt.id,
          });
          assert.deepStrictEqual([resumed.status, resumed.active], ["working", true]);
          yield* test.linkPullRequest(threadId, 7, "open");
          yield* test.service.reconcileThread(threadId);
          assert.strictEqual(test.remoteColumn(1), "pr");
        }),
      ),
  );

  it.effect("keeps an attempt whose launch failed failed, with New attempt the way on", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* test.fail("launch", remoteFailure("The thread could not be launched."));
        yield* test.startAttempt(1).pipe(Effect.flip);
        const [failed] = yield* test.attemptsOf(1);
        assert.strictEqual(failed?.endedReason, "launch-failed");

        const refused = yield* test.service
          .resumeAttempt({ requestId: "resume", attemptId: failed!.id })
          .pipe(Effect.flip);
        assert.strictEqual(refused.message, "Only an attempt you stopped can be resumed.");
      }),
    ),
  );
});

describe("IssueService after the merge and on retried moves", () => {
  const mergedWithDoneMoveFailing = (failure: ReturnType<typeof remoteFailure>) =>
    Effect.gen(function* () {
      const test = yield* configured;
      const { threadId, attempt } = yield* test.startAttempt(1);
      yield* test.threadRunning(threadId);
      yield* test.service.reconcileThread(threadId);
      yield* test.linkPullRequest(threadId, 7, "open");
      yield* test.service.reconcileThread(threadId);
      yield* test.fail("move", failure);
      yield* test.setPullRequest(threadId, 7, "merged");
      yield* test.service.reconcileThread(threadId);
      yield* test.fail("move", null);
      return { test, threadId, attemptId: attempt.id };
    });

  it.effect("Retry on a failed Done move applies it after the attempt merged", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test, threadId } = yield* mergedWithDoneMoveFailing(
          authenticationFailure("Azure DevOps refused the change: TF401320."),
        );
        const failed = yield* test.latestMove(1);
        assert.deepStrictEqual([failed?.status, test.remoteColumn(1)], ["failed", "pr"]);

        const retried = yield* test.service.retryMove({ requestId: "retry", moveId: failed!.id });
        assert.deepStrictEqual([retried.status, test.remoteColumn(1)], ["applied", "done"]);
        yield* test.service.reconcileThread(threadId);
        const [attempt] = yield* test.attemptsOf(1);
        assert.deepStrictEqual([attempt?.active, attempt?.endedReason], [false, "completed"]);
      }),
    ),
  );

  it.effect("a Done move a disconnect superseded is queued again on reconnect", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test } = yield* mergedWithDoneMoveFailing(remoteFailure());
        assert.strictEqual((yield* test.latestMove(1))?.status, "pending");
        yield* test.service.disconnectBoard({ requestId: "disconnect", boardId: BOARD_ID });
        yield* test.service.sweep;
        yield* test.configureBoard({}, "reconnect");

        const [attempt] = yield* test.attemptsOf(1);
        assert.deepStrictEqual(
          [test.remoteColumn(1), attempt?.status, attempt?.active, attempt?.endedReason],
          ["done", "merged", false, "completed"],
        );
      }),
    ),
  );

  it.effect("completes a merged attempt whose Done move a manual move to Done superseded", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test } = yield* mergedWithDoneMoveFailing(remoteFailure());
        yield* test.service.move({
          requestId: "drag-done",
          boardId: BOARD_ID,
          issue: issueRef(1),
          columnId: "done",
          expectedPlacement: "pr",
        });
        yield* test.service.sweep;

        const [attempt] = yield* test.attemptsOf(1);
        assert.deepStrictEqual(
          [test.remoteColumn(1), attempt?.active, attempt?.endedReason],
          ["done", false, "completed"],
        );
      }),
    ),
  );

  it.effect("completes a merged attempt whose failed Done move is no longer wanted", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test } = yield* mergedWithDoneMoveFailing(authenticationFailure());
        assert.strictEqual((yield* test.latestMove(1))?.status, "failed");
        yield* test.configureBoard({ moveOnMerge: false }, "stop-moving-on-merge");
        yield* test.service.sweep;

        const [attempt] = yield* test.attemptsOf(1);
        assert.deepStrictEqual(
          [test.remoteColumn(1), attempt?.active, attempt?.endedReason],
          ["pr", false, "completed"],
        );
      }),
    ),
  );

  it.effect("completes a merged attempt reconnected with moving on merge off", () =>
    withDatabase(
      Effect.gen(function* () {
        const { test } = yield* mergedWithDoneMoveFailing(remoteFailure());
        yield* test.service.disconnectBoard({ requestId: "disconnect", boardId: BOARD_ID });
        yield* test.configureBoard({ moveOnMerge: false }, "reconnect");

        const [attempt] = yield* test.attemptsOf(1);
        assert.deepStrictEqual(
          [test.remoteColumn(1), attempt?.active, attempt?.endedReason],
          ["pr", false, "completed"],
        );
      }),
    ),
  );

  it.effect("a failed Retry of an active attempt's move leaves its later moves automatic", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const { threadId } = yield* test.startAttempt(1);
        yield* test.threadRunning(threadId);
        yield* test.service.reconcileThread(threadId);
        yield* test.fail("move", authenticationFailure());
        yield* test.linkPullRequest(threadId, 7, "open");
        yield* test.service.reconcileThread(threadId);
        const failed = yield* test.latestMove(1);
        yield* test.service.retryMove({ requestId: "retry-early", moveId: failed!.id });
        assert.strictEqual((yield* test.latestMove(1))?.status, "failed");

        yield* test.fail("move", null);
        yield* test.setPullRequest(threadId, 7, "merged");
        yield* test.service.reconcileThread(threadId);
        assert.strictEqual(test.remoteColumn(1), "done");
      }),
    ),
  );

  it.effect("Retry applies a failed move after its attempt was stopped", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const { threadId, attempt } = yield* test.startAttempt(1);
        yield* test.threadRunning(threadId);
        yield* test.service.reconcileThread(threadId);
        yield* test.fail("move", authenticationFailure());
        yield* test.linkPullRequest(threadId, 7, "open");
        yield* test.service.reconcileThread(threadId);
        const failed = yield* test.latestMove(1);
        yield* test.service.endAttempt({ requestId: "stop", attemptId: attempt.id });
        yield* test.fail("move", null);

        const retried = yield* test.service.retryMove({ requestId: "retry", moveId: failed!.id });
        assert.deepStrictEqual(
          [retried.origin, retried.status, test.remoteColumn(1)],
          ["manual", "applied", "pr"],
        );
      }),
    ),
  );

  it.effect("settles a retried manual move as applied when its first write already landed", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* test.fail("move", remoteFailure());
        yield* test.service.move({
          requestId: "drag",
          boardId: BOARD_ID,
          issue: issueRef(1),
          columnId: "progress",
          expectedPlacement: "ready",
        });
        yield* test.fail("move", null);
        // The host applied the first write after all.
        yield* test.moveByHand(1, "progress");
        yield* TestClock.adjust("1 minute");
        yield* test.service.sweep;

        const move = yield* test.latestMove(1);
        assert.deepStrictEqual([move?.status, move?.error, test.writes], ["applied", null, []]);
      }),
    ),
  );
});

describe("IssueService moves the host cannot read", () => {
  const drag = (test: IssueHarness) =>
    test.service.move({
      requestId: "drag",
      boardId: BOARD_ID,
      issue: issueRef(1),
      columnId: "progress",
      expectedPlacement: "ready",
    });

  it.effect(
    "records a drag refused for access as failed, and Retry applies it once access is back",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const test = yield* configured;
          const refused =
            "GitHub refused the credential for github.com. Update the token in Settings, Source control, or run `gh auth login --hostname github.com`, then Retry.";
          yield* test.fail("readItem", authenticationFailure(refused));
          const move = yield* drag(test);
          assert.deepStrictEqual([move.status, move.error, test.writes], ["failed", refused, []]);
          assert.deepStrictEqual(
            (yield* test.openBoard()).moves.map((entry) => [entry.status, entry.columnId]),
            [["failed", "progress"]],
          );

          yield* test.fail("readItem", null);
          const retried = yield* test.service.retryMove({ requestId: "retry", moveId: move.id });
          assert.deepStrictEqual([retried.status, test.remoteColumn(1)], ["applied", "progress"]);
        }),
      ),
  );

  it.effect("records a drag the host could not answer as retrying, and the sweep applies it", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* test.fail("readItem", remoteFailure("GitHub did not answer."));
        const move = yield* drag(test);
        assert.deepStrictEqual([move.status, move.error], ["pending", "GitHub did not answer."]);

        yield* test.fail("readItem", null);
        yield* TestClock.adjust("1 minute");
        yield* test.service.sweep;
        assert.deepStrictEqual(
          [(yield* test.latestMove(1))?.status, test.remoteColumn(1)],
          ["applied", "progress"],
        );
      }),
    ),
  );
});

describe("IssueService Start replays and restarts", () => {
  it.effect("repeating a start whose launch failed returns the failure", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        yield* test.fail("launch", remoteFailure("The thread could not be launched."));
        yield* test.startAttempt(1).pipe(Effect.flip);
        yield* test.fail("launch", null);
        const repeated = yield* test.startAttempt(1).pipe(Effect.flip);

        assert.deepStrictEqual(
          [repeated.reason, repeated.message],
          ["remote", "The thread could not be launched."],
        );
        assert.strictEqual(test.launches.length, 1);
      }),
    ),
  );

  it.effect("relaunches an attempt the server stopped before its thread existed", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const { threadId } = yield* test.startAttempt(1);
        yield* test.loseLaunch(threadId);
        yield* test.service.resumeLaunches;

        assert.deepStrictEqual(
          test.launches.map((launch) => [launch.commandId, launch.threadId]),
          [
            ["issue-attempt:start-1", threadId],
            ["issue-attempt:start-1", threadId],
          ],
        );
        assert.deepStrictEqual(
          (yield* test.attemptsOf(1)).map((attempt) => attempt.status),
          ["launching"],
        );
      }),
    ),
  );

  it.effect("fails a relaunch that fails", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const { threadId } = yield* test.startAttempt(1);
        yield* test.loseLaunch(threadId);
        yield* test.fail("launch", remoteFailure("The thread could not be launched."));
        yield* test.service.resumeLaunches;

        assert.deepStrictEqual(
          (yield* test.attemptsOf(1)).map((attempt) => [attempt.status, attempt.endedReason]),
          [["failed", "launch-failed"]],
        );
      }),
    ),
  );

  it.effect("a board view carries active attempts and each ticket's latest attempt only", () =>
    withDatabase(
      Effect.gen(function* () {
        const test = yield* configured;
        const first = yield* test.startAttempt(1, "first");
        yield* test.service.endAttempt({ requestId: "stop", attemptId: first.attempt.id });
        const second = yield* test.startAttempt(1, "second");
        yield* test.service.endAttempt({ requestId: "stop-2", attemptId: second.attempt.id });
        const third = yield* test.startAttempt(1, "third");

        const view = yield* test.openBoard();
        assert.deepStrictEqual(
          view.attempts.map((attempt) => attempt.id),
          [third.attempt.id],
        );
        assert.strictEqual((yield* test.attemptsOf(1)).length, 3);
      }),
    ),
  );
});
