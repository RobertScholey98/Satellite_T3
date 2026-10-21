import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  SATELLITE_WS_METHODS,
  type SatelliteWsRpcMethod,
} from "@t3tools/contracts";

/** The scope each Satellite RPC requires. `RPC_REQUIRED_SCOPES` spreads it. */
export const SATELLITE_RPC_REQUIRED_SCOPES = {
  [SATELLITE_WS_METHODS.issuesList]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.issuesGet]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.issuesBoardsList]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.issuesBoardsOpen]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.issuesBoardsSubscribe]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.issuesBoardsConfigure]: AuthOrchestrationOperateScope,
  [SATELLITE_WS_METHODS.issuesBoardsDisconnect]: AuthOrchestrationOperateScope,
  [SATELLITE_WS_METHODS.issuesBoardsMove]: AuthOrchestrationOperateScope,
  [SATELLITE_WS_METHODS.issuesMovesRetry]: AuthOrchestrationOperateScope,
  [SATELLITE_WS_METHODS.issuesAttemptsList]: AuthOrchestrationReadScope,
  [SATELLITE_WS_METHODS.issuesAttemptsStart]: AuthOrchestrationOperateScope,
  [SATELLITE_WS_METHODS.issuesAttemptsEnd]: AuthOrchestrationOperateScope,
  [SATELLITE_WS_METHODS.issuesAttemptsResume]: AuthOrchestrationOperateScope,
} as const satisfies Readonly<Record<SatelliteWsRpcMethod, AuthEnvironmentScope>>;

/** The `rpc.aggregate` span label of each Satellite RPC. `RPC_AGGREGATES` spreads it. */
export const SATELLITE_RPC_AGGREGATES = {
  [SATELLITE_WS_METHODS.issuesList]: "issues",
  [SATELLITE_WS_METHODS.issuesGet]: "issues",
  [SATELLITE_WS_METHODS.issuesBoardsList]: "issues",
  [SATELLITE_WS_METHODS.issuesBoardsOpen]: "issues",
  [SATELLITE_WS_METHODS.issuesBoardsSubscribe]: "issues",
  [SATELLITE_WS_METHODS.issuesBoardsConfigure]: "issues",
  [SATELLITE_WS_METHODS.issuesBoardsDisconnect]: "issues",
  [SATELLITE_WS_METHODS.issuesBoardsMove]: "issues",
  [SATELLITE_WS_METHODS.issuesMovesRetry]: "issues",
  [SATELLITE_WS_METHODS.issuesAttemptsList]: "issues",
  [SATELLITE_WS_METHODS.issuesAttemptsStart]: "issues",
  [SATELLITE_WS_METHODS.issuesAttemptsEnd]: "issues",
  [SATELLITE_WS_METHODS.issuesAttemptsResume]: "issues",
} as const satisfies Readonly<Record<SatelliteWsRpcMethod, string>>;
