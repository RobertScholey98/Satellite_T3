import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  IdeaChange,
  IdeaGetInput,
  IdeaGetResult,
  IdeaListInput,
  IdeaListResult,
  IdeaOperationError,
} from "./ideas.ts";
import {
  IssuesListInput,
  IssuesListResult,
  IssuesGetInput,
  IssueDetail,
  IssueBoardsListInput,
  IssueBoardSummary,
  IssueBoardsOpenInput,
  IssueBoardsSubscribeInput,
  IssueBoardSyncEvent,
  IssueBoardView,
  IssueBoardsConfigureInput,
  IssueBoardsDisconnectInput,
  IssueBoardsMoveInput,
  IssueMoveReceipt,
  IssueMovesRetryInput,
  IssueAttemptsReserveInput,
  IssueAttemptLink,
  IssueAttemptsListInput,
  IssueAttempt,
  IssueAttemptsReceiptsInput,
  IssueAttemptsReceiptsResult,
  IssueAttemptsAcknowledgeInput,
  IssueAttemptsSyncGenerationsInput,
  IssueOperationError,
  IssuePeerGrant,
  IssuePeerIdentity,
  IssuePeersForgetInput,
  IssuePeersGrantInput,
  IssuePeersRegisterInput,
  IssueDeliveriesDeliverInput,
} from "./issues.ts";
import {
  OpenWorkListInput,
  OpenWorkListResult,
  OpenWorkTimelineInput,
  OpenWorkTimelineResult,
  OpenWorkLinkFolderInput,
  OpenWorkFolderLink,
  OpenWorkUnlinkFolderInput,
  OpenWorkAssignDocumentInput,
  OpenWorkDocument,
  OpenWorkFavoriteInput,
  OpenWorkFavoritesInput,
  OpenWorkFavoritesResult,
  OpenWorkReadLinkedInput,
  OpenWorkReadLinkedResult,
  OpenWorkOperationError,
} from "./openWork.ts";
import {
  RevdocInput,
  RevdocStartInput,
  RevdocTestStartInput,
  RevdocDetail,
  RevdocSaveInput,
  RevdocRunState,
  RevdocError,
  RevdocWorktreesInput,
  RevdocWorktrees,
} from "./revdoc.ts";
import {
  DocumentOperationError,
  DocumentSummary,
  DocumentDetail,
  DocumentSubmission,
  DocumentsListInput,
  DocumentsGetInput,
  DocumentsPublishInput,
  DocumentsSaveDraftInput,
  DocumentsSubmitInput,
  DocumentsRetryInput,
  DocumentsHistoryInput,
  DocumentsHistoryResult,
} from "./documents.ts";
import {
  OrchestrationGetRequestLifecycleInput,
  OrchestrationGetRequestLifecycleResult,
  OrchestrationGetRequestLifecycleError,
} from "./satelliteOrchestration.ts";

/** Satellite's WebSocket methods. `WS_METHODS` spreads this table, so clients use either name. */
export const SATELLITE_WS_METHODS = {
  ideasList: "ideas.list",
  ideasGet: "ideas.get",
  ideasSubscribeChanges: "ideas.subscribeChanges",
  orchestrationGetRequestLifecycle: "orchestration.getRequestLifecycle",
  revdocGet: "revdoc.get",
  revdocStart: "revdoc.start",
  revdocTestStart: "revdoc.testStart",
  revdocCancel: "revdoc.cancel",
  revdocSave: "revdoc.save",
  revdocChanges: "revdoc.changes",
  revdocWorktrees: "revdoc.worktrees",
  documentsList: "documents.list",
  issuesList: "issues.list",
  issuesGet: "issues.get",
  issuesBoardsList: "issues.boards.list",
  issuesBoardsOpen: "issues.boards.open",
  issuesBoardsSubscribe: "issues.boards.subscribe",
  issuesBoardsConfigure: "issues.boards.configure",
  issuesBoardsDisconnect: "issues.boards.disconnect",
  issuesBoardsMove: "issues.boards.move",
  issuesMovesRetry: "issues.moves.retry",
  issuesAttemptsReserve: "issues.attempts.reserve",
  issuesAttemptsList: "issues.attempts.list",
  issuesAttemptsReceipts: "issues.attempts.receipts",
  issuesAttemptsAcknowledge: "issues.attempts.acknowledge",
  issuesAttemptsSyncGenerations: "issues.attempts.syncGenerations",
  issuesPeersIdentity: "issues.peers.identity",
  issuesPeersGrant: "issues.peers.grant",
  issuesPeersRegister: "issues.peers.register",
  issuesPeersForget: "issues.peers.forget",
  issuesDeliveriesDeliver: "issues.deliveries.deliver",
  openWorkList: "openWork.list",
  openWorkTimeline: "openWork.timeline",
  openWorkLinkFolder: "openWork.linkFolder",
  openWorkUnlinkFolder: "openWork.unlinkFolder",
  openWorkAssignDocument: "openWork.assignDocument",
  openWorkFavoriteDocument: "openWork.favoriteDocument",
  openWorkFavorites: "openWork.favorites",
  openWorkReadLinkedDocument: "openWork.readLinkedDocument",
  documentsGet: "documents.get",
  documentsPublish: "documents.publish",
  documentsSaveDraft: "documents.saveDraft",
  documentsSubmit: "documents.submit",
  documentsRetry: "documents.retry",
  documentsHistory: "documents.history",
} as const;

