import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  type SatelliteWsRpcMethod,
  type SatelliteWsSubscriptionMethod,
  WS_METHODS,
  WsCoreRpcGroup,
  WsRpcGroup,
  WsSatelliteRpcGroup,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { DocumentService } from "../documents/DocumentService.ts";
import { IdeaNotebookStore } from "../ideas/IdeaNotebookStore.ts";
import { IssueDelivery } from "../issues/IssueDelivery.ts";
import { IssuePeerAccess } from "../issues/IssuePeerAccess.ts";
import { IssueService } from "../issues/IssueService.ts";
import { OpenWorkService } from "../openWork/OpenWorkService.ts";
import {
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
} from "../orchestration-v2/SatelliteOrchestration.ts";
import { RevdocService } from "../revdoc/RevdocService.ts";
import type * as WsServer from "../ws.ts";
import { SATELLITE_RPC_AGGREGATES, SATELLITE_RPC_REQUIRED_SCOPES } from "./SatelliteRpcRegistry.ts";
import * as SatelliteWsRpc from "./SatelliteWsRpc.ts";

const receiptQueries: unknown[] = [];
// Handlers capture these at build time; only `IdeaNotebookStore.list` and
// `IssueService.listReceipts` are ever called.
const services = Layer.mergeAll(
  Layer.succeed(IdeaNotebookStore, {
    list: () => Effect.succeed([]),
  } as unknown as IdeaNotebookStore["Service"]),
  Layer.succeed(OrchestrationEngineService, {} as OrchestrationEngineService["Service"]),
  Layer.succeed(ProjectionSnapshotQuery, {} as ProjectionSnapshotQuery["Service"]),
  Layer.succeed(RevdocService, {} as RevdocService["Service"]),
  Layer.succeed(DocumentService, {} as DocumentService["Service"]),
  Layer.succeed(IssueService, {
    listReceipts: (input: unknown) =>
      Effect.sync(() => receiptQueries.push(input)).pipe(
        Effect.as({ receipts: [], nextCursor: 0 }),
      ),
  } as unknown as IssueService["Service"]),
  Layer.succeed(IssueDelivery, {} as IssueDelivery["Service"]),
  Layer.succeed(IssuePeerAccess, {} as IssuePeerAccess["Service"]),
  Layer.succeed(OpenWorkService, {} as OpenWorkService["Service"]),
);

const session = {
  sessionId: AuthSessionId.make("satellite-registration"),
  subject: "satellite-registration",
  method: "browser-session-cookie",
  scopes: [],
} as const;

const satelliteMethods = [...WsSatelliteRpcGroup.requests.keys()].toSorted();

describe("Satellite RPC registration", () => {
  it.effect("serves a handler for every Satellite RPC and nothing else", () =>
    Effect.gen(function* () {
      const makeLayer = yield* SatelliteWsRpc.makeConnectionLayer;
      const handlers = yield* Layer.build(makeLayer(session));
      const handledMethods = [...handlers.mapUnsafe.values()]
        .filter((entry) => typeof entry?.handler === "function")
        .map((entry) => entry.tag)
        .toSorted();
      expect(handledMethods).toEqual(satelliteMethods);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], expected: { ideas: [] } },
    { scopes: [], expected: { _tag: "EnvironmentAuthorizationError" } },
  ])("serves Satellite RPCs through the merged group with scopes $scopes", ({ scopes, expected }) =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (tag): tag is Exclude<RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"], SatelliteWsRpcMethod> =>
            WsCoreRpcGroup.requests.has(tag),
        ),
      );
      const makeLayer = yield* SatelliteWsRpc.makeConnectionLayer;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(makeLayer(session), RpcAuthorization.layer(scopes))),
      );
      const result = yield* client[WS_METHODS.ideasList]({}).pipe(
        Effect.catchTags({ EnvironmentAuthorizationError: Effect.succeed }),
      );
      expect(result).toMatchObject(expected);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("lets an issue peer session call only the peer RPCs, for its own board", () =>
    Effect.gen(function* () {
      const peer = { ...session, subject: "issue-peer:board-environment" };
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (tag): tag is Exclude<RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"], SatelliteWsRpcMethod> =>
            WsCoreRpcGroup.requests.has(tag),
        ),
      );
      const makeLayer = yield* SatelliteWsRpc.makeConnectionLayer;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(makeLayer(peer), RpcAuthorization.layer([], peer.subject))),
      );
      receiptQueries.length = 0;
      assert.deepStrictEqual(yield* client[WS_METHODS.issuesAttemptsReceipts]({ after: 4 }), {
        receipts: [],
        nextCursor: 0,
      });
      assert.deepStrictEqual(receiptQueries, [
        { after: 4, sourceEnvironmentId: "board-environment" },
      ]);
      const denied = yield* client[WS_METHODS.ideasList]({}).pipe(Effect.flip);
      assert.strictEqual(denied._tag, "EnvironmentAuthorizationError");
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it("declares a scope and an aggregate label for every Satellite RPC", () => {
    expect(Object.keys(SATELLITE_RPC_REQUIRED_SCOPES).toSorted()).toEqual(satelliteMethods);
    expect(Object.keys(SATELLITE_RPC_AGGREGATES).toSorted()).toEqual(satelliteMethods);
  });

  it("lets read-only sessions recover a request's lifecycle", () => {
    expect(
      RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.orchestrationGetRequestLifecycle),
    ).toBe(AuthOrchestrationReadScope);
  });

  it("registers Satellite RPCs only through the Satellite group", () => {
    const coreMethods = new Set(WsCoreRpcGroup.requests.keys());
    expect(satelliteMethods.filter((method) => coreMethods.has(method))).toEqual([]);
    expect(new Set(WsRpcGroup.requests.keys())).toEqual(
      new Set([...coreMethods, ...satelliteMethods]),
    );
  });
});

type IsAny<T> = 0 extends 1 & T ? true : false;
type MergedWsRpcLayerServices =
  | Layer.Services<ReturnType<typeof WsServer.layerWsRpc>>
  | Layer.Services<ReturnType<Effect.Success<typeof SatelliteWsRpc.makeConnectionLayer>>>;
// Fails to compile if the handler layers' requirements widen to `any`, which would hide missing
// services from the compiler.
const mergedWsRpcLayerRequirementsAreTyped: IsAny<MergedWsRpcLayerServices> = false;
void mergedWsRpcLayerRequirementsAreTyped;

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// `StreamMethod` must pick out exactly the group's stream RPCs, which clients resubscribe on reconnect.
const subscriptionsFollowTheGroup: Equals<
  SatelliteWsSubscriptionMethod,
  "ideas.subscribeChanges" | "revdoc.changes" | "issues.boards.subscribe"
> = true;
void subscriptionsFollowTheGroup;
