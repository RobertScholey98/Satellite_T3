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
export const IssueBoardView = Schema.Struct({
  board: IssueBoardSummary,
  columns: Schema.Array(IssueBoardColumn),
  items: Schema.Array(IssueBoardItem),
  attempts: Schema.Array(IssueAttempt),
  moves: Schema.Array(IssueMoveReceipt),
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
});
export type IssueBoardsOpenInput = typeof IssueBoardsOpenInput.Type;
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
export const IssueAttemptsIngestInput = Schema.Struct({
  receipts: Schema.Array(IssueLifecycleReceipt).check(Schema.isMaxLength(100)),
});
export type IssueAttemptsIngestInput = typeof IssueAttemptsIngestInput.Type;
export const IssueAttemptsIngestResult = Schema.Struct({
  acknowledgedKeys: Schema.Array(Schema.String),
});
export type IssueAttemptsIngestResult = typeof IssueAttemptsIngestResult.Type;
export const IssueAttemptsAcknowledgeInput = IssueAttemptsIngestResult;
export type IssueAttemptsAcknowledgeInput = typeof IssueAttemptsAcknowledgeInput.Type;
export const IssueAttemptGeneration = Schema.Struct({
  attemptId: Id,
  reservationId: Id,
  sourceGeneration: NonNegativeInt,
});
export type IssueAttemptGeneration = typeof IssueAttemptGeneration.Type;
export const IssueAttemptsSyncGenerationsInput = Schema.Struct({
  generations: Schema.Array(IssueAttemptGeneration).check(Schema.isMaxLength(100)),
});
export type IssueAttemptsSyncGenerationsInput = typeof IssueAttemptsSyncGenerationsInput.Type;
