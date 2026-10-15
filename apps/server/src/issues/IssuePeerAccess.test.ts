import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  RpcScopeAuthorization,
  WsSatelliteRpcGroup,
  type IssueBoardLocator,
  type IssueRef,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import { DocumentService } from "../documents/DocumentService.ts";
import { DirectEndpoints } from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { IdeaNotebookStore } from "../ideas/IdeaNotebookStore.ts";
import { OpenWorkService } from "../openWork/OpenWorkService.ts";
import {
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
} from "../orchestration-v2/SatelliteOrchestration.ts";
import issueBoardsMigration from "../persistence/Migrations/056_IssueBoards.ts";
import snapshotMigration from "../persistence/Migrations/059_IssueBoardSnapshots.ts";
import deliveryMigration from "../persistence/Migrations/069_IssueDeliveryPeers.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { RevdocService } from "../revdoc/RevdocService.ts";
import * as SatelliteWsRpc from "../satellite/SatelliteWsRpc.ts";
import * as IssueDelivery from "./IssueDelivery.ts";
import { fromAdapters } from "./IssueHost.ts";
import type { IssueHostAdapter } from "./IssueHostAdapter.ts";
import { freshPeerKeys } from "./IssuePeer.testFixtures.ts";
import * as IssuePeerAccess from "./IssuePeerAccess.ts";
import { IssuePeerKeys } from "./IssuePeerKeys.ts";
import * as IssuePeerTransport from "./IssuePeerTransport.ts";
import { IssueService, makeIssueService } from "./IssueService.ts";

const source = EnvironmentId.make("board-environment");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const operator = { scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] };
const issue: IssueRef = {
  hostKind: "github",
  host: "github.com",
  repository: "owner/repo",
  id: "3",
  number: 3,
  url: "https://github.com/owner/repo/issues/3",
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
  title: "Project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  repositoryIdentity: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const layerDestinationAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-issue-peer-test-" })),
);

/** A worktree environment with real authentication, RPC authorization, and Satellite handlers. */
const worktreeServer = Effect.gen(function* () {
  const context = yield* Layer.build(layerDestinationAuth);
  const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
  const environmentId = yield* Context.get(context, ServerEnvironment.ServerEnvironmentIdentity)
    .getEnvironmentId;
  const issues = yield* makeIssueService({
    hosts: fromAdapters([]),
    environmentId,
    getProject: () => Effect.succeed(project),
  }).pipe(Effect.provideContext(context));
  const advertised = { origin: "" };
  const keys = yield* freshPeerKeys();
  const identity = Layer.mergeAll(
    Layer.succeed(IssuePeerKeys, keys),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  );
  const peerAccess = yield* IssuePeerAccess.make.pipe(
    Effect.provideService(
      SessionStore.SessionStore,
      Context.get(context, SessionStore.SessionStore),
    ),
    Effect.provideService(DirectEndpoints, {
      resolve: () => Effect.sync(() => [{ kind: "lan", httpBaseUrl: advertised.origin }]),
    }),
    Effect.provide(identity),
    Effect.provideService(SqlClient.SqlClient, Context.get(context, SqlClient.SqlClient)),
  );
  const handlerServices = Layer.mergeAll(
    Layer.succeed(IssueService, issues),
    Layer.succeed(IssuePeerAccess.IssuePeerAccess, peerAccess),
    Layer.succeed(IssueDelivery.IssueDelivery, {} as IssueDelivery.IssueDelivery["Service"]),
    Layer.succeed(IdeaNotebookStore, {} as IdeaNotebookStore["Service"]),
    Layer.succeed(OrchestrationEngineService, {} as OrchestrationEngineService["Service"]),
    Layer.succeed(ProjectionSnapshotQuery, {} as ProjectionSnapshotQuery["Service"]),
    Layer.succeed(RevdocService, {} as RevdocService["Service"]),
    Layer.succeed(DocumentService, {} as DocumentService["Service"]),
    Layer.succeed(OpenWorkService, {} as OpenWorkService["Service"]),
  );
  const makeHandlers = yield* SatelliteWsRpc.makeConnectionLayer.pipe(
    Effect.provide(handlerServices),
  );
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/.well-known/t3/environment",
      HttpServerResponse.json({
        environmentId,
        label: "Worktree computer",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0",
        capabilities: { repositoryIdentity: true },
      }),
    ),
    HttpRouter.add(
      "POST",
      "/api/auth/websocket-ticket",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateHttpRequest(request);
        return yield* HttpServerResponse.json(yield* auth.issueWebSocketTicket(session));
      }).pipe(
        Effect.catchTags({
          ServerAuthInvalidCredentialError: (error) =>
            HttpServerResponse.json(
              {
                _tag: "EnvironmentAuthInvalidError",
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "trace",
              },
              { status: 401 },
            ).pipe(Effect.tap(() => Effect.logDebug(error.message))),
        }),
        Effect.orDie,
      ),
    ),
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateWebSocketUpgrade(request);
        const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
        yield* RpcServer.make(WsSatelliteRpcGroup.middleware(RpcScopeAuthorization)).pipe(
          Effect.provideService(RpcServer.Protocol, protocol),
          Effect.provide(
            Layer.merge(
              makeHandlers(session),
              RpcAuthorization.layer(session.scopes, session.subject),
            ).pipe(Layer.provide(handlerServices)),
          ),
          Effect.forkScoped,
        );
        return yield* httpEffect;
      }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.orDie),
    ),
  );
  const server = yield* Layer.build(
    HttpRouter.serve(
      Layer.merge(routes, IssuePeerAccess.proofRoute.pipe(Layer.provide(identity))),
      {
        disableListenLog: true,
      },
    ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
  );
  advertised.origin = HttpServer.formatAddress(Context.get(server, HttpServer.HttpServer).address);
  return { auth, environmentId, issues, peerAccess };
});

