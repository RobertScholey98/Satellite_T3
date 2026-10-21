import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const ISSUES_WS_METHODS = {
  issuesList: "issues.list",
  issuesGet: "issues.get",
  issuesBoardsList: "issues.boards.list",
  issuesBoardsOpen: "issues.boards.open",
  issuesBoardsSubscribe: "issues.boards.subscribe",
  issuesBoardsConfigure: "issues.boards.configure",
  issuesBoardsDisconnect: "issues.boards.disconnect",
  issuesBoardsMove: "issues.boards.move",
  issuesMovesRetry: "issues.moves.retry",
  issuesAttemptsList: "issues.attempts.list",
  issuesAttemptsStart: "issues.attempts.start",
  issuesAttemptsEnd: "issues.attempts.end",
  issuesAttemptsResume: "issues.attempts.resume",
} as const;

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export const IssueRef = Schema.Struct({
  hostKind: SourceControlProviderKind,
  host: Id,
  repository: Id,
  id: Id,
  number: Schema.Number,
  url: Id,
});
export type IssueRef = typeof IssueRef.Type;

export const IssueSummary = Schema.Struct({
  ref: IssueRef,
  title: Schema.String,
  state: Schema.String,
  updatedAt: Schema.String,
  labels: Schema.Array(Schema.String),
});
export type IssueSummary = typeof IssueSummary.Type;

export const IssueActor = Schema.Struct({
  name: Schema.String,
  avatarUrl: Schema.optional(Schema.String),
});
export type IssueActor = typeof IssueActor.Type;

export const IssueComment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  author: Schema.NullOr(IssueActor),
});
export type IssueComment = typeof IssueComment.Type;

export const IssueDetail = Schema.Struct({
  ...IssueSummary.fields,
  body: Schema.String,
  author: Schema.optional(Schema.NullOr(IssueActor)),
  assignees: Schema.optional(Schema.Array(IssueActor)),
  createdAt: Schema.optional(Schema.String),
  comments: Schema.optional(Schema.Array(IssueComment)),
  hostFields: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type IssueDetail = typeof IssueDetail.Type;

/** Stored in `issue_boards.locator_json`; reshaping a member orphans connected boards. */
export const IssueBoardLocator = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("github-project"),
    host: Id,
    owner: Id,
    ownerKind: Schema.Literals(["user", "organization"]),
    projectNumber: Schema.Number,
    projectNodeId: Schema.optional(Id),
    statusFieldId: Schema.optional(Id),
  }),
  Schema.Struct({
    kind: Schema.Literal("azure-board"),
    host: Id,
    organization: Id,
    project: Id,
    team: Id,
    boardId: Id,
  }),
]);
export type IssueBoardLocator = typeof IssueBoardLocator.Type;

export const IssueBoardColumn = Schema.Struct({ id: Id, title: Schema.String });
export type IssueBoardColumn = typeof IssueBoardColumn.Type;

export const IssueBoardMapping = Schema.Struct({
  ready: Schema.Union([Id, Schema.Array(Id).check(Schema.isMinLength(1))]),
  inProgress: Id,
  inPullRequest: Id,
  completed: Id,
  moveOnMerge: Schema.Boolean,
});
export type IssueBoardMapping = typeof IssueBoardMapping.Type;

export const issueReadyColumnIds = (mapping: IssueBoardMapping): ReadonlyArray<string> =>
  typeof mapping.ready === "string" ? [mapping.ready] : mapping.ready;

export const IssueBoardItem = Schema.Struct({
  issue: IssueSummary,
  itemId: Id,
  columnId: Schema.NullOr(Id),
  version: Schema.NullOr(Schema.String),
});
export type IssueBoardItem = typeof IssueBoardItem.Type;

export const IssueBoardSyncFailure = Schema.Struct({ at: Schema.String, message: Schema.String });
export type IssueBoardSyncFailure = typeof IssueBoardSyncFailure.Type;

