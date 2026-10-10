import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { IssueBoardLocator, IssueRef } from "./issues.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(6_000));
const Names = Schema.Array(Id).check(Schema.isMaxLength(30));

export const IssuePublicationDestination = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("github"),
    host: Id,
    repository: Id,
    triage: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("labels"),
        labels: Names.check(Schema.isMinLength(1)),
      }),
      Schema.Struct({
        kind: Schema.Literal("board"),
        boardId: Id,
        columnId: Id,
        labels: Names,
      }),
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("azure"),
    host: Id,
    organization: Id,
    project: Id,
    workItemType: Id,
    areaPath: Id,
    boardId: Id,
    columnId: Id,
    state: Id,
  }),
]);
export type IssuePublicationDestination = typeof IssuePublicationDestination.Type;

// The owning environment resolves credentials and board identity; agents select neither.
export const QualifiedIssueDestination = Schema.Struct({
  projectId: ProjectId,
  environmentId: EnvironmentId,
  credentialNamespace: Id,
  destination: IssuePublicationDestination,
  board: Schema.NullOr(IssueBoardLocator),
  validatedAt: IsoDateTime,
});
export type QualifiedIssueDestination = typeof QualifiedIssueDestination.Type;

export const IssuePublicationDraft = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  problem: Text,
  impact: Text,
  proposedOutcome: Text,
  acceptanceCriteria: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  evidence: Schema.Array(Schema.Struct({ summary: Text, url: Schema.NullOr(Id) })).check(
    Schema.isMaxLength(30),
  ),
  owner: Text,
  requiredAuthority: Text,
  suspectedCause: Text,
  origin: Schema.Struct({ assignmentId: Id, findingIds: Names }),
  containmentOf: Schema.NullOr(Id),
});
export type IssuePublicationDraft = typeof IssuePublicationDraft.Type;

export const IssuePublicationRequest = Schema.Struct({
  requestId: Id,
  projectId: ProjectId,
  destination: QualifiedIssueDestination,
  draft: IssuePublicationDraft,
});
export type IssuePublicationRequest = typeof IssuePublicationRequest.Type;

export const IssuePublicationProgress = Schema.Union([
  Schema.Struct({ status: Schema.Literal("reserved") }),
  Schema.Struct({ status: Schema.Literal("outcome-unknown"), reason: Text }),
  Schema.Struct({ status: Schema.Literal("created"), issue: IssueRef }),
  Schema.Struct({
    status: Schema.Literal("placement-pending"),
    issue: IssueRef,
    reason: Text,
  }),
  Schema.Struct({
    status: Schema.Literal("triaged"),
    issue: IssueRef,
    placement: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("labels"), labels: Names }),
      Schema.Struct({ kind: Schema.Literal("board"), itemId: Id, columnId: Id }),
    ]),
    verifiedAt: IsoDateTime,
  }),
  // Failure before any external identity is known. Unknown POST outcomes use outcome-unknown.
  Schema.Struct({ status: Schema.Literal("blocked"), reason: Text }),
]);
export type IssuePublicationProgress = typeof IssuePublicationProgress.Type;

export const IssuePublicationReceipt = Schema.Struct({
  requestId: Id,
  requestDigest: Id,
  destination: QualifiedIssueDestination,
  marker: Id,
  progress: IssuePublicationProgress,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type IssuePublicationReceipt = typeof IssuePublicationReceipt.Type;
