import { SATELLITE_WS_METHODS, WsSatelliteRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as OpenWork from "../openWork/OpenWork.ts";

const layer = (_session: EnvironmentAuth.AuthenticatedSession) =>
  WsSatelliteRpcGroup.toLayer(
    Effect.gen(function* () {
      const openWork = yield* OpenWork.OpenWork;
      return WsSatelliteRpcGroup.of({
        [SATELLITE_WS_METHODS.openWorkList]: (input) => openWork.list(input),
        [SATELLITE_WS_METHODS.openWorkTimeline]: (input) => openWork.timeline(input),
        [SATELLITE_WS_METHODS.openWorkDiff]: (input) => openWork.diff(input),
        [SATELLITE_WS_METHODS.openWorkCommitFiles]: (input) => openWork.commitFiles(input),
      });
    }),
  );

/** Server-lifetime services Satellite handlers use, inferred from the handler table. */
type SatelliteWsRpcServices = Layer.Services<ReturnType<typeof layer>>;

/**
 * Captures Satellite's handler services once and returns each connection's handler layer.
 * `ws.ts` merges it beside upstream's handlers.
 */
export const makeConnectionLayer = Effect.map(
  Effect.context<SatelliteWsRpcServices>(),
  (services) => (session: EnvironmentAuth.AuthenticatedSession) =>
    layer(session).pipe(Layer.provide(Layer.succeedContext(services))),
);
