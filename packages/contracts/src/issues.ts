import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  NonNegativeInt,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

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
export const IssueComment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  author: Schema.NullOr(IssueActor),
});
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
export const IssueBoardSummary = Schema.Struct({
  id: Id,
  projectId: ProjectId,
  title: Schema.String,
  locator: IssueBoardLocator,
  mapping: Schema.NullOr(IssueBoardMapping),
});
export type IssueBoardSummary = typeof IssueBoardSummary.Type;
export const IssueBoardItem = Schema.Struct({
  issue: IssueSummary,
  itemId: Id,
  columnId: Schema.NullOr(Id),
  version: Schema.NullOr(Schema.String),
});
export type IssueBoardItem = typeof IssueBoardItem.Type;
export const IssueAttemptLink = Schema.Struct({
  attemptId: Id,
  reservationId: Id,
  sourceEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  boardId: Id,
  issue: IssueRef,
  destinationEnvironmentId: EnvironmentId,
  sourceGeneration: NonNegativeInt,
});
export type IssueAttemptLink = typeof IssueAttemptLink.Type;
export const IssueAttempt = Schema.Struct({
  link: IssueAttemptLink,
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  worktreePath: Schema.NullOr(Schema.String),
  status: Schema.Literals(["reserved", "attached", "started", "failed"]),
  active: Schema.Boolean,
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  sourceGeneration: NonNegativeInt,
});
export type IssueAttempt = typeof IssueAttempt.Type;
export const IssueMoveReceipt = Schema.Struct({
  id: Id,
  boardId: Id,
  issue: IssueRef,
  columnId: Id,
  status: Schema.Literals(["pending", "applied", "failed", "superseded"]),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type IssueMoveReceipt = typeof IssueMoveReceipt.Type;
export const IssueBoardSyncFailure = Schema.Struct({ at: Schema.String, message: Schema.String });
export type IssueBoardSyncFailure = typeof IssueBoardSyncFailure.Type;
/**
 * Whether the board's environment is collecting updates from a worktree environment that runs
 * attempts on this board. `unregistered` means no credential was handed over, so updates from
 * that computer wait for a start from a client connected to both.
 */
export const IssueDeliveryPeer = Schema.Struct({
  destinationEnvironmentId: EnvironmentId,
  state: Schema.Literals([
    "pending",
    "delivered",
    "unreachable",
    "unauthorized",
    "failed",
    "unregistered",
    "expired",
  ]),
  lastDeliveredAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type IssueDeliveryPeer = typeof IssueDeliveryPeer.Type;
/** Freshness of the server's stored board copy. `syncing` and `failure` are independent facts. */
export const IssueBoardSync = Schema.Struct({
  /** Changes only when the board's columns, items, title or mapping changed. */
  revision: NonNegativeInt,
  /** Last successful read from the repository host. */
  syncedAt: Schema.String,
  /** A refresh is queued or running on the server. */
  syncing: Schema.Boolean,
  /** Outcome of the last finished refresh. */
  failure: Schema.NullOr(IssueBoardSyncFailure),
  /** Absent from servers that leave cross-environment delivery to clients. */
  deliveries: Schema.optionalKey(Schema.Array(IssueDeliveryPeer)),
});
export type IssueBoardSync = typeof IssueBoardSync.Type;
export const IssueBoardView = Schema.Struct({
  board: IssueBoardSummary,
  columns: Schema.Array(IssueBoardColumn),
  items: Schema.Array(IssueBoardItem),
  attempts: Schema.Array(IssueAttempt),
  moves: Schema.Array(IssueMoveReceipt),
  /** Absent from servers that predate stored boards; those always read the host live. */
  sync: Schema.optional(IssueBoardSync),
});
export type IssueBoardView = typeof IssueBoardView.Type;
export const IssuePullRequestKey = Schema.Struct({
  host: Id,
  repository: Id,
  number: Schema.Number,
});
export const IssueLifecycleReceipt = Schema.Struct({
  eventKey: Id,
  link: IssueAttemptLink,
  projectId: ProjectId,
  threadId: ThreadId,
  worktreePath: Schema.String,
  kind: Schema.Literals(["started", "pr-created", "pr-state-changed"]),
  pullRequest: Schema.optional(IssuePullRequestKey),
  state: Schema.optional(Schema.Literals(["open", "closed", "merged"])),
  createdAt: Schema.String,
  sourceGeneration: NonNegativeInt,
});
export type IssueLifecycleReceipt = typeof IssueLifecycleReceipt.Type;
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
export const IssueBoardsListInput = Schema.Struct({
  projectId: ProjectId,
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
  expectedPlacement: Schema.optional(Schema.NullOr(Id)),
  expectedVersion: Schema.optional(Schema.String),
});
export type IssueBoardsMoveInput = typeof IssueBoardsMoveInput.Type;
export const IssueMovesRetryInput = Schema.Struct({ requestId: Id, moveId: Id });
export type IssueMovesRetryInput = typeof IssueMovesRetryInput.Type;
export const IssueAttemptsReserveInput = Schema.Struct({
  requestId: Id,
  boardId: Id,
  issue: IssueRef,
  sourceEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId,
});
export type IssueAttemptsReserveInput = typeof IssueAttemptsReserveInput.Type;
export const IssueAttemptsListInput = Schema.Struct({
  boardId: Schema.optional(Id),
  issue: Schema.optional(IssueRef),
  threadId: Schema.optional(ThreadId),
});
export type IssueAttemptsListInput = typeof IssueAttemptsListInput.Type;
export const IssueAttemptsReceiptsInput = Schema.Struct({ after: Schema.optional(Schema.Number) });
export type IssueAttemptsReceiptsInput = typeof IssueAttemptsReceiptsInput.Type;
export const IssueAttemptsReceiptsResult = Schema.Struct({
  receipts: Schema.Array(IssueLifecycleReceipt),
  nextCursor: Schema.Number,
});
export type IssueAttemptsReceiptsResult = typeof IssueAttemptsReceiptsResult.Type;
export const IssueAttemptsAcknowledgeInput = Schema.Struct({
  acknowledgedKeys: Schema.Array(Schema.String),
});
export type IssueAttemptsAcknowledgeInput = typeof IssueAttemptsAcknowledgeInput.Type;
export const IssueAttemptGeneration = Schema.Struct({
  attemptId: Id,
  reservationId: Id,
  sourceGeneration: NonNegativeInt,
  /** The board environment's signature; a worktree environment requires it from a peer. */
  signature: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});
export type IssueAttemptGeneration = typeof IssueAttemptGeneration.Type;
export const IssueAttemptsSyncGenerationsInput = Schema.Struct({
  generations: Schema.Array(IssueAttemptGeneration).check(Schema.isMaxLength(100)),
});
export type IssueAttemptsSyncGenerationsInput = typeof IssueAttemptsSyncGenerationsInput.Type;
/**
 * Registers the worktree environment the board's environment collects lifecycle receipts from.
 * `credential` is the peer credential the destination granted; it never appears in a read model.
 */
export const IssuePeersRegisterInput = Schema.Struct({
  destinationEnvironmentId: EnvironmentId,
  credential: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  endpoints: Schema.Array(Id).check(Schema.isMaxLength(16)),
  /** The destination's identity key; an endpoint must prove it holds the private half. */
  publicKey: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  /** When the credential stops working; delivery stops contacting the destination then. */
  expiresAt: Schema.String,
});
export type IssuePeersRegisterInput = typeof IssuePeersRegisterInput.Type;
export const IssuePeersForgetInput = Schema.Struct({ destinationEnvironmentId: EnvironmentId });
export type IssuePeersForgetInput = typeof IssuePeersForgetInput.Type;
/** `revokedRemotely` is false when the worktree environment could not be told to drop access. */
export const IssuePeersForgetResult = Schema.Struct({ revokedRemotely: Schema.Boolean });
export type IssuePeersForgetResult = typeof IssuePeersForgetResult.Type;
export const IssueDeliveriesDeliverInput = Schema.Struct({ boardId: Id });
export type IssueDeliveriesDeliverInput = typeof IssueDeliveriesDeliverInput.Type;
/** Asks a worktree environment for a credential the board's environment collects receipts with. */
export const IssuePeersGrantInput = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /** Generations the board environment pushes must verify against this key. */
  sourcePublicKey: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
});
export type IssuePeersGrantInput = typeof IssuePeersGrantInput.Type;
/** Returned once. `endpoints` are the direct addresses the granting environment listens on. */
export const IssuePeerGrant = Schema.Struct({
  credential: TrimmedNonEmptyString,
  endpoints: Schema.Array(Id),
  publicKey: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  expiresAt: Schema.String,
});
export type IssuePeerGrant = typeof IssuePeerGrant.Type;
export const IssuePeerIdentity = Schema.Struct({
  publicKey: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
});
export type IssuePeerIdentity = typeof IssuePeerIdentity.Type;