/** Freshness of the server's stored board copy. `syncing` and `failure` are independent facts. */
export const IssueBoardSync = Schema.Struct({
  /** Changes only when the board's columns, items, title, mapping, attempts or moves changed. */
  revision: NonNegativeInt,
  /** Last successful read from the repository host. */
  syncedAt: Schema.String,
  /** A refresh is queued or running on the server. */
  syncing: Schema.Boolean,
  /** Outcome of the last finished refresh. */
  failure: Schema.NullOr(IssueBoardSyncFailure),
});
export type IssueBoardSync = typeof IssueBoardSync.Type;

export const IssueBoardSummary = Schema.Struct({
  id: Id,
  projectId: ProjectId,
  title: Schema.String,
  locator: IssueBoardLocator,
  mapping: Schema.NullOr(IssueBoardMapping),
  /** Present on connected boards that hold a stored copy. */
  sync: Schema.optional(IssueBoardSync),
});
export type IssueBoardSummary = typeof IssueBoardSummary.Type;

export const IssuePullRequestRef = Schema.Struct({
  host: Id,
  repository: Id,
  number: Schema.Number,
  url: Schema.optional(Schema.String),
});
export type IssuePullRequestRef = typeof IssuePullRequestRef.Type;

/**
 * `launching` until the worktree exists and the thread's first run reached running. Failed and
 * ended attempts are never active.
 */
export const IssueAttemptStatus = Schema.Literals([
  "launching",
  "working",
  "in-pr",
  "merged",
  "failed",
  "ended",
]);
export type IssueAttemptStatus = typeof IssueAttemptStatus.Type;

/** For a failed attempt, `launch-failed` means no thread was created and New attempt is the way on. */
export const IssueAttemptEndedReason = Schema.Literals([
  "user",
  "superseded",
  "thread-deleted",
  "migrated-without-board",
  "completed",
  "launch-failed",
]);
export type IssueAttemptEndedReason = typeof IssueAttemptEndedReason.Type;

/** An attempt is owned by the environment that started it; only that environment moves its ticket. */
export const IssueAttempt = Schema.Struct({
  id: Id,
  boardId: Id,
  issue: IssueRef,
  projectId: ProjectId,
  threadId: ThreadId,
  worktreePath: Schema.NullOr(Schema.String),
  status: IssueAttemptStatus,
  active: Schema.Boolean,
  endedReason: Schema.NullOr(IssueAttemptEndedReason),
  /** `paused` when the stored copy shows the ticket away from where the attempt last left it. */
  automaticMoves: Schema.Literals(["on", "paused"]),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  controllingPullRequest: Schema.NullOr(IssuePullRequestRef),
});
export type IssueAttempt = typeof IssueAttempt.Type;

export const IssueMoveStatus = Schema.Literals([
  "pending",
  "applied",
  "failed",
  "skipped",
  "superseded",
]);
export type IssueMoveStatus = typeof IssueMoveStatus.Type;

