import type { AuthEnvironmentScope, SatelliteWsRpcMethod } from "@t3tools/contracts";

/** The scope each Satellite RPC requires. `RPC_REQUIRED_SCOPES` spreads it. */
export const SATELLITE_RPC_REQUIRED_SCOPES = {} as const satisfies Readonly<
  Record<SatelliteWsRpcMethod, AuthEnvironmentScope>
>;

/** The `rpc.aggregate` span label of each Satellite RPC. `RPC_AGGREGATES` spreads it. */
export const SATELLITE_RPC_AGGREGATES = {} as const satisfies Readonly<
  Record<SatelliteWsRpcMethod, string>
>;