/** The board environment: a connected board, a socket transport, and its own database. */
const boardEnvironment = Effect.gen(function* () {
  const database = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
  yield* Effect.all([issueBoardsMigration, snapshotMigration, deliveryMigration]).pipe(
    Effect.provideContext(database),
  );
  const writes: string[] = [];
  let column = "ready";
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
  const issues = yield* makeIssueService({
    hosts: fromAdapters([adapter]),
    environmentId: source,
    getProject: () => Effect.succeed(project),
  }).pipe(Effect.provideContext(database));
  const secrets = new Map<string, Uint8Array>();
  const transport = yield* Layer.build(
    IssuePeerTransport.layerSocket.pipe(Layer.provide(FetchHttpClient.layer)),
  );
  const boardKeys = yield* freshPeerKeys();
  const delivery = yield* IssueDelivery.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(IssueService, issues),
        Layer.succeed(IssuePeerKeys, boardKeys),
        Layer.succeedContext(transport),
        Layer.succeed(ServerSecretStore.ServerSecretStore, {
          get: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
          set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
          create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
          getOrCreateRandom: () => Effect.die("unused"),
          remove: (name) => Effect.sync(() => void secrets.delete(name)),
        }),
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(source),
        }),
      ),
    ),
    Effect.provideContext(database),
  );
  const board = yield* issues.configureBoard({
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
  const peerState = SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => sql<{ state: string }>`SELECT state FROM issue_delivery_peers`),
    Effect.map((rows) => rows[0]?.state),
    Effect.provideContext(database),
  );
  return {
    boardId: board.board.id,
    delivery,
    issues,
    peerState,
    publicKey: boardKeys.publicKey,
    writes,
  };
});