export const IssueMove = Schema.Struct({
  id: Id,
  boardId: Id,
  issue: IssueRef,
  columnId: Id,
  origin: Schema.Literals(["manual", "automatic"]),
  attemptId: Schema.NullOr(Id),
  status: IssueMoveStatus,
  /** Why a move failed or was skipped. */
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type IssueMove = typeof IssueMove.Type;

export const IssueBoardView = Schema.Struct({
  board: IssueBoardSummary,
  columns: Schema.Array(IssueBoardColumn),
  items: Schema.Array(IssueBoardItem),
  attempts: Schema.Array(IssueAttempt),
  /** The latest move per ticket. */
  moves: Schema.Array(IssueMove),
  /** Absent for a board that is not connected yet. */
  sync: Schema.optional(IssueBoardSync),
});
export type IssueBoardView = typeof IssueBoardView.Type;

export class IssueOperationError extends Schema.TaggedError<IssueOperationError>()(
  "IssueOperationError",
  {
    reason: Schema.Literals([
      "unavailable",
      "authentication",
      "invalid",
      "conflict",
      "not-found",
      "remote",
      "storage",
    ]),
    message: Schema.String,
  },
) {}

export const IssuesListInput = Schema.Struct({
  projectId: ProjectId,
  cursor: Schema.optional(Schema.String),
});
export type IssuesListInput = typeof IssuesListInput.Type;

export const IssuesListResult = Schema.Struct({
  issues: Schema.Array(IssueSummary),
  nextCursor: Schema.NullOr(Schema.String),
});
export type IssuesListResult = typeof IssuesListResult.Type;

export const IssuesGetInput = Schema.Struct({ projectId: ProjectId, issue: IssueRef });
export type IssuesGetInput = typeof IssuesGetInput.Type;

/** Without a project, lists every connected board on the environment. */
export const IssueBoardsListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  connectedOnly: Schema.optional(Schema.Boolean),
});
export type IssueBoardsListInput = typeof IssueBoardsListInput.Type;

export const IssueBoardsOpenInput = Schema.Struct({
  projectId: ProjectId,
  boardId: Schema.optional(Id),
  locator: Schema.optional(IssueBoardLocator),
  /** Queue a host refresh even when the stored copy is recent. */
  refresh: Schema.optional(Schema.Boolean),
});
export type IssueBoardsOpenInput = typeof IssueBoardsOpenInput.Type;

export const IssueBoardsSubscribeInput = Schema.Struct({ projectId: ProjectId, boardId: Id });
export type IssueBoardsSubscribeInput = typeof IssueBoardsSubscribeInput.Type;

/**
 * `sync` is null when the server holds no stored copy, which after a successful open means the
 * board was disconnected.
 */
export const IssueBoardSyncEvent = Schema.Struct({
  boardId: Id,
  sync: Schema.NullOr(IssueBoardSync),
});
export type IssueBoardSyncEvent = typeof IssueBoardSyncEvent.Type;

export const IssueBoardsConfigureInput = Schema.Struct({
  requestId: Id,
  projectId: ProjectId,
  locator: IssueBoardLocator,
  mapping: IssueBoardMapping,
});
export type IssueBoardsConfigureInput = typeof IssueBoardsConfigureInput.Type;

export const IssueBoardsDisconnectInput = Schema.Struct({ requestId: Id, boardId: Id });
export type IssueBoardsDisconnectInput = typeof IssueBoardsDisconnectInput.Type;

export const IssueBoardsMoveInput = Schema.Struct({
  requestId: Id,
  boardId: Id,
  issue: IssueRef,
  columnId: Id,
  /** The column the stored copy showed; the move is refused if the remote board differs. */
  expectedPlacement: Schema.optional(Schema.NullOr(Id)),
});
export type IssueBoardsMoveInput = typeof IssueBoardsMoveInput.Type;

/** Retrying a skipped automatic move applies it deliberately, as a manual move. */
export const IssueMovesRetryInput = Schema.Struct({ requestId: Id, moveId: Id });
export type IssueMovesRetryInput = typeof IssueMovesRetryInput.Type;

export const IssueAttemptsListInput = Schema.Struct({
  boardId: Schema.optional(Id),
  issue: Schema.optional(IssueRef),
  threadId: Schema.optional(ThreadId),
});
export type IssueAttemptsListInput = typeof IssueAttemptsListInput.Type;

