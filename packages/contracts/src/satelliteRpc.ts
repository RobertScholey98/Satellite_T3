import type * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  OPEN_WORK_WS_METHODS,
  WsOpenWorkCommitFilesRpc,
  WsOpenWorkDiffRpc,
  WsOpenWorkListRpc,
  WsOpenWorkTimelineRpc,
} from "./openWork.ts";
import {
  REVDOC_WS_METHODS,
  WsRevdocCancelRpc,
  WsRevdocDeleteRpc,
  WsRevdocEditItemRpc,
  WsRevdocGenerateRpc,
  WsRevdocGetItemsRpc,
  WsRevdocRefreshRpc,
  WsRevdocSubscribeRpc,
  WsRevdocTestRpc,
  WsRevdocWorktreesRpc,
} from "./revdoc.ts";
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
  ...OPEN_WORK_WS_METHODS,
  ...REVDOC_WS_METHODS,
  ...ISSUES_WS_METHODS,
} as const;

/**
 * Satellite's RPCs. `WsRpcGroup` merges this group with upstream's under the same scope
 * authorization. Each RPC also needs a scope and an aggregate label in the server's
 * `SatelliteRpcRegistry.ts` and a handler in `SatelliteWsRpc.ts`.
 */
export const WsSatelliteRpcGroup = RpcGroup.make(
  WsOpenWorkListRpc,
  WsOpenWorkTimelineRpc,
  WsOpenWorkDiffRpc,
  WsOpenWorkCommitFilesRpc,
  WsRevdocWorktreesRpc,
  WsRevdocSubscribeRpc,
  WsRevdocGetItemsRpc,
  WsRevdocGenerateRpc,
  WsRevdocTestRpc,
  WsRevdocCancelRpc,
  WsRevdocRefreshRpc,
  WsRevdocEditItemRpc,
  WsRevdocDeleteRpc,
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
