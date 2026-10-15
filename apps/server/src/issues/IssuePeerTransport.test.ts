import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentAuthInvalidError,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ProjectId,
  SATELLITE_WS_METHODS,
  ThreadId,
  type IssueAttemptLink,
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
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import issueBoardsMigration from "../persistence/Migrations/056_IssueBoards.ts";
import { freshPeerKeys } from "./IssuePeer.testFixtures.ts";
import { proofRoute } from "./IssuePeerAccess.ts";
import { IssuePeerKeys } from "./IssuePeerKeys.ts";
import { fromAdapters } from "./IssueHost.ts";
import {
  IssuePeerRpcs,
  IssuePeerTransport,
  layerSocket,
  type IssuePeerError,
} from "./IssuePeerTransport.ts";
import { makeIssueService } from "./IssueService.ts";

const source = EnvironmentId.make("transport-source");
const destination = EnvironmentId.make("transport-destination");
const credential = "peer-credential";
const link: IssueAttemptLink = {
  attemptId: "attempt",
  reservationId: "reservation",
  sourceEnvironmentId: source,
  sourceProjectId: ProjectId.make("source-project"),
  boardId: "board",
  destinationEnvironmentId: destination,
  sourceGeneration: 0,
  issue: {
    hostKind: "github",
    host: "github.com",
    repository: "owner/repo",
    id: "1",
    number: 1,
    url: "https://github.com/owner/repo/issues/1",
  },
};

/**
 * A destination server: its public descriptor, identity proof, ticket exchange, and peer RPC
 * socket. Each server mints its own key, so two servers can claim the same environment ID.
 */
const destinationServer = (environmentId: EnvironmentId) =>
  Effect.gen(function* () {
    const database = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
    yield* issueBoardsMigration.pipe(Effect.provideContext(database));
    const issues = yield* makeIssueService({
      hosts: fromAdapters([]),
      environmentId: destination,
      getProject: () => Effect.succeed(null),
    }).pipe(Effect.provideContext(database));
    const threadId = ThreadId.make("thread");
    yield* issues.attachAttempt({
      link,
      threadId,
      projectId: ProjectId.make("destination-project"),
      worktreePath: "/work",
    });
    yield* issues.firstPromptSent({ threadId, eventKey: "send" });
    const state = { credential, tickets: 0, presented: [] as string[] };
    const keys = yield* freshPeerKeys();
    const handlers = IssuePeerRpcs.toLayer({
      [SATELLITE_WS_METHODS.issuesAttemptsReceipts]: (input) => issues.listReceipts(input),
      [SATELLITE_WS_METHODS.issuesAttemptsAcknowledge]: (input) =>
        issues.acknowledgeReceipts(input),
      [SATELLITE_WS_METHODS.issuesAttemptsSyncGenerations]: (input) =>
        issues.syncAttemptGenerations(input),
    });
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/.well-known/t3/environment",
        HttpServerResponse.json({
          environmentId,
          label: "Destination",
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
          state.presented.push(request.headers.authorization ?? "");
          if (request.headers.authorization !== `Bearer ${state.credential}`)
            return yield* HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(
              new EnvironmentAuthInvalidError({
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "trace",
              }),
              { status: 401 },
            );
          state.tickets++;
          return yield* HttpServerResponse.json({
            ticket: `ticket-${state.tickets}`,
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/ws",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://destination");
          if (
            url.searchParams.get("wsTicket") !== `ticket-${state.tickets}` ||
            url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) === null
          )
            return HttpServerResponse.empty({ status: 401 });
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
          yield* RpcServer.make(IssuePeerRpcs).pipe(
            Effect.provideService(RpcServer.Protocol, protocol),
            Effect.forkScoped,
          );
          return yield* httpEffect;
        }).pipe(Effect.provide(Layer.merge(handlers, RpcSerialization.layerJson))),
      ),
    );
    const identity = Layer.mergeAll(
      Layer.succeed(IssuePeerKeys, keys),
      Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(Layer.merge(routes, proofRoute.pipe(Layer.provide(identity))), {
        disableListenLog: true,
      }).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
    );
    const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
    return { origin, issues, state, publicKey: keys.publicKey };
  });

