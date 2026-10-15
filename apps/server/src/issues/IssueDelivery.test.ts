import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type IssueBoardLocator,
  type IssueRef,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import issueBoardsMigration from "../persistence/Migrations/056_IssueBoards.ts";
import snapshotMigration from "../persistence/Migrations/059_IssueBoardSnapshots.ts";
import deliveryMigration from "../persistence/Migrations/069_IssueDeliveryPeers.ts";
import * as IssueDelivery from "./IssueDelivery.ts";
import { freshPeerKeys, memorySecretStore } from "./IssuePeer.testFixtures.ts";
import { IssuePeerKeys } from "./IssuePeerKeys.ts";
import { fromAdapters } from "./IssueHost.ts";
import type { IssueHostAdapter } from "./IssueHostAdapter.ts";
import {
  IssuePeerTransport,
  IssuePeerUnauthorizedError,
  IssuePeerUnreachableError,
} from "./IssuePeerTransport.ts";
import { IssueService, makeIssueService, type IssueServiceShape } from "./IssueService.ts";

const source = EnvironmentId.make("delivery-source");
const destination = EnvironmentId.make("delivery-destination");
const projectId = ProjectId.make("delivery-project");
const threadId = ThreadId.make("delivery-thread");
const issue: IssueRef = {
  hostKind: "github",
  host: "github.com",
  repository: "owner/repo",
  id: "7",
  number: 7,
  url: "https://github.com/owner/repo/issues/7",
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
  title: "Delivery",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  repositoryIdentity: {
    canonicalKey: "github.com/owner/repo",
    provider: "github",
    displayName: "owner/repo",
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://github.com/x" },
  },
  scripts: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};
const credential = "peer-credential";
const pr = { host: "github.com", repository: "owner/repo", number: 9 };

const database = Effect.gen(function* () {
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
  yield* Effect.all([issueBoardsMigration, snapshotMigration, deliveryMigration]).pipe(
    Effect.provideContext(context),
  );
  return context;
});

