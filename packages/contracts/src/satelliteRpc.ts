import type * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";

import {
  FACTORY_WS_METHODS,
  WsFactoryAssignmentsCancelRpc,
  WsFactoryAssignmentsListRpc,
  WsFactoryAssignmentsRefreshDigestRpc,
  WsFactoryAssignmentsSubscribeRpc,
  WsFactoryConfigGetRpc,
  WsFactoryDraftsApplyRpc,
  WsFactoryDraftsApproveRpc,
  WsFactoryDraftsDismissRpc,
  WsFactoryDraftsEditRpc,
  WsFactoryDraftsListRpc,
  WsFactoryDraftsRestoreRpc,
  WsFactoryDraftsSubscribeRpc,
  WsFactoryFindingsListRpc,
  WsFactoryConfigUpdateRpc,
  WsFactoryManagersApproveOnboardingRpc,
  WsFactoryManagersCreateRpc,
  WsFactoryManagersListRpc,
  WsFactoryManagersPauseRpc,
  WsFactoryManagersResumeRpc,
  WsFactoryManagersRetireRpc,
  WsFactoryManagersSubscribeRpc,
  WsFactoryLogListRpc,
  WsFactoryStatsGetRpc,
  WsFactoryThreadsHandBackRpc,
  WsFactoryThreadsTakeOverRpc,
  WsFactoryWorkspaceSubscribeRpc,
} from "./factory.ts";
import {
  ISSUES_WS_METHODS,
  WsIssuesAttemptsEndRpc,
  WsIssuesAttemptsListRpc,
  WsIssuesAttemptsResumeRpc,
  WsIssuesAttemptsStartRpc,
  WsIssuesBoardsConfigureRpc,
  WsIssuesBoardsDisconnectRpc,
  WsIssuesBoardsListRpc,
  WsIssuesBoardsMoveRpc,
  WsIssuesBoardsOpenRpc,
  WsIssuesBoardsSubscribeRpc,
  WsIssuesGetRpc,
  WsIssuesListRpc,
  WsIssuesMovesRetryRpc,
} from "./issues.ts";

/**
 * Satellite's WebSocket method names. `WS_METHODS` spreads this table, so clients call Satellite
 * methods like upstream's. The official T3 Code mobile app connects to Satellite servers: add new
 * methods only, and never reuse or reshape an upstream name.
 */
export const SATELLITE_WS_METHODS = {
  ...ISSUES_WS_METHODS,
  ...FACTORY_WS_METHODS,
} as const;

/**
 * Satellite's RPCs. `WsRpcGroup` merges this group with upstream's under the same scope
 * authorization. Each RPC also needs a scope and an aggregate label in the server's
 * `SatelliteRpcRegistry.ts` and a handler in `SatelliteWsRpc.ts`.
 */
export const WsSatelliteRpcGroup = RpcGroup.make(
  WsIssuesListRpc,
  WsIssuesGetRpc,
  WsIssuesBoardsListRpc,
  WsIssuesBoardsOpenRpc,
  WsIssuesBoardsSubscribeRpc,
  WsIssuesBoardsConfigureRpc,
  WsIssuesBoardsDisconnectRpc,
  WsIssuesBoardsMoveRpc,
  WsIssuesMovesRetryRpc,
  WsIssuesAttemptsListRpc,
  WsIssuesAttemptsStartRpc,
  WsIssuesAttemptsEndRpc,
  WsIssuesAttemptsResumeRpc,
  WsFactoryConfigGetRpc,
  WsFactoryConfigUpdateRpc,
  WsFactoryManagersListRpc,
  WsFactoryManagersSubscribeRpc,
  WsFactoryManagersCreateRpc,
  WsFactoryManagersPauseRpc,
  WsFactoryManagersResumeRpc,
  WsFactoryManagersRetireRpc,
  WsFactoryManagersApproveOnboardingRpc,
  WsFactoryAssignmentsListRpc,
  WsFactoryAssignmentsSubscribeRpc,
  WsFactoryAssignmentsCancelRpc,
  WsFactoryAssignmentsRefreshDigestRpc,
  WsFactoryThreadsTakeOverRpc,
  WsFactoryThreadsHandBackRpc,
  WsFactoryLogListRpc,
  WsFactoryWorkspaceSubscribeRpc,
  WsFactoryFindingsListRpc,
  WsFactoryDraftsListRpc,
  WsFactoryDraftsSubscribeRpc,
  WsFactoryDraftsEditRpc,
  WsFactoryDraftsApproveRpc,
  WsFactoryDraftsDismissRpc,
  WsFactoryDraftsRestoreRpc,
  WsFactoryStatsGetRpc,
  WsFactoryDraftsApplyRpc,
);

type SatelliteWsRpc = RpcGroup.Rpcs<typeof WsSatelliteRpcGroup>;
export type SatelliteWsRpcMethod = SatelliteWsRpc["_tag"];

type StreamMethod<R> = R extends Rpc.Any
  ? [Rpc.IsStream<R, R["_tag"]>] extends [never]
    ? never
    : R["_tag"]
  : never;
/** Satellite's stream RPCs. Each is a subscription, so clients resubscribe on reconnect. */
export type SatelliteWsSubscriptionMethod = StreamMethod<SatelliteWsRpc>;

/**
 * Satellite's client-guarded methods: the ones a client hides or disables without the grant. The
 * server's registry authorizes every request regardless. `CLIENT_GUARDED_RPC_SCOPES` spreads it.
 */
export const SATELLITE_CLIENT_GUARDED_RPC_SCOPES = {
  [FACTORY_WS_METHODS.factoryConfigUpdate]: AuthSettingsWriteScope,
  [FACTORY_WS_METHODS.factoryManagersCreate]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryManagersPause]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryManagersResume]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryManagersRetire]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryManagersApproveOnboarding]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryAssignmentsCancel]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryThreadsTakeOver]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryThreadsHandBack]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryDraftsEdit]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryDraftsApprove]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryDraftsDismiss]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryDraftsRestore]: AuthOrchestrationOperateScope,
  // Applying a draft writes the environment's factory config, as a config update does.
  [FACTORY_WS_METHODS.factoryDraftsApply]: AuthSettingsWriteScope,
} as const satisfies Partial<Readonly<Record<SatelliteWsRpcMethod, AuthEnvironmentScope>>>;
