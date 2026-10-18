import {
  type AuthEnvironmentScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  SATELLITE_WS_METHODS,
  type SatelliteWsRpcMethod,
} from "@t3tools/contracts";

/** The scope each Satellite RPC requires. `RPC_REQUIRED_SCOPES` spreads it. */
export const SATELLITE_RPC_REQUIRED_SCOPES = {
  [SATELLITE_WS_METHODS.openWorkList]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.openWorkTimeline]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.openWorkDiff]: AuthFilesystemReadScope,
  [SATELLITE_WS_METHODS.openWorkCommitFiles]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.revdocWorktrees]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.revdocSubscribe]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.revdocGetItems]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.revdocGenerate]: AuthOrchestrationOperateScope,
  [SATELLITE_WS_METHODS.revdocTest]: AuthOrchestrationOperateScope,
  [SATELLITE_WS_METHODS.revdocCancel]: AuthOrchestrationOperateScope,
  [SATELLITE_WS_METHODS.revdocRefresh]: AuthOrchestrationOperateScope,
  [SATELLITE_WS_METHODS.revdocEditItem]: AuthOrchestrationOperateScope,
  [SATELLITE_WS_METHODS.revdocDelete]: AuthOrchestrationOperateScope,
} as const satisfies Readonly<Record<SatelliteWsRpcMethod, AuthEnvironmentScope>>;

/** The `rpc.aggregate` span label of each Satellite RPC. `RPC_AGGREGATES` spreads it. */
export const SATELLITE_RPC_AGGREGATES = {
  [SATELLITE_WS_METHODS.openWorkList]: "openWork",
  [SATELLITE_WS_METHODS.openWorkTimeline]: "openWork",
  [SATELLITE_WS_METHODS.openWorkDiff]: "openWork",
  [SATELLITE_WS_METHODS.openWorkCommitFiles]: "openWork",
  [SATELLITE_WS_METHODS.revdocWorktrees]: "revdoc",
  [SATELLITE_WS_METHODS.revdocSubscribe]: "revdoc",
  [SATELLITE_WS_METHODS.revdocGetItems]: "revdoc",
  [SATELLITE_WS_METHODS.revdocGenerate]: "revdoc",
  [SATELLITE_WS_METHODS.revdocTest]: "revdoc",
  [SATELLITE_WS_METHODS.revdocCancel]: "revdoc",
  [SATELLITE_WS_METHODS.revdocRefresh]: "revdoc",
  [SATELLITE_WS_METHODS.revdocEditItem]: "revdoc",
  [SATELLITE_WS_METHODS.revdocDelete]: "revdoc",
} as const satisfies Readonly<Record<SatelliteWsRpcMethod, string>>;
