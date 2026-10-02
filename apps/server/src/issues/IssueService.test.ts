import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  IssueOperationError,
  type IssueRef,
  type IssueBoardLocator,
  type IssueBoardSyncEvent,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import migration from "../persistence/Migrations/056_IssueBoards.ts";
import snapshotMigration from "../persistence/Migrations/059_IssueBoardSnapshots.ts";
import { makeIssueService } from "./IssueService.ts";
import { canonicalIssueKey, type IssueHostShape } from "./IssueHost.ts";

const environmentId = EnvironmentId.make("issue-test-source");
const destination = EnvironmentId.make("issue-test-destination");
const projectId = ProjectId.make("issue-test-project");
const threadId = ThreadId.make("issue-test-thread");
const issue: IssueRef = {
  hostKind: "github",
  host: "github.com",
  repository: "owner/repo",
  id: "42",
  number: 42,
  url: "https://github.com/owner/repo/issues/42",
};
const locator: IssueBoardLocator = {
  kind: "github-project",
  host: "github.com",
  owner: "owner",
  ownerKind: "user",
  projectNumber: 1,
  projectNodeId: "P1",
  statusFieldId: "F1",
};
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Issues",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  repositoryIdentity: {
    canonicalKey: "github.com/owner/repo",
    provider: "github",
    displayName: "owner/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/owner/repo.git",
    },
  },
  scripts: [],
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
};
const setup = Effect.gen(function* () {
  yield* migration;
  yield* snapshotMigration;
  let column = "ready";
  let fail = false;
  let failReads = false;
  let reads = 0;
  let gate: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | null = null;
  const writes: string[] = [];
  const host: IssueHostShape = {
    list: () => Effect.succeed({ issues: [], nextCursor: null }),
    get: () =>
      Effect.succeed({
        ref: issue,
        title: "Issue",
        body: "Details",
        state: "open",
        labels: [],
        updatedAt: "now",
      }),
    listBoards: () => Effect.succeed([{ title: "Board", locator }]),
    board: () =>
      Effect.gen(function* () {
        reads++;
        if (failReads)
          return yield* new IssueOperationError({ reason: "remote", message: "Board unavailable" });
        const remote = {
          title: "Board",
          locator,
          columns: ["ready", "ready-next", "progress", "pr", "done"].map((id) => ({
            id,
            title: id,
          })),
          items: [
            {
              issue: { ref: issue, title: "Issue", state: "open", labels: [], updatedAt: "now" },
              itemId: "I1",
              columnId: column,
              version: "1",
            },
          ],
        };
        const held = gate;
        gate = null;
        if (held) {
          yield* Deferred.succeed(held.started, undefined);
          yield* Deferred.await(held.release);
        }
        return remote;
      }),
    move: (_cwd, _locator, _item, next) =>
      fail
        ? Effect.fail(new IssueOperationError({ reason: "remote", message: "Host unavailable" }))
        : Effect.sync(() => {
            writes.push(next);
            column = next;
          }),
  };
  const options = { host, environmentId, getProject: () => Effect.succeed(project) };
  const service = yield* makeIssueService(options);
  const view = yield* service.configureBoard({
    requestId: "configure",
    projectId,
    locator,
    mapping: {
      ready: "ready",
      inProgress: "progress",
      inPullRequest: "pr",
      completed: "done",
      moveOnMerge: true,
    },
  });
  const reserve = (requestId: string, target = environmentId) =>
    service.reserveAttempt({
      requestId,
      boardId: view.board.id,
      issue,
      sourceEnvironmentId: environmentId,
      destinationEnvironmentId: target,
    });
  return {
    service,
    options,
    boardId: view.board.id,
    reserve,
    writes,
    reads: () => reads,
    column: () => column,
    setColumn: (next: string) => {
      column = next;
    },
    fail: (value: boolean) => {
      fail = value;
    },
    failReads: (value: boolean) => {
      failReads = value;
    },
    /** Holds the next host read after it captured the board, until `release`. */
    hold: Effect.gen(function* () {
      const held = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      gate = held;
      return held;
    }),
  };
});
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const epoch = "1970-01-01T00:00:00.000Z";