/** `requestId` keys the thread launch, so a repeated start returns the same thread. */
export const IssueAttemptsStartInput = Schema.Struct({
  requestId: Id,
  boardId: Id,
  issue: IssueRef,
  projectId: ProjectId,
  prompt: Schema.String.check(Schema.isMaxLength(100_000)),
  branch: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  baseRef: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type IssueAttemptsStartInput = typeof IssueAttemptsStartInput.Type;

export const IssueAttemptsStartResult = Schema.Struct({
  attempt: IssueAttempt,
  threadId: ThreadId,
});
export type IssueAttemptsStartResult = typeof IssueAttemptsStartResult.Type;

export const IssueAttemptsEndInput = Schema.Struct({
  requestId: Id,
  attemptId: Id,
  /** Moves the ticket back to this Ready column as a manual move. */
  returnToColumnId: Schema.optional(Id),
});
export type IssueAttemptsEndInput = typeof IssueAttemptsEndInput.Type;

export const IssueAttemptsResumeInput = Schema.Struct({ requestId: Id, attemptId: Id });
export type IssueAttemptsResumeInput = typeof IssueAttemptsResumeInput.Type;

const IssueRpcError = Schema.Union([IssueOperationError, EnvironmentAuthorizationError]);

export const WsIssuesListRpc = Rpc.make(ISSUES_WS_METHODS.issuesList, {
  payload: IssuesListInput,
  success: IssuesListResult,
  error: IssueRpcError,
});
export const WsIssuesGetRpc = Rpc.make(ISSUES_WS_METHODS.issuesGet, {
  payload: IssuesGetInput,
  success: IssueDetail,
  error: IssueRpcError,
});
export const WsIssuesBoardsListRpc = Rpc.make(ISSUES_WS_METHODS.issuesBoardsList, {
  payload: IssueBoardsListInput,
  success: Schema.Array(IssueBoardSummary),
  error: IssueRpcError,
});
export const WsIssuesBoardsOpenRpc = Rpc.make(ISSUES_WS_METHODS.issuesBoardsOpen, {
  payload: IssueBoardsOpenInput,
  success: IssueBoardView,
  error: IssueRpcError,
});
export const WsIssuesBoardsSubscribeRpc = Rpc.make(ISSUES_WS_METHODS.issuesBoardsSubscribe, {
  payload: IssueBoardsSubscribeInput,
  success: IssueBoardSyncEvent,
  error: IssueRpcError,
  stream: true,
});
export const WsIssuesBoardsConfigureRpc = Rpc.make(ISSUES_WS_METHODS.issuesBoardsConfigure, {
  payload: IssueBoardsConfigureInput,
  success: IssueBoardView,
  error: IssueRpcError,
});
export const WsIssuesBoardsDisconnectRpc = Rpc.make(ISSUES_WS_METHODS.issuesBoardsDisconnect, {
  payload: IssueBoardsDisconnectInput,
  success: Schema.Void,
  error: IssueRpcError,
});
export const WsIssuesBoardsMoveRpc = Rpc.make(ISSUES_WS_METHODS.issuesBoardsMove, {
  payload: IssueBoardsMoveInput,
  success: IssueMove,
  error: IssueRpcError,
});
export const WsIssuesMovesRetryRpc = Rpc.make(ISSUES_WS_METHODS.issuesMovesRetry, {
  payload: IssueMovesRetryInput,
  success: IssueMove,
  error: IssueRpcError,
});
export const WsIssuesAttemptsListRpc = Rpc.make(ISSUES_WS_METHODS.issuesAttemptsList, {
  payload: IssueAttemptsListInput,
  success: Schema.Array(IssueAttempt),
  error: IssueRpcError,
});
export const WsIssuesAttemptsStartRpc = Rpc.make(ISSUES_WS_METHODS.issuesAttemptsStart, {
  payload: IssueAttemptsStartInput,
  success: IssueAttemptsStartResult,
  error: IssueRpcError,
});
export const WsIssuesAttemptsEndRpc = Rpc.make(ISSUES_WS_METHODS.issuesAttemptsEnd, {
  payload: IssueAttemptsEndInput,
  success: IssueAttempt,
  error: IssueRpcError,
});
export const WsIssuesAttemptsResumeRpc = Rpc.make(ISSUES_WS_METHODS.issuesAttemptsResume, {
  payload: IssueAttemptsResumeInput,
  success: IssueAttempt,
  error: IssueRpcError,
});