/** Joins the source to an in-memory destination the way the socket adapter joins two servers. */
const inProcessTransport = (state: {
  readonly destination: IssueServiceShape;
  reachable: boolean;
  credential: string;
  acknowledged: string[];
  connects: number;
  released: number;
  hold: {
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null;
}) =>
  IssuePeerTransport.of({
    connect: (peer) =>
      Effect.gen(function* () {
        state.connects++;
        const held = state.hold;
        state.hold = null;
        if (held) {
          yield* Deferred.succeed(held.started, undefined);
          yield* Deferred.await(held.release);
        }
        if (!state.reachable)
          return yield* new IssuePeerUnreachableError({ endpoints: peer.endpoints.length });
        if (peer.credential !== state.credential) return yield* new IssuePeerUnauthorizedError({});
        return {
          endpoint: peer.endpoints[0]!,
          listReceipts: (after) =>
            state.destination.listReceipts({ after, sourceEnvironmentId: source }),
          acknowledge: (input) =>
            Effect.sync(() => state.acknowledged.push(...input.acknowledgedKeys)).pipe(
              Effect.andThen(
                state.destination.acknowledgeReceipts({ ...input, sourceEnvironmentId: source }),
              ),
            ),
          syncGenerations: (input) =>
            state.destination.syncAttemptGenerations({ ...input, sourceEnvironmentId: source }),
          release: Effect.sync(() => {
            state.released++;
          }),
        };
      }),
  });

const setup = Effect.gen(function* () {
  let column = "ready";
  const writes: string[] = [];
  const adapter = {
    kind: "github",
    list: () => Effect.succeed({ issues: [], nextCursor: null }),
    get: () => Effect.die("unused"),
    boards: {
      locatorKind: "github-project",
      list: () => Effect.succeed([{ title: "Board", locator }]),
      read: () =>
        Effect.sync(() => ({
          title: "Board",
          locator,
          columns: ["ready", "progress", "pr", "done"].map((id) => ({ id, title: id })),
          items: [
            {
              issue: { ref: issue, title: "Issue", state: "open", labels: [], updatedAt: "now" },
              itemId: "I1",
              columnId: column,
              version: "1",
            },
          ],
        })),
      move: (_cwd, _locator, _item, next) =>
        Effect.sync(() => {
          writes.push(next);
          column = next;
        }),
    },
  } satisfies IssueHostAdapter;
  const sourceDb = yield* database;
  const destinationDb = yield* database;
  const sourceIssues = yield* makeIssueService({
    hosts: fromAdapters([adapter]),
    environmentId: source,
    getProject: () => Effect.succeed(project),
  }).pipe(Effect.provideContext(sourceDb));
  const destinationIssues = yield* makeIssueService({
    hosts: fromAdapters([]),
    environmentId: destination,
    getProject: () => Effect.succeed(project),
  }).pipe(Effect.provideContext(destinationDb));
  const peer = {
    destination: destinationIssues,
    reachable: true,
    credential,
    acknowledged: [] as string[],
    connects: 0,
    released: 0,
    hold: null as {
      readonly started: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    } | null,
  };
  const secrets = memorySecretStore();
  const sourceKeys = yield* freshPeerKeys();
  yield* SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`INSERT INTO issue_peer_grants(source_environment_id,public_key)
        VALUES(${source},${sourceKeys.publicKey})`,
    ),
    Effect.provideContext(destinationDb),
  );
  const makeDelivery = IssueDelivery.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(IssueService, sourceIssues),
        Layer.succeed(IssuePeerTransport, inProcessTransport(peer)),
        Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store),
        Layer.succeed(IssuePeerKeys, sourceKeys),
        Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(source) }),
      ),
    ),
    Effect.provideContext(sourceDb),
  );
  const delivery = yield* makeDelivery;
  const board = yield* sourceIssues.configureBoard({
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
  const boardId = board.board.id;
  const start = Effect.fnUntraced(function* (target: EnvironmentId = destination) {
    const link = yield* sourceIssues.reserveAttempt({
      requestId: `reserve-${target}`,
      boardId,
      issue,
      sourceEnvironmentId: source,
      destinationEnvironmentId: target,
    });
    const owner = target === source ? sourceIssues : destinationIssues;
    yield* owner.attachAttempt({ link, threadId, projectId, worktreePath: "/remote/work" });
    yield* owner.firstPromptSent({ threadId, eventKey: "send" });
    return link;
  });
  const pullRequest = (eventKey: string, state: "open" | "merged") =>
    destinationIssues.observePullRequest({ threadId, eventKey, key: pr, state });
  const peerRow = SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) =>
        sql<{
          state: string;
          last_error: string | null;
          failures: number;
        }>`SELECT state,last_error,failures FROM issue_delivery_peers`,
    ),
    Effect.map((rows) => rows[0]),
    Effect.provideContext(sourceDb),
  );
  return {
    boardId,
    delivery,
    makeDelivery,
    nudge: delivery.deliver({ boardId }).pipe(Effect.andThen(delivery.drain)),
    destinationIssues,
    sourceIssues,
    peer,
    peerRow,
    pullRequest,
    start,
    secrets: secrets.values,
    writes,
    setColumn: (next: string) => {
      column = next;
    },
    register: (value = credential, expiresAt = "2099-01-01T00:00:00.000Z") =>
      delivery
        .registerPeer({
          destinationEnvironmentId: destination,
          credential: value,
          endpoints: ["http://192.168.1.20:3773/"],
          publicKey: "destination-key",
          expiresAt,
        })
        .pipe(Effect.andThen(delivery.drain)),
  };
});

const tick = TestClock.adjust("15 seconds");