describe("IssueService", () => {
  it.effect("opens a configured board from its stored copy, even after a restart", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        assert.strictEqual(test.reads(), 1);
        const fresh = { revision: 1, syncedAt: epoch, syncing: false, failure: null };
        const view = yield* test.service.openBoard({ projectId, boardId: test.boardId });
        assert.deepStrictEqual(view.sync, fresh);
        assert.strictEqual(view.board.title, "Board");
        assert.deepStrictEqual(view.items.map((item) => item.columnId), ["ready"]);
        assert.deepStrictEqual((yield* test.service.openBoard({ projectId, locator })).sync, fresh);
        const restarted = yield* makeIssueService(test.options);
        assert.deepStrictEqual(
          (yield* restarted.openBoard({ projectId, boardId: test.boardId })).sync,
          fresh,
        );
        assert.strictEqual(test.reads(), 1);
      }),
    ),
  );
  it.effect("serves the stored copy while one background refresh reads an aged board", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* TestClock.adjust("31 seconds");
        test.setColumn("ready-next");
        const held = yield* test.hold;
        const views = yield* Effect.forEach([1, 2, 3, 4, 5], () =>
          test.service.openBoard({ projectId, boardId: test.boardId }),
        );
        for (const view of views) {
          assert.deepStrictEqual(view.sync, {
            revision: 1,
            syncedAt: epoch,
            syncing: true,
            failure: null,
          });
          assert.deepStrictEqual(view.items.map((item) => item.columnId), ["ready"]);
        }
        yield* Deferred.succeed(held.release, undefined);
        yield* test.service.drainRefreshes;
        const refreshed = yield* test.service.openBoard({ projectId, boardId: test.boardId });
        assert.deepStrictEqual(refreshed.sync, {
          revision: 2,
          syncedAt: "1970-01-01T00:00:31.000Z",
          syncing: false,
          failure: null,
        });
        assert.deepStrictEqual(refreshed.items.map((item) => item.columnId), ["ready-next"]);
        assert.strictEqual(test.reads(), 2);
      }),
    ),
  );
  it.effect("keeps the revision when a refresh finds the board unchanged", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* TestClock.adjust("31 seconds");
        yield* test.service.openBoard({ projectId, boardId: test.boardId });
        yield* test.service.drainRefreshes;
        assert.deepStrictEqual(
          (yield* test.service.openBoard({ projectId, boardId: test.boardId })).sync,
          { revision: 1, syncedAt: "1970-01-01T00:00:31.000Z", syncing: false, failure: null },
        );
        assert.strictEqual(test.reads(), 2);
      }),
    ),
  );
  it.effect("a refresh that read the board before a move never undoes the move", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* TestClock.adjust("31 seconds");
        const held = yield* test.hold;
        yield* test.service.openBoard({ projectId, boardId: test.boardId });
        yield* Deferred.await(held.started);
        const receipt = yield* test.service.move({
          requestId: "move-during-refresh",
          boardId: test.boardId,
          issue,
          columnId: "progress",
        });
        assert.strictEqual(receipt.status, "applied");
        yield* Deferred.succeed(held.release, undefined);
        yield* test.service.drainRefreshes;
        const view = yield* test.service.openBoard({ projectId, boardId: test.boardId });
        assert.deepStrictEqual(view.items.map((item) => item.columnId), ["progress"]);
        assert.strictEqual(view.moves[0]?.status, "applied");
        assert.strictEqual(view.sync?.revision, 3);
        assert.strictEqual(test.reads(), 6);
      }),
    ),
  );
  it.effect("a failed refresh keeps the stored board until someone asks to refresh again", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* TestClock.adjust("31 seconds");
        test.failReads(true);
        yield* test.service.openBoard({ projectId, boardId: test.boardId });
        yield* test.service.drainRefreshes;
        yield* TestClock.adjust("10 seconds");
        const failed = yield* test.service.openBoard({ projectId, boardId: test.boardId });
        assert.deepStrictEqual(failed.sync, {
          revision: 1,
          syncedAt: epoch,
          syncing: false,
          failure: { at: "1970-01-01T00:00:31.000Z", message: "Board unavailable" },
        });
        assert.deepStrictEqual(failed.items.map((item) => item.columnId), ["ready"]);
        assert.strictEqual(test.reads(), 2);
        test.failReads(false);
        test.setColumn("progress");
        yield* test.service.openBoard({ projectId, boardId: test.boardId, refresh: true });
        yield* test.service.drainRefreshes;
        const recovered = yield* test.service.openBoard({ projectId, boardId: test.boardId });
        assert.deepStrictEqual(recovered.sync, {
          revision: 2,
          syncedAt: "1970-01-01T00:00:41.000Z",
          syncing: false,
          failure: null,
        });
        assert.deepStrictEqual(recovered.items.map((item) => item.columnId), ["progress"]);
        assert.strictEqual(test.reads(), 3);
      }),
    ),
  );
  it.effect("a subscription follows the stored revision through a refresh and a move", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        const events: IssueBoardSyncEvent[] = [];
        const subscribed = yield* Deferred.make<void>();
        const collector = yield* test.service
          .subscribeBoard({ projectId, boardId: test.boardId })
          .pipe(
            Stream.take(6),
            Stream.runForEach((event) =>
              Effect.sync(() => events.push(event)).pipe(
                Effect.andThen(Deferred.succeed(subscribed, undefined)),
              ),
            ),
            Effect.forkChild,
          );
        yield* Deferred.await(subscribed);
        yield* TestClock.adjust("31 seconds");
        yield* test.service.openBoard({ projectId, boardId: test.boardId });
        yield* test.service.drainRefreshes;
        yield* test.service.move({
          requestId: "move-while-subscribed",
          boardId: test.boardId,
          issue,
          columnId: "progress",
        });
        yield* Fiber.join(collector);
        const later = "1970-01-01T00:00:31.000Z";
        const sync = (revision: number, syncedAt: string, syncing: boolean) => ({
          boardId: test.boardId,
          sync: { revision, syncedAt, syncing, failure: null },
        });
        assert.deepStrictEqual(events, [
          sync(1, epoch, false),
          sync(1, epoch, true),
          sync(1, later, true),
          sync(1, later, false),
          sync(2, later, false),
          sync(3, later, false),
        ]);
      }),
    ),
  );
  it.effect("disconnecting during a refresh ends subscriptions and leaves nothing stored", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        const subscribe = test.service
          .subscribeBoard({ projectId, boardId: test.boardId })
          .pipe(Stream.runCollect);
        yield* TestClock.adjust("31 seconds");
        const held = yield* test.hold;
        yield* test.service.openBoard({ projectId, boardId: test.boardId });
        yield* Deferred.await(held.started);
        const subscriber = yield* Effect.forkChild(subscribe);
        const disconnect = { requestId: "disconnect-during-refresh", boardId: test.boardId };
        yield* test.service.disconnectBoard(disconnect);
        yield* Deferred.succeed(held.release, undefined);
        yield* test.service.drainRefreshes;
        assert.deepStrictEqual((yield* Fiber.join(subscriber)).at(-1), {
          boardId: test.boardId,
          sync: null,
        });
        yield* test.service.disconnectBoard(disconnect);
        assert.deepStrictEqual(yield* subscribe, [{ boardId: test.boardId, sync: null }]);
        const reopened = yield* test.service
          .openBoard({ projectId, boardId: test.boardId })
          .pipe(Effect.result);
        assert.strictEqual(reopened._tag, "Failure");
        if (reopened._tag === "Failure") assert.strictEqual(reopened.failure.reason, "not-found");
        assert.strictEqual(test.reads(), 2);
      }),
    ),
  );
  it.effect("reads unsaved boards live every time and stores nothing", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        const unsaved = { ...locator, projectNumber: 2 };
        const view = yield* test.service.openBoard({ projectId, locator: unsaved });
        assert.deepStrictEqual(view.sync, {
          revision: 0,
          syncedAt: epoch,
          syncing: false,
          failure: null,
        });
        assert.strictEqual(view.board.mapping, null);
        yield* test.service.openBoard({ projectId, locator: unsaved });
        assert.strictEqual(test.reads(), 3);
      }),
    ),
  );
  it.effect("checks the host for Start and moves, and stores what the move confirmed", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* test.reserve("reserve-live");
        assert.strictEqual(test.reads(), 2);
        const receipt = yield* test.service.move({
          requestId: "move-live",
          boardId: test.boardId,
          issue,
          columnId: "progress",
        });
        assert.strictEqual(receipt.status, "applied");
        assert.strictEqual(test.reads(), 5);
        const view = yield* test.service.openBoard({ projectId, boardId: test.boardId });
        assert.strictEqual(test.reads(), 5);
        assert.deepStrictEqual(view.items.map((item) => item.columnId), ["progress"]);
        assert.strictEqual(view.sync?.revision, 3);
      }),
    ),
  );
  it.effect("lists saved board connections without querying repository hosts", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        let discoveries = 0;
        const service = yield* makeIssueService({
          ...test.options,
          host: {
            ...test.options.host,
            listBoards: () =>
              Effect.sync(() => {
                discoveries++;
                return [{ title: "Discovered board", locator: { ...locator, projectNumber: 2 } }];
              }),
          },
        });
        const saved = yield* service.listBoards({ projectId, connectedOnly: true });
        assert.deepStrictEqual(
          saved.map((board) => board.id),
          [test.boardId],
        );
        assert.deepStrictEqual(
          yield* service.listBoards({
            projectId: ProjectId.make("another-project"),
            connectedOnly: true,
          }),
          [],
        );
        yield* service.disconnectBoard({
          requestId: "disconnect-for-picker",
          boardId: test.boardId,
        });
        assert.deepStrictEqual(yield* service.listBoards({ projectId, connectedOnly: true }), []);
        assert.strictEqual(discoveries, 0);
        assert.strictEqual((yield* service.listBoards({ projectId })).length, 1);
        assert.strictEqual(discoveries, 1);
      }),
    ),
  );

  it.effect("reads legacy Ready mappings and reserves after a service restart", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        const restarted = yield* makeIssueService(test.options);
        const view = yield* restarted.openBoard({ projectId, boardId: test.boardId });
        assert.strictEqual(view.board.mapping?.ready, "ready");
        const link = yield* restarted.reserveAttempt({
          requestId: "legacy-reserve",
          boardId: test.boardId,
          issue,
          sourceEnvironmentId: environmentId,
          destinationEnvironmentId: environmentId,
        });
        assert.strictEqual(link.boardId, test.boardId);
        assert.deepStrictEqual(test.writes, []);
      }),
    ),
  );
  it.effect("persists multiple Ready columns and reserves from either remote placement", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        const configured = yield* test.service.configureBoard({
          requestId: "multi-ready",
          projectId,
          locator,
          mapping: {
            ready: ["ready", "ready-next", "ready"],
            inProgress: "progress",
            inPullRequest: "pr",
            completed: "done",
            moveOnMerge: true,
          },
        });
        assert.deepStrictEqual(configured.board.mapping?.ready, ["ready", "ready-next"]);
        const restarted = yield* makeIssueService(test.options);
        const view = yield* restarted.openBoard({ projectId, boardId: test.boardId });
        assert.deepStrictEqual(view.board.mapping?.ready, ["ready", "ready-next"]);
        yield* test.reserve("first-ready");
        test.setColumn("ready-next");
        const second = yield* restarted.reserveAttempt({
          requestId: "second-ready",
          boardId: test.boardId,
          issue,
          sourceEnvironmentId: environmentId,
          destinationEnvironmentId: destination,
        });
        assert.strictEqual(second.destinationEnvironmentId, destination);
        const dest = yield* makeIssueService({ ...test.options, environmentId: destination });
        yield* dest.attachAttempt({
          link: second,
          threadId,
          projectId,
          worktreePath: "/repo/work",
        });
        yield* dest.firstPromptSent({ threadId, eventKey: "send-from-second-ready" });
        assert.deepStrictEqual(test.writes, []);
        yield* test.service.ingestReceipts({ receipts: (yield* dest.listReceipts({})).receipts });
        assert.deepStrictEqual(test.writes, ["progress"]);
      }),
    ),
  );
  it.effect("rejects empty or unknown Ready selections without replacing the saved mapping", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        for (const ready of [[], ["ready", "missing"]]) {
          const result = yield* test.service
            .configureBoard({
              requestId: `invalid-ready-${ready.length}`,
              projectId,
              locator,
              mapping: {
                ready,
                inProgress: "progress",
                inPullRequest: "pr",
                completed: "done",
                moveOnMerge: true,
              },
            })
            .pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "invalid");
        }
        const view = yield* test.service.openBoard({ projectId, boardId: test.boardId });
        assert.strictEqual(view.board.mapping?.ready, "ready");
      }),
    ),
  );
  it.effect("rejects a new reservation after remote placement leaves all Ready columns", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* test.service.configureBoard({
          requestId: "multi-ready",
          projectId,
          locator,
          mapping: {
            ready: ["ready", "ready-next"],
            inProgress: "progress",
            inPullRequest: "pr",
            completed: "done",
            moveOnMerge: true,
          },
        });
        yield* test.service.openBoard({ projectId, boardId: test.boardId });
        test.setColumn("progress");
        const result = yield* test.reserve("after-remote-move").pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "conflict");
        assert.strictEqual((yield* test.service.listAttempts({ issue })).length, 0);
      }),
    ),
  );
  it.effect("keeps a connected upstream board after the project switches to its fork", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        const restarted = yield* makeIssueService({
          ...test.options,
          getProject: () =>
            Effect.succeed({
              ...project,
              repositoryIdentity: {
                canonicalKey: "github.com/my-fork/repo",
                provider: "github",
                displayName: "my-fork/repo",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "https://github.com/my-fork/repo.git",
                },
              },
            }),
          host: {
            ...test.options.host,
            listBoards: () => Effect.succeed([]),
            board: (cwd, requested) => {
              assert.deepStrictEqual(requested, locator);
              return test.options.host.board(cwd, requested);
            },
            move: (cwd, requested, item, column) => {
              assert.deepStrictEqual(requested, locator);
              return test.options.host.move(cwd, requested, item, column);
            },
          },
        });

        assert.strictEqual((yield* restarted.listBoards({ projectId }))[0]?.id, test.boardId);
        const opened = yield* restarted.openBoard({ projectId, boardId: test.boardId });
        assert.deepStrictEqual(opened.board.locator, locator);
        yield* restarted.move({
          requestId: "move-upstream-after-fork",
          boardId: test.boardId,
          issue,
          columnId: "progress",
        });
        assert.deepStrictEqual(test.writes, ["progress"]);
      }),
    ),
  );

  it.effect(
    "reservation and attachment do not move or activate before the first successful send",
    () =>
      run(
        Effect.gen(function* () {
          const test = yield* setup;
          const link = yield* test.reserve("reserve");
          assert.deepStrictEqual(yield* test.reserve("reserve"), link);
          yield* test.service.attachAttempt({
            link,
            threadId,
            projectId,
            worktreePath: "/repo/work",
          });
          assert.strictEqual(test.column(), "ready");
          assert.strictEqual((yield* test.service.listAttempts({ threadId }))[0]!.active, false);
          yield* test.service.firstPromptSent({ threadId, eventKey: "send-success" });
          assert.strictEqual(test.column(), "progress");
          assert.strictEqual((yield* test.service.listAttempts({ threadId }))[0]!.active, true);
          yield* test.service.firstPromptSent({ threadId, eventKey: "another-send" });
          assert.deepStrictEqual(test.writes, ["progress"]);
        }),
      ),
  );
  it.effect(
    "unchanged PR refresh preserves manual movement across service restart, then close and merge move",
    () =>
      run(
        Effect.gen(function* () {
          const test = yield* setup;
          const link = yield* test.reserve("reserve");
          yield* test.service.attachAttempt({
            link,
            threadId,
            projectId,
            worktreePath: "/repo/work",
          });
          yield* test.service.firstPromptSent({ threadId, eventKey: "send" });
          const key = { host: "github.com", repository: "owner/repo", number: 7 };
          yield* test.service.observePullRequest({
            threadId,
            eventKey: "draft-created",
            key,
            state: "open",
            source: "created",
          });
          assert.strictEqual(test.column(), "pr");
          yield* test.service.move({
            requestId: "manual",
            boardId: test.boardId,
            issue,
            columnId: "ready",
          });
          const restarted = yield* makeIssueService(test.options);
          yield* restarted.observePullRequest({
            threadId,
            eventKey: "new-title-refresh",
            key,
            state: "open",
          });
          assert.strictEqual(test.column(), "ready");
          yield* restarted.observePullRequest({
            threadId,
            eventKey: "closed",
            key,
            state: "closed",
          });
          assert.strictEqual(test.column(), "progress");
          yield* restarted.observePullRequest({
            threadId,
            eventKey: "merged",
            key,
            state: "merged",
          });
          assert.strictEqual(test.column(), "done");
          assert.deepStrictEqual(test.writes, ["progress", "pr", "ready", "progress", "done"]);
        }),
      ),
  );
  it.effect(
    "a later successful attempt stays active when an earlier reservation finishes late",
    () =>
      run(
        Effect.gen(function* () {
          const test = yield* setup;
          const early = yield* test.reserve("early");
          const late = yield* test.reserve("late");
          const secondThread = ThreadId.make("second-thread");
          yield* test.service.attachAttempt({
            link: late,
            threadId: secondThread,
            projectId,
            worktreePath: "/repo/second",
          });
          yield* test.service.firstPromptSent({ threadId: secondThread, eventKey: "newer-send" });
          yield* test.service.attachAttempt({
            link: early,
            threadId,
            projectId,
            worktreePath: "/repo/first",
          });
          yield* test.service.firstPromptSent({ threadId, eventKey: "older-send" });
          const attempts = yield* test.service.listAttempts({ issue });
          assert.strictEqual(attempts.length, 2);
          assert.strictEqual(
            attempts.find((attempt) => attempt.link.attemptId === late.attemptId)!.active,
            true,
          );
          assert.strictEqual(
            attempts.find((attempt) => attempt.link.attemptId === early.attemptId)!.active,
            false,
          );
          yield* test.service.observePullRequest({
            threadId,
            eventKey: "inactive-merge",
            key: { host: "github.com", repository: "owner/repo", number: 3 },
            state: "merged",
          });
          assert.deepStrictEqual(test.writes, ["progress"]);
        }),
      ),
  );
  it.effect("new manual movement supersedes an older failed automatic retry", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        const link = yield* test.reserve("reserve");
        yield* test.service.attachAttempt({
          link,
          threadId,
          projectId,
          worktreePath: "/repo/work",
        });
        test.fail(true);
        yield* test.service.firstPromptSent({ threadId, eventKey: "send" });
        const failed = (yield* test.service.openBoard({ projectId, boardId: test.boardId }))
          .moves[0]!;
        assert.strictEqual(failed.status, "failed");
        test.fail(false);
        yield* test.service.move({
          requestId: "manual",
          boardId: test.boardId,
          issue,
          columnId: "pr",
        });
        const retry = yield* test.service.retryMove({ requestId: "retry", moveId: failed.id });
        assert.strictEqual(retry.status, "superseded");
        assert.strictEqual(test.column(), "pr");
        assert.deepStrictEqual(test.writes, ["pr"]);
      }),
    ),
  );
  it.effect(
    "cross-environment launch receipts survive restart and source rejects mutated reservation",
    () =>
      run(
        Effect.gen(function* () {
          const test = yield* setup;
          const link = yield* test.reserve("reserve", destination);
          const dest = yield* makeIssueService({ ...test.options, environmentId: destination });
          yield* dest.attachAttempt({ link, threadId, projectId, worktreePath: "/remote/work" });
          yield* dest.firstPromptSent({ threadId, eventKey: "send" });
          assert.strictEqual(test.column(), "ready");
          const restarted = yield* makeIssueService({
            ...test.options,
            environmentId: destination,
          });
          const pending = yield* restarted.listReceipts({});
          assert.strictEqual(pending.receipts.length, 1);
          const receipt = pending.receipts[0]!;
          const invalid = yield* test.service
            .ingestReceipts({
              receipts: [{ ...receipt, link: { ...receipt.link, reservationId: "forged" } }],
            })
            .pipe(Effect.result);
          assert.strictEqual(invalid._tag, "Failure");
          const ack = yield* test.service.ingestReceipts({ receipts: pending.receipts });
          yield* restarted.acknowledgeReceipts(ack);
          assert.strictEqual(test.column(), "progress");
          yield* test.service.ingestReceipts({ receipts: pending.receipts });
          assert.deepStrictEqual(test.writes, ["progress"]);
          assert.strictEqual((yield* restarted.listReceipts({})).receipts.length, 0);
        }),
      ),
  );
  it.effect("merge switch leaves placement alone and Azure issue identity ignores project", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        const link = yield* test.reserve("reserve");
        yield* test.service.attachAttempt({
          link,
          threadId,
          projectId,
          worktreePath: "/repo/work",
        });
        yield* test.service.firstPromptSent({ threadId, eventKey: "send" });
        yield* test.service.configureBoard({
          requestId: "disable-merge",
          projectId,
          locator,
          mapping: {
            ready: "ready",
            inProgress: "progress",
            inPullRequest: "pr",
            completed: "done",
            moveOnMerge: false,
          },
        });
        yield* test.service.observePullRequest({
          threadId,
          eventKey: "merged",
          key: { host: "github.com", repository: "owner/repo", number: 7 },
          state: "merged",
        });
        assert.strictEqual(test.column(), "progress");
        assert.strictEqual(
          canonicalIssueKey({
            ...issue,
            hostKind: "azure-devops",
            host: "dev.azure.com",
            repository: "org/one",
          }),
          canonicalIssueKey({
            ...issue,
            hostKind: "azure-devops",
            host: "dev.azure.com",
            repository: "org/two",
          }),
        );
        yield* test.service.disconnectBoard({ requestId: "disconnect", boardId: test.boardId });
        assert.strictEqual((yield* test.service.listAttempts({ issue })).length, 1);
        assert.strictEqual(
          (yield* test.service.openBoard({ projectId, boardId: test.boardId }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
      }),
    ),
  );
  it.effect(
    "delayed pre-manual receipts are quarantined and a synchronized new event can move",
    () =>
      run(
        Effect.gen(function* () {
          const test = yield* setup;
          const link = yield* test.reserve("reserve", destination);
          const dest = yield* makeIssueService({ ...test.options, environmentId: destination });
          yield* dest.attachAttempt({ link, threadId, projectId, worktreePath: "/remote/work" });
          yield* dest.firstPromptSent({ threadId, eventKey: "send" });
          const old = yield* dest.listReceipts({});
          yield* test.service.move({
            requestId: "manual-after-send",
            boardId: test.boardId,
            issue,
            columnId: "done",
          });
          yield* test.service.ingestReceipts({ receipts: old.receipts });
          assert.strictEqual(test.column(), "done");
          const blocked = (yield* test.service.openBoard({ projectId, boardId: test.boardId }))
            .moves[0]!;
          assert.strictEqual(blocked.status, "failed");
          assert.match(blocked.error!, /synchronization barrier/);
          yield* dest.acknowledgeReceipts({
            acknowledgedKeys: old.receipts.map((receipt) => receipt.eventKey),
          });
          const active = (yield* test.service.listAttempts({ issue }))[0]!;
          yield* dest.syncAttemptGenerations({
            generations: [
              {
                attemptId: link.attemptId,
                reservationId: link.reservationId,
                sourceGeneration: active.sourceGeneration,
              },
            ],
          });
          yield* dest.observePullRequest({
            threadId,
            eventKey: "new-pr-after-sync",
            key: { host: "github.com", repository: "owner/repo", number: 11 },
            state: "open",
          });
          yield* test.service.ingestReceipts({ receipts: (yield* dest.listReceipts({})).receipts });
          assert.strictEqual(test.column(), "pr");
          assert.deepStrictEqual(test.writes, ["done", "pr"]);
        }),
      ),
  );
  it.effect("closing an earlier PR does not undo the active attempt's newer PR stage", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        const link = yield* test.reserve("reserve");
        yield* test.service.attachAttempt({
          link,
          threadId,
          projectId,
          worktreePath: "/repo/work",
        });
        yield* test.service.firstPromptSent({ threadId, eventKey: "send" });
        const first = { host: "github.com", repository: "owner/repo", number: 7 };
        const second = { ...first, number: 8 };
        yield* test.service.observePullRequest({
          threadId,
          eventKey: "first-pr",
          key: first,
          state: "open",
        });
        yield* test.service.observePullRequest({
          threadId,
          eventKey: "second-pr",
          key: second,
          state: "open",
        });
        yield* test.service.observePullRequest({
          threadId,
          eventKey: "old-pr-close",
          key: first,
          state: "closed",
        });
        assert.strictEqual(test.column(), "pr");
        yield* test.service.observePullRequest({
          threadId,
          eventKey: "new-pr-merge",
          key: second,
          state: "merged",
        });
        assert.strictEqual(test.column(), "done");
      }),
    ),
  );
  it.effect(
    "board discovery retains cross-owner saved connections and tolerates discovery permission failure",
    () =>
      run(
        Effect.gen(function* () {
          const test = yield* setup;
          const otherLocator: IssueBoardLocator = {
            ...locator,
            owner: "another-owner",
            projectNumber: 17,
          };
          const crossOwner = yield* makeIssueService({
            ...test.options,
            host: {
              ...test.options.host,
              board: () =>
                test.options.host
                  .board("/repo", otherLocator)
                  .pipe(Effect.map((remote) => ({ ...remote, locator: otherLocator }))),
            },
          });
          const connected = yield* crossOwner.configureBoard({
            requestId: "connect-other-owner",
            projectId,
            locator: otherLocator,
            mapping: {
              ready: "ready",
              inProgress: "progress",
              inPullRequest: "pr",
              completed: "done",
              moveOnMerge: true,
            },
          });
          assert.strictEqual(
            (yield* crossOwner.listBoards({ projectId })).some(
              (board) => board.id === connected.board.id,
            ),
            true,
          );
          const denied = yield* makeIssueService({
            ...test.options,
            host: {
              ...test.options.host,
              listBoards: () =>
                Effect.fail(
                  new IssueOperationError({
                    reason: "authentication",
                    message: "Project discovery denied",
                  }),
                ),
            },
          });
          const boards = yield* denied.listBoards({ projectId });
          assert.strictEqual(boards.length, 2);
          assert.strictEqual(
            boards.some((board) => board.id === connected.board.id),
            true,
          );
        }),
      ),
  );
});
