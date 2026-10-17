import { WsSatelliteRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

/** Server-lifetime services Satellite handlers use. Add one when a handler needs it. */
type SatelliteWsRpcServices = never;

const layer = (_session: EnvironmentAuth.AuthenticatedSession) =>
  WsSatelliteRpcGroup.toLayer(WsSatelliteRpcGroup.of({}));

/**
 * Captures Satellite's handler services once and returns each connection's handler layer.
 * `ws.ts` merges it beside upstream's handlers.
 */
export const makeConnectionLayer = Effect.map(
  Effect.context<SatelliteWsRpcServices>(),
  (services) => (session: EnvironmentAuth.AuthenticatedSession) =>
    layer(session).pipe(Layer.provide(Layer.succeedContext(services))),
);
