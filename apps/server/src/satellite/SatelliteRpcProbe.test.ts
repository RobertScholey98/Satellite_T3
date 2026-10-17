// @effect-diagnostics nodeBuiltinImport:off - Reads ws.ts to check its registration lines.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import {
  RpcInstrumentation,
  rpcInstrumentationLayer,
} from "../observability/RpcInstrumentation.ts";
import * as SatelliteWsRpc from "./SatelliteWsRpc.ts";

// A Satellite RPC registered only in this file, the way a feature PR would register one: a
// method and RPC in the contracts module, a scope and label in the registry, and a handler in
// SatelliteWsRpc. Everything upstream (rpc.ts, RpcAuthorization, RpcInstrumentation) is real.
const probe = await vi.hoisted(async () => {
  const Rpc = await import("effect/rpc/Rpc");
  const ProbeRpcGroup = await import("effect/rpc/RpcGroup");
  const Schema = await import("effect/Schema");
  const { EnvironmentAuthorizationError } =
    await import("../../../../packages/contracts/src/auth.ts");
  const rpc = Rpc.make("satellite.probe", {
    payload: Schema.Struct({}),
    success: Schema.Struct({ served: Schema.Literal(true) }),
    error: EnvironmentAuthorizationError,
  });
  return { method: "satellite.probe" as const, rpc, group: ProbeRpcGroup.make(rpc) };
});

vi.mock("../../../../packages/contracts/src/satelliteRpc.ts", () => ({
  SATELLITE_WS_METHODS: { satelliteProbe: probe.method },
  WsSatelliteRpcGroup: probe.group,
}));

vi.mock("./SatelliteRpcRegistry.ts", async () => {
  const { AuthOrchestrationOperateScope: operate } =
    await import("../../../../packages/contracts/src/auth.ts");
  return {
    SATELLITE_RPC_REQUIRED_SCOPES: { [probe.method]: operate },
    SATELLITE_RPC_AGGREGATES: { [probe.method]: "satelliteProbe" },
  };
});

vi.mock("./SatelliteWsRpc.ts", async () => {
  const ProbeEffect = await import("effect/Effect");
  return {
    makeConnectionLayer: ProbeEffect.succeed(() =>
      probe.group.toLayer({ [probe.method]: () => ProbeEffect.succeed({ served: true as const }) }),
    ),
  };
});

const session = {
  sessionId: AuthSessionId.make("satellite-probe"),
  subject: "satellite-probe",
  method: "browser-session-cookie",
  scopes: [],
} as const;

/** The probe as the merged WsRpcGroup carries it, with ws.ts's instrumentation added. */
const servedProbeGroup = () => {
  const merged = WsRpcGroup.requests.get(probe.method as never);
  assert.isDefined(merged);
  return RpcGroup.make(merged as unknown as typeof probe.rpc).middleware(RpcInstrumentation);
};

const callProbe = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Effect.gen(function* () {
    const makeLayer = yield* SatelliteWsRpc.makeConnectionLayer;
    // The mocked module serves the probe; its declared type is the shipped, empty one.
    const handlers = makeLayer(session) as unknown as Layer.Layer<Rpc.Handler<typeof probe.method>>;
    const client = yield* RpcTest.makeClient(servedProbeGroup()).pipe(
      Effect.provide(
        Layer.mergeAll(handlers, RpcAuthorization.layer(scopes), rpcInstrumentationLayer),
      ),
    );
    return yield* client[probe.method]({}).pipe(
      Effect.catchTags({ EnvironmentAuthorizationError: (error) => Effect.succeed(error._tag) }),
    );
  });

describe("a Satellite RPC registered through the Satellite modules", () => {
  it("joins upstream's method table and merged group", () => {
    assert.strictEqual((WS_METHODS as Record<string, string>)["satelliteProbe"], probe.method);
    assert.isTrue(WsRpcGroup.requests.has(probe.method as never));
  });

  it.effect("is served with its registered scope enforced", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* callProbe([AuthOrchestrationOperateScope]), {
        served: true,
      });
      assert.strictEqual(
        yield* callProbe([AuthOrchestrationReadScope]),
        "EnvironmentAuthorizationError",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("is instrumented under its registered aggregate label", () => {
    const ended: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          ended.push(span);
        };
        return span;
      },
    });
    return Effect.gen(function* () {
      yield* callProbe([AuthOrchestrationOperateScope]);
      const span = ended.find((candidate) => candidate.name === `ws.rpc.${probe.method}`);
      assert.strictEqual(span?.attributes.get("rpc.aggregate"), "satelliteProbe");
    }).pipe(Effect.scoped, Effect.withTracer(tracer));
  });

  // Nothing else serves Satellite handlers: losing either line in an upstream merge drops every
  // Satellite RPC while the empty-registry tests still pass.
  it("is merged into each WebSocket connection by ws.ts", () => {
    const ws = NodeFS.readFileSync(NodePath.join(import.meta.dirname, "../ws.ts"), "utf8");
    assert.include(ws, "const satelliteWsRpc = yield* SatelliteWsRpc.makeConnectionLayer;");
    assert.include(ws, "Layer.merge(satelliteWsRpc(session)),");
  });
});