const ideaRpcError = Schema.Union([IdeaOperationError, EnvironmentAuthorizationError]);
const revdocRpcError = Schema.Union([RevdocError, EnvironmentAuthorizationError]);
const WsRevdocGetRpc = Rpc.make(SATELLITE_WS_METHODS.revdocGet, {
  payload: RevdocInput,
  success: RevdocDetail,
  error: revdocRpcError,
});
const WsRevdocStartRpc = Rpc.make(SATELLITE_WS_METHODS.revdocStart, {
  payload: RevdocStartInput,
  success: Schema.Void,
  error: revdocRpcError,
});
const WsRevdocTestStartRpc = Rpc.make(SATELLITE_WS_METHODS.revdocTestStart, {
  payload: RevdocTestStartInput,
  success: Schema.Void,
  error: revdocRpcError,
});
const WsRevdocCancelRpc = Rpc.make(SATELLITE_WS_METHODS.revdocCancel, {
  payload: RevdocInput,
  success: Schema.Void,
  error: revdocRpcError,
});
const WsRevdocSaveRpc = Rpc.make(SATELLITE_WS_METHODS.revdocSave, {
  payload: RevdocSaveInput,
  success: RevdocDetail,
  error: revdocRpcError,
});
const WsRevdocChangesRpc = Rpc.make(SATELLITE_WS_METHODS.revdocChanges, {
  payload: RevdocInput,
  success: RevdocRunState,
  error: revdocRpcError,
  stream: true,
});
const WsRevdocWorktreesRpc = Rpc.make(SATELLITE_WS_METHODS.revdocWorktrees, {
  payload: RevdocWorktreesInput,
  success: RevdocWorktrees,
  error: revdocRpcError,
});

const documentRpcError = Schema.Union([DocumentOperationError, EnvironmentAuthorizationError]);
const WsDocumentsListRpc = Rpc.make(SATELLITE_WS_METHODS.documentsList, {
  payload: DocumentsListInput,
  success: Schema.Array(DocumentSummary),
  error: documentRpcError,
});
const WsDocumentsGetRpc = Rpc.make(SATELLITE_WS_METHODS.documentsGet, {
  payload: DocumentsGetInput,
  success: DocumentDetail,
  error: documentRpcError,
});
const WsDocumentsPublishRpc = Rpc.make(SATELLITE_WS_METHODS.documentsPublish, {
  payload: DocumentsPublishInput,
  success: DocumentDetail,
  error: documentRpcError,
});
const WsDocumentsSaveDraftRpc = Rpc.make(SATELLITE_WS_METHODS.documentsSaveDraft, {
  payload: DocumentsSaveDraftInput,
  success: DocumentDetail,
  error: documentRpcError,
});
const WsDocumentsSubmitRpc = Rpc.make(SATELLITE_WS_METHODS.documentsSubmit, {
  payload: DocumentsSubmitInput,
  success: DocumentSubmission,
  error: documentRpcError,
});
const WsDocumentsRetryRpc = Rpc.make(SATELLITE_WS_METHODS.documentsRetry, {
  payload: DocumentsRetryInput,
  success: DocumentSubmission,
  error: documentRpcError,
});
const WsDocumentsHistoryRpc = Rpc.make(SATELLITE_WS_METHODS.documentsHistory, {
  payload: DocumentsHistoryInput,
  success: DocumentsHistoryResult,
  error: documentRpcError,
});

/**
 * The RPCs Satellite adds to upstream's surface; `WsRpcGroup` merges this group into
 * `WsCoreRpcGroup`. `SatelliteWsRpc.ts` implements it in its own handler layer, so `ws.ts`
 * carries only a merge line.
 */
