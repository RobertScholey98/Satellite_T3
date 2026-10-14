import {
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  SATELLITE_WS_METHODS,
  type SatelliteWsRpcMethod,
} from "@t3tools/contracts";

/** The scope each Satellite RPC requires. `RPC_REQUIRED_SCOPES` spreads it. */
export const SATELLITE_RPC_REQUIRED_SCOPES = {
  [SATELLITE_WS_METHODS.ideasList]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.ideasGet]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.ideasSubscribeChanges]: AuthOrchestrationReadScope,
} as const satisfies Readonly<Record<SatelliteWsRpcMethod, AuthEnvironmentScope>>;

/** The `rpc.aggregate` span label of each Satellite RPC. `RPC_AGGREGATES` spreads it. */
export const SATELLITE_RPC_AGGREGATES = {
  [SATELLITE_WS_METHODS.ideasList]: "ideas",
  [SATELLITE_WS_METHODS.ideasGet]: "ideas",
  [SATELLITE_WS_METHODS.ideasSubscribeChanges]: "ideas",
} as const satisfies Readonly<Record<SatelliteWsRpcMethod, string>>;