const transport = Effect.gen(function* () {
  const context = yield* Layer.build(layerSocket.pipe(Layer.provide(FetchHttpClient.layer)));
  return Context.get(context, IssuePeerTransport);
});

const failureTag = (error: IssuePeerError) => error._tag;

describe("socket peer transport", () => {
  it.effect("exchanges the credential for a ticket and calls the peer RPCs", () =>
    Effect.gen(function* () {
      const server = yield* destinationServer(destination);
      const peers = yield* transport;
      const keys = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* peers.connect({
            destinationEnvironmentId: destination,
            endpoints: [server.origin],
            credential,
            publicKey: server.publicKey,
          });
          const page = yield* connection.listReceipts(0);
          yield* connection.acknowledge({
            acknowledgedKeys: page.receipts.map((receipt) => receipt.eventKey),
          });
          yield* connection.syncGenerations({
            generations: [
              { attemptId: "attempt", reservationId: "reservation", sourceGeneration: 3 },
            ],
          });
          return page.receipts.map((receipt) => receipt.eventKey);
        }),
      );
      assert.deepStrictEqual(keys, ["start:attempt"]);
      assert.deepStrictEqual((yield* server.issues.listReceipts({})).receipts, []);
      assert.strictEqual((yield* server.issues.listAttempts({}))[0]?.sourceGeneration, 3);
    }).pipe(Effect.scoped),
  );

  it.effect("skips a dead endpoint and one that answers as another environment", () =>
    Effect.gen(function* () {
      const server = yield* destinationServer(destination);
      const impostor = yield* destinationServer(EnvironmentId.make("someone-else"));
      const peers = yield* transport;
      const endpoint = yield* Effect.scoped(
        peers
          .connect({
            destinationEnvironmentId: destination,
            endpoints: ["http://127.0.0.1:9", impostor.origin, server.origin],
            credential,
            publicKey: server.publicKey,
          })
          .pipe(Effect.map((connection) => connection.endpoint)),
      );
      assert.strictEqual(endpoint, server.origin);
      assert.deepStrictEqual(impostor.state.presented, [], "the impostor never saw the credential");
    }).pipe(Effect.scoped),
  );

  it.effect("tells a rejected credential apart from an unreachable destination", () =>
    Effect.gen(function* () {
      const server = yield* destinationServer(destination);
      server.state.credential = "revoked";
      const peers = yield* transport;
      const connect = (endpoints: ReadonlyArray<string>) =>
        Effect.scoped(
          peers.connect({
            destinationEnvironmentId: destination,
            endpoints,
            credential,
            publicKey: server.publicKey,
          }),
        ).pipe(Effect.flip, Effect.map(failureTag));
      assert.strictEqual(yield* connect([server.origin]), "IssuePeerUnauthorizedError");
      assert.strictEqual(yield* connect(["http://127.0.0.1:9"]), "IssuePeerUnreachableError");
    }).pipe(Effect.scoped),
  );

  it.effect("withholds the credential from an impostor that repeats the destination's ID", () =>
    Effect.gen(function* () {
      const server = yield* destinationServer(destination);
      const impostor = yield* destinationServer(destination);
      const peers = yield* transport;
      const connect = (endpoints: ReadonlyArray<string>) =>
        Effect.scoped(
          peers
            .connect({
              destinationEnvironmentId: destination,
              endpoints,
              credential,
              publicKey: server.publicKey,
            })
            .pipe(Effect.map((connection) => connection.endpoint)),
        );
      assert.strictEqual(
        yield* connect([impostor.origin]).pipe(Effect.flip, Effect.map(failureTag)),
        "IssuePeerUnreachableError",
      );
      assert.strictEqual(yield* connect([impostor.origin, server.origin]), server.origin);
      assert.deepStrictEqual(impostor.state.presented, []);
      assert.deepStrictEqual(server.state.presented, [`Bearer ${credential}`]);
    }).pipe(Effect.scoped),
  );
});