export const WsSatelliteRpcGroup = RpcGroup.make(
  Rpc.make(SATELLITE_WS_METHODS.ideasList, {
    payload: IdeaListInput,
    success: IdeaListResult,
    error: ideaRpcError,
  }),
  Rpc.make(SATELLITE_WS_METHODS.ideasGet, {
    payload: IdeaGetInput,
    success: IdeaGetResult,
    error: ideaRpcError,
  }),
  Rpc.make(SATELLITE_WS_METHODS.ideasSubscribeChanges, {
    payload: Schema.Struct({}),
    success: IdeaChange,
    error: ideaRpcError,
    stream: true,
  }),
  Rpc.make(SATELLITE_WS_METHODS.orchestrationGetRequestLifecycle, {
    payload: OrchestrationGetRequestLifecycleInput,
    success: OrchestrationGetRequestLifecycleResult,
    error: Schema.Union([OrchestrationGetRequestLifecycleError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesList, {
    payload: IssuesListInput,
    success: IssuesListResult,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesGet, {
    payload: IssuesGetInput,
    success: IssueDetail,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesBoardsList, {
    payload: IssueBoardsListInput,
    success: Schema.Array(IssueBoardSummary),
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesBoardsOpen, {
    payload: IssueBoardsOpenInput,
    success: IssueBoardView,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesBoardsSubscribe, {
    payload: IssueBoardsSubscribeInput,
    success: IssueBoardSyncEvent,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
    stream: true,
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesBoardsConfigure, {
    payload: IssueBoardsConfigureInput,
    success: IssueBoardView,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesBoardsDisconnect, {
    payload: IssueBoardsDisconnectInput,
    success: Schema.Void,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesBoardsMove, {
    payload: IssueBoardsMoveInput,
    success: IssueMoveReceipt,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesMovesRetry, {
    payload: IssueMovesRetryInput,
    success: IssueMoveReceipt,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesAttemptsReserve, {
    payload: IssueAttemptsReserveInput,
    success: IssueAttemptLink,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesAttemptsList, {
    payload: IssueAttemptsListInput,
    success: Schema.Array(IssueAttempt),
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesAttemptsReceipts, {
    payload: IssueAttemptsReceiptsInput,
    success: IssueAttemptsReceiptsResult,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesAttemptsAcknowledge, {
    payload: IssueAttemptsAcknowledgeInput,
    success: Schema.Void,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesAttemptsSyncGenerations, {
    payload: IssueAttemptsSyncGenerationsInput,
    success: Schema.Void,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesPeersIdentity, {
    payload: Schema.Struct({}),
    success: IssuePeerIdentity,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesPeersGrant, {
    payload: IssuePeersGrantInput,
    success: IssuePeerGrant,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesPeersRegister, {
    payload: IssuePeersRegisterInput,
    success: Schema.Void,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesPeersForget, {
    payload: IssuePeersForgetInput,
    success: Schema.Void,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.issuesDeliveriesDeliver, {
    payload: IssueDeliveriesDeliverInput,
    success: Schema.Void,
    error: Schema.Union([IssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.openWorkList, {
    payload: OpenWorkListInput,
    success: OpenWorkListResult,
    error: Schema.Union([OpenWorkOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.openWorkTimeline, {
    payload: OpenWorkTimelineInput,
    success: OpenWorkTimelineResult,
    error: Schema.Union([OpenWorkOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.openWorkLinkFolder, {
    payload: OpenWorkLinkFolderInput,
    success: OpenWorkFolderLink,
    error: Schema.Union([OpenWorkOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.openWorkUnlinkFolder, {
    payload: OpenWorkUnlinkFolderInput,
    success: Schema.Void,
    error: Schema.Union([OpenWorkOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.openWorkAssignDocument, {
    payload: OpenWorkAssignDocumentInput,
    success: OpenWorkDocument,
    error: Schema.Union([OpenWorkOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.openWorkFavoriteDocument, {
    payload: OpenWorkFavoriteInput,
    success: OpenWorkDocument,
    error: Schema.Union([OpenWorkOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.openWorkFavorites, {
    payload: OpenWorkFavoritesInput,
    success: OpenWorkFavoritesResult,
    error: Schema.Union([OpenWorkOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SATELLITE_WS_METHODS.openWorkReadLinkedDocument, {
    payload: OpenWorkReadLinkedInput,
    success: OpenWorkReadLinkedResult,
    error: Schema.Union([OpenWorkOperationError, EnvironmentAuthorizationError]),
  }),
  WsRevdocGetRpc,
  WsRevdocStartRpc,
  WsRevdocTestStartRpc,
  WsRevdocCancelRpc,
  WsRevdocSaveRpc,
  WsRevdocChangesRpc,
  WsRevdocWorktreesRpc,
  WsDocumentsListRpc,
  WsDocumentsGetRpc,
  WsDocumentsPublishRpc,
  WsDocumentsSaveDraftRpc,
  WsDocumentsSubmitRpc,
  WsDocumentsRetryRpc,
  WsDocumentsHistoryRpc,
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