describe("IssueDelivery", () => {
  it.effect("moves the source board from destination events with no client connected", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.register();
      yield* test.delivery.start();
      yield* test.start();
      yield* tick;
      yield* test.delivery.drain;
      assert.deepStrictEqual(test.writes, []);
      yield* TestClock.adjust("30 seconds");
      yield* test.delivery.drain;
      assert.deepStrictEqual(test.writes, ["progress"]);
      assert.deepStrictEqual((yield* test.destinationIssues.listReceipts({})).receipts, []);
      yield* test.pullRequest("opened", "open");
      yield* TestClock.adjust("30 seconds");
      yield* test.delivery.drain;
      assert.deepStrictEqual(test.writes, ["progress", "pr"]);
      yield* test.pullRequest("merged", "merged");
      yield* TestClock.adjust("30 seconds");
      yield* test.delivery.drain;
      assert.deepStrictEqual(test.writes, ["progress", "pr", "done"]);
      assert.deepStrictEqual(yield* test.peerRow, {
        state: "delivered",
        last_error: null,
        failures: 0,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("delivers each receipt once across repeated rounds", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const link = yield* test.start();
      yield* test.register();
      yield* test.nudge;
      yield* test.nudge;
      assert.deepStrictEqual(test.writes, ["progress"]);
      assert.deepStrictEqual(test.peer.acknowledged, [`start:${link.attemptId}`]);
    }).pipe(Effect.scoped),
  );

  it.effect("pushes a manual move's generation so a later receipt is not superseded", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.start();
      yield* test.register();
      yield* test.sourceIssues.move({
        requestId: "manual",
        boardId: test.boardId,
        issue,
        columnId: "done",
      });
      assert.strictEqual((yield* test.destinationIssues.listAttempts({}))[0]?.sourceGeneration, 0);
      yield* test.nudge;
      assert.strictEqual((yield* test.destinationIssues.listAttempts({}))[0]?.sourceGeneration, 1);
      yield* test.pullRequest("after-sync", "open");
      yield* test.nudge;
      assert.deepStrictEqual(test.writes, ["progress", "done", "pr"]);
    }).pipe(Effect.scoped),
  );

  it.effect("supersedes a receipt the destination emitted before it saw a manual move", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.start();
      yield* test.register();
      yield* test.pullRequest("before-sync", "open");
      yield* test.sourceIssues.move({
        requestId: "manual",
        boardId: test.boardId,
        issue,
        columnId: "done",
      });
      yield* test.nudge;
      assert.deepStrictEqual(test.writes, ["progress", "done"]);
      const view = yield* test.sourceIssues.openBoard({ projectId, boardId: test.boardId });
      assert.match(view.moves[0]?.error ?? "", /synchronization barrier/);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps receipts pending while the destination is unreachable, then catches up", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      test.peer.reachable = false;
      yield* test.start();
      yield* test.register();
      assert.deepStrictEqual(test.writes, []);
      assert.deepStrictEqual(yield* test.peerRow, {
        state: "unreachable",
        last_error: "The worktree computer could not be reached on any of its network addresses.",
        failures: 1,
      });
      assert.strictEqual((yield* test.destinationIssues.listReceipts({})).receipts.length, 1);
      test.peer.reachable = true;
      yield* test.nudge;
      assert.deepStrictEqual(test.writes, ["progress"]);
      assert.deepStrictEqual(yield* test.peerRow, {
        state: "delivered",
        last_error: null,
        failures: 0,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("backs off an unreachable destination instead of retrying every tick", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      test.peer.reachable = false;
      yield* test.start();
      yield* test.register();
      yield* test.delivery.start();
      yield* tick;
      yield* test.delivery.drain;
      assert.strictEqual((yield* test.peerRow)?.failures, 1);
      yield* TestClock.adjust("15 seconds");
      yield* test.delivery.drain;
      assert.strictEqual((yield* test.peerRow)?.failures, 2);
      test.peer.reachable = true;
      yield* TestClock.adjust("45 seconds");
      yield* test.delivery.drain;
      assert.deepStrictEqual(test.writes, []);
      yield* TestClock.adjust("15 seconds");
      yield* test.delivery.drain;
      assert.deepStrictEqual(test.writes, ["progress"]);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a rejected credential until the destination is registered again", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      test.peer.credential = "rotated";
      yield* test.start();
      yield* test.register();
      assert.strictEqual((yield* test.peerRow)?.state, "unauthorized");
      yield* test.register("rotated");
      assert.deepStrictEqual(test.writes, ["progress"]);
    }).pipe(Effect.scoped),
  );

  it.effect("acknowledges only the receipts that applied", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const link = yield* test.start();
      const other = ThreadId.make("other-thread");
      yield* test.destinationIssues.attachAttempt({
        link: { ...link, attemptId: "unknown-attempt", reservationId: "unknown-reservation" },
        threadId: other,
        projectId,
        worktreePath: "/remote/other",
      });
      yield* test.destinationIssues.firstPromptSent({ threadId: other, eventKey: "send-other" });
      yield* test.register();
      assert.deepStrictEqual(test.writes, ["progress"]);
      assert.deepStrictEqual(test.peer.acknowledged, [`start:${link.attemptId}`]);
      assert.deepStrictEqual(
        (yield* test.destinationIssues.listReceipts({})).receipts.map(
          (receipt) => receipt.eventKey,
        ),
        ["start:unknown-attempt"],
      );
      assert.deepStrictEqual(yield* test.peerRow, {
        state: "failed",
        last_error: "The issue lifecycle receipt does not match its reservation.",
        failures: 0,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("plans no delivery for attempts the board's own environment runs", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.start(source);
      yield* test.nudge;
      assert.deepStrictEqual(test.writes, ["progress"]);
      assert.deepStrictEqual(test.peer.acknowledged, []);
      assert.strictEqual(yield* test.peerRow, undefined);
    }).pipe(Effect.scoped),
  );

  it.effect("resumes pending delivery after a restart", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      test.peer.reachable = false;
      yield* test.start();
      yield* test.register();
      test.peer.reachable = true;
      const restarted = yield* test.makeDelivery;
      yield* restarted.start();
      yield* TestClock.adjust("30 seconds");
      yield* restarted.drain;
      assert.deepStrictEqual(test.writes, ["progress"]);
    }).pipe(Effect.scoped),
  );

  it.effect("forgetting a destination deletes its credential and stops delivery", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.register();
      assert.strictEqual(test.secrets.size, 1);
      assert.deepStrictEqual(
        yield* test.delivery.forgetPeer({ destinationEnvironmentId: destination }),
        { revokedRemotely: true },
      );
      assert.strictEqual(test.peer.released, 1);
      yield* test.start();
      yield* test.nudge;
      assert.deepStrictEqual(test.writes, []);
      assert.strictEqual(test.secrets.size, 0);
      assert.strictEqual(yield* test.peerRow, undefined);
    }).pipe(Effect.scoped),
  );

  it.effect("shows each worktree environment's delivery state on the board", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const deliveries = test.sourceIssues
        .openBoard({ projectId, boardId: test.boardId })
        .pipe(Effect.map((view) => view.sync?.deliveries));
      yield* test.start();
      assert.deepStrictEqual(
        yield* deliveries,
        [
          {
            destinationEnvironmentId: destination,
            state: "unregistered",
            lastDeliveredAt: null,
            error: null,
          },
        ],
        "a reservation with no credential handed over shows from the start",
      );
      test.peer.reachable = false;
      yield* test.register();
      assert.deepStrictEqual(yield* deliveries, [
        {
          destinationEnvironmentId: destination,
          state: "unreachable",
          lastDeliveredAt: null,
          error: "The worktree computer could not be reached on any of its network addresses.",
        },
      ]);
      const delivered = yield* test.sourceIssues
        .subscribeBoard({ projectId, boardId: test.boardId })
        .pipe(
          Stream.map((event) => event.sync?.deliveries?.[0]?.state),
          Stream.filter((state) => state === "delivered"),
          Stream.runHead,
          Effect.forkScoped,
        );
      test.peer.reachable = true;
      yield* test.nudge;
      assert.deepStrictEqual(yield* Fiber.join(delivered), Option.some("delivered"));
      assert.deepStrictEqual(yield* deliveries, [
        {
          destinationEnvironmentId: destination,
          state: "delivered",
          lastDeliveredAt: "1970-01-01T00:00:00.000Z",
          error: null,
        },
      ]);
      yield* test.delivery.forgetPeer({ destinationEnvironmentId: destination });
      assert.deepStrictEqual(yield* deliveries, [
        {
          destinationEnvironmentId: destination,
          state: "unregistered",
          lastDeliveredAt: null,
          error: null,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("stays idle once its work is complete and wakes for a new start", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.start();
      yield* test.register();
      yield* test.pullRequest("opened", "open");
      yield* test.nudge;
      yield* test.pullRequest("merged", "merged");
      yield* test.nudge;
      assert.deepStrictEqual(test.writes, ["progress", "pr", "done"]);
      assert.strictEqual(test.peer.connects, 3);
      yield* test.delivery.start();
      yield* TestClock.adjust("10 minutes");
      yield* test.delivery.drain;
      assert.strictEqual(test.peer.connects, 3, "no rounds without unfinished work");
      test.setColumn("ready");
      yield* test.sourceIssues.reserveAttempt({
        requestId: "second-attempt",
        boardId: test.boardId,
        issue,
        sourceEnvironmentId: source,
        destinationEnvironmentId: destination,
      });
      yield* tick;
      yield* test.delivery.drain;
      assert.strictEqual(test.peer.connects, 4, "a new reservation wakes delivery");
    }).pipe(Effect.scoped),
  );

  it.effect("stops contacting the destination once the credential expires", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.start();
      yield* test.register(credential, "1970-01-01T00:01:00.000Z");
      assert.strictEqual(test.peer.connects, 1);
      yield* test.delivery.start();
      yield* TestClock.adjust("10 minutes");
      yield* test.delivery.drain;
      assert.strictEqual(test.peer.connects, 2, "one scheduled round before expiry, none after");
      assert.strictEqual((yield* test.peerRow)?.state, "expired");
      yield* test.pullRequest("opened", "open");
      yield* test.nudge;
      assert.deepStrictEqual(test.writes, ["progress"]);
      assert.strictEqual(test.peer.connects, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("forgets an unreachable destination here and says its grant may linger", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.register();
      test.peer.reachable = false;
      assert.deepStrictEqual(
        yield* test.delivery.forgetPeer({ destinationEnvironmentId: destination }),
        { revokedRemotely: false },
      );
      assert.strictEqual(test.peer.released, 0);
      assert.strictEqual(test.secrets.size, 0);
      assert.strictEqual(yield* test.peerRow, undefined);
    }).pipe(Effect.scoped),
  );

  it.effect("runs at most one round per destination however often delivery is requested", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.start();
      const held = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      test.peer.hold = held;
      yield* test.delivery.registerPeer({
        destinationEnvironmentId: destination,
        credential,
        endpoints: ["http://192.168.1.20:3773/"],
        publicKey: "destination-key",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      yield* Deferred.await(held.started);
      for (let request = 0; request < 5; request++)
        yield* test.delivery.deliver({ boardId: test.boardId });
      yield* Deferred.succeed(held.release, undefined);
      yield* test.delivery.drain;
      assert.strictEqual(test.peer.connects, 1);
      assert.deepStrictEqual(test.writes, ["progress"]);
      yield* test.nudge;
      assert.strictEqual(test.peer.connects, 2, "a request after the round finished runs again");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the newest credential when two starts register out of order", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.start();
      test.peer.credential = "second-grant";
      yield* test.register("second-grant", "2099-02-01T00:00:00.000Z");
      yield* test.register("first-grant", "2099-01-01T00:00:00.000Z");
      yield* test.nudge;
      assert.deepStrictEqual(test.writes, ["progress"]);
      assert.strictEqual((yield* test.peerRow)?.state, "delivered");
    }).pipe(Effect.scoped),
  );
});