it.layer(NodeServices.layer)("issue peer access", (it) => {
  it.effect("a granted worktree environment delivers to the board until it revokes access", () =>
    Effect.gen(function* () {
      const worktree = yield* worktreeServer;
      const board = yield* boardEnvironment;
      const link = yield* board.issues.reserveAttempt({
        requestId: "reserve",
        boardId: board.boardId,
        issue,
        sourceEnvironmentId: source,
        destinationEnvironmentId: worktree.environmentId,
      });
      const grant = yield* worktree.peerAccess.grant(
        { sourceEnvironmentId: source, sourceLabel: "Desktop", sourcePublicKey: board.publicKey },
        operator,
      );
      yield* board.delivery.registerPeer({
        destinationEnvironmentId: worktree.environmentId,
        ...grant,
      });
      yield* worktree.issues.attachAttempt({ link, threadId, projectId, worktreePath: "/work" });
      yield* worktree.issues.firstPromptSent({ threadId, eventKey: "send" });
      yield* board.delivery.deliver({ boardId: board.boardId });
      yield* board.delivery.drain;
      assert.deepStrictEqual(board.writes, ["progress"]);
      assert.deepStrictEqual((yield* worktree.issues.listReceipts({})).receipts, []);

      const connection = (yield* worktree.auth.listSessions()).find(
        (session) => session.client.label === "Issue updates for Desktop",
      );
      assert.deepStrictEqual(
        connection && { subject: connection.subject, scopes: connection.scopes },
        {
          subject: "issue-peer:board-environment",
          scopes: [],
        },
      );
      yield* worktree.auth.revokeSession(connection!.sessionId);
      yield* worktree.issues.observePullRequest({
        threadId,
        eventKey: "opened",
        key: { host: "github.com", repository: "owner/repo", number: 4 },
        state: "open",
      });
      yield* board.delivery.deliver({ boardId: board.boardId });
      yield* board.delivery.drain;
      assert.strictEqual(yield* board.peerState, "unauthorized");
      assert.deepStrictEqual(board.writes, ["progress"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a new grant replaces the previous credential for the same board environment", () =>
    Effect.gen(function* () {
      const worktree = yield* worktreeServer;
      const input = { sourceEnvironmentId: source, sourceLabel: "Desktop", sourcePublicKey: "key" };
      yield* worktree.peerAccess.grant(input, operator);
      yield* worktree.peerAccess.grant(input, operator);
      const peers = (yield* worktree.auth.listSessions()).filter(
        (session) => session.subject === "issue-peer:board-environment",
      );
      assert.strictEqual(peers.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses grants a caller could not use and grants to its own environment", () =>
    Effect.gen(function* () {
      const worktree = yield* worktreeServer;
      const refusals = yield* Effect.all([
        worktree.peerAccess
          .grant(
            { sourceEnvironmentId: source, sourceLabel: "Desktop", sourcePublicKey: "key" },
            {
              scopes: [AuthOrchestrationReadScope],
            },
          )
          .pipe(Effect.flip),
        worktree.peerAccess
          .grant(
            {
              sourceEnvironmentId: worktree.environmentId,
              sourceLabel: "Self",
              sourcePublicKey: "key",
            },
            operator,
          )
          .pipe(Effect.flip),
      ]);
      assert.deepStrictEqual(
        refusals.map((error) => error.reason),
        ["authentication", "invalid"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("forgetting the worktree environment revokes its grant there", () =>
    Effect.gen(function* () {
      const worktree = yield* worktreeServer;
      const board = yield* boardEnvironment;
      const grant = yield* worktree.peerAccess.grant(
        { sourceEnvironmentId: source, sourceLabel: "Desktop", sourcePublicKey: board.publicKey },
        operator,
      );
      yield* board.delivery.registerPeer({
        destinationEnvironmentId: worktree.environmentId,
        ...grant,
      });
      yield* board.delivery.drain;
      const peerSessions = worktree.auth
        .listSessions()
        .pipe(
          Effect.map(
            (sessions) =>
              sessions.filter((session) => session.subject === "issue-peer:board-environment")
                .length,
          ),
        );
      assert.strictEqual(yield* peerSessions, 1);
      assert.deepStrictEqual(
        yield* board.delivery.forgetPeer({ destinationEnvironmentId: worktree.environmentId }),
        { revokedRemotely: true },
      );
      assert.strictEqual(yield* peerSessions, 0);
    }).pipe(Effect.scoped),
  );
});
