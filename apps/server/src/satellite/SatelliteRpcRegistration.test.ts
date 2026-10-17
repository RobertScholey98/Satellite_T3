import {
  AuthSessionId,
  SATELLITE_WS_METHODS,
  type SatelliteWsSubscriptionMethod,
  WS_METHODS,
  WsCoreRpcGroup,
  WsRpcGroup,
  WsSatelliteRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as OpenWork from "../openWork/OpenWork.ts";
import { SATELLITE_RPC_AGGREGATES, SATELLITE_RPC_REQUIRED_SCOPES } from "./SatelliteRpcRegistry.ts";
import * as SatelliteWsRpc from "./SatelliteWsRpc.ts";

const session = {
  sessionId: AuthSessionId.make("satellite-registration"),
  subject: "satellite-registration",
  method: "browser-session-cookie",
  scopes: [],
} as const;

const satelliteMethods = [...WsSatelliteRpcGroup.requests.keys()].toSorted();

// Building the handler layer only captures services; no handler runs here.
const unusedServices = Layer.succeed(
  OpenWork.OpenWork,
  OpenWork.OpenWork.of({
    list: () => Effect.die("unused"),
    timeline: () => Effect.die("unused"),
    diff: () => Effect.die("unused"),
  }),
);

describe("Satellite RPC registration", () => {
  it("serves upstream's RPCs plus Satellite's, with no Satellite RPC shadowing upstream", () => {
    const coreMethods = new Set(WsCoreRpcGroup.requests.keys());
    expect(satelliteMethods.filter((method) => coreMethods.has(method))).toEqual([]);
    expect(new Set(WsRpcGroup.requests.keys())).toEqual(
      new Set([...coreMethods, ...satelliteMethods]),
    );
  });

  it("names exactly the Satellite RPCs in the method table upstream's spreads", () => {
    expect(Object.values(SATELLITE_WS_METHODS).toSorted()).toEqual(satelliteMethods);
    for (const [key, method] of Object.entries(SATELLITE_WS_METHODS)) {
      expect(WS_METHODS).toHaveProperty(key, method);
    }
  });

  it("declares a scope and an aggregate label for every Satellite RPC", () => {
    expect(Object.keys(SATELLITE_RPC_REQUIRED_SCOPES).toSorted()).toEqual(satelliteMethods);
    expect(Object.keys(SATELLITE_RPC_AGGREGATES).toSorted()).toEqual(satelliteMethods);
  });

  it.effect("serves a handler for every Satellite RPC and nothing else", () =>
    Effect.gen(function* () {
      const makeLayer = yield* SatelliteWsRpc.makeConnectionLayer;
      const handlers = yield* Layer.build(makeLayer(session));
      const handledMethods = [...handlers.mapUnsafe.values()]
        .filter((entry) => typeof entry?.handler === "function")
        .map((entry) => entry.tag)
        .toSorted();
      expect(handledMethods).toEqual(satelliteMethods);
    }).pipe(Effect.scoped, Effect.provide(unusedServices)),
  );
});

type IsAny<T> = 0 extends 1 & T ? true : false;
// Fails to compile if the handler layer's requirements widen to `any`, which would hide missing
// services from the compiler.
const satelliteHandlerRequirementsAreTyped: IsAny<
  Layer.Services<ReturnType<Effect.Success<typeof SatelliteWsRpc.makeConnectionLayer>>>
> = false;
void satelliteHandlerRequirementsAreTyped;

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// Pins the derived set so a new stream RPC is a reviewed change to reconnect resubscription.
const subscriptionsFollowTheGroup: Equals<SatelliteWsSubscriptionMethod, never> = true;
void subscriptionsFollowTheGroup;
