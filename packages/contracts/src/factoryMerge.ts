import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryAssignmentId } from "./factoryControls.ts";
import { FactoryRevisionHostEvidence } from "./factoryDelivery.ts";
import { FactoryEvidence } from "./factoryOversight.ts";
import { PullRequestRef } from "./pullRequest.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(6000));
const Reasons = Schema.Array(Text).check(Schema.isMaxLength(100));
export const FactoryMergeGroup = Schema.Struct({
  id: Id,
  integrationId: Id,
  integrationAssignmentId: FactoryAssignmentId,
  memberAssignmentIds: Schema.Array(FactoryAssignmentId).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(30),
  ),
  knownPullRequests: Schema.Array(
    Schema.Struct({ assignmentId: FactoryAssignmentId, ref: PullRequestRef }),
  ),
  currentReviewId: Schema.NullOr(Id),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryMergeGroup = typeof FactoryMergeGroup.Type;
export const FactoryMergeReviewMember = Schema.Struct({
  assignmentId: FactoryAssignmentId,
  projectId: ProjectId,
  leadThreadId: ThreadId,
  revisionId: Id,
  ref: PullRequestRef,
  headSha: Id,
  baseSha: Id,
  candidateDigest: Id,
  bundleDigest: Id,
  needsHuman: Schema.Boolean,
  ruleEligible: Schema.Boolean,
  ruleVersion: Schema.NullOr(NonNegativeInt),
});
export type FactoryMergeReviewMember = typeof FactoryMergeReviewMember.Type;
const Members = Schema.Array(FactoryMergeReviewMember).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(30),
);
export const FactoryMergeGroupReview = Schema.Struct({
  id: Id,
  groupId: Id,
  lifecycle: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("requested") }),
    Schema.Struct({ phase: Schema.Literal("failed"), reason: Text }),
    Schema.Struct({
      phase: Schema.Literal("sealed"),
      digest: Id,
      members: Members,
      integrationVerificationId: Id,
      integrationPreparationId: Id,
      inputDigest: Id,
      testArtifactDigest: Id,
      sealedAt: IsoDateTime,
    }),
  ]),
  decision: Schema.NullOr(
    Schema.Union([
      Schema.Struct({
        outcome: Schema.Literal("approved"),
        commandId: CommandId,
        decidedAt: IsoDateTime,
      }),
      Schema.Struct({
        outcome: Schema.Literal("changes-requested"),
        commandId: CommandId,
        reason: Text,
        decidedAt: IsoDateTime,
      }),
    ]),
  ),
  createdAt: IsoDateTime,
});
export type FactoryMergeGroupReview = typeof FactoryMergeGroupReview.Type;
export const FactoryMergeMemberReadiness = Schema.Struct({
  assignmentId: FactoryAssignmentId,
  projectId: ProjectId,
  leadThreadId: ThreadId,
  title: Schema.NullOr(Text),
  revisionId: Schema.NullOr(Id),
  ref: Schema.NullOr(PullRequestRef),
  headSha: Schema.NullOr(Id),
  bundleDigest: Schema.NullOr(Id),
  reasons: Reasons,
  needsHuman: Schema.Boolean,
  humanApproved: Schema.Boolean,
  ruleEligible: Schema.Boolean,
  hostEvidence: Schema.NullOr(FactoryRevisionHostEvidence),
  teamReview: Schema.NullOr(
    Schema.Struct({
      threadId: ThreadId,
      status: Schema.Literals(["pending", "running", "passed", "changes-requested", "failed"]),
      findings: Schema.NullOr(Text),
    }),
  ),
  screenshots: Schema.Array(FactoryEvidence),
  publishedScreenshotUrls: Schema.Array(TrimmedNonEmptyString),
});
export type FactoryMergeMemberReadiness = typeof FactoryMergeMemberReadiness.Type;
export const FactoryMergeGroupReadiness = Schema.Struct({
  groupId: Id,
  status: Schema.Literals(["waiting", "reviewing", "changes-requested", "ready"]),
  reasons: Reasons,
  reviewId: Schema.NullOr(Id),
  reviewDigest: Schema.NullOr(Id),
  members: Schema.Array(FactoryMergeMemberReadiness).check(Schema.isMaxLength(30)),
  integrationVerificationId: Schema.NullOr(Id),
  canApprove: Schema.Boolean,
  canRequestMerge: Schema.Boolean,
});
export type FactoryMergeGroupReadiness = typeof FactoryMergeGroupReadiness.Type;
export const FactoryMergeGroupRead = Schema.Struct({
  group: FactoryMergeGroup,
  readiness: FactoryMergeGroupReadiness,
  currentReview: Schema.NullOr(FactoryMergeGroupReview),
  integrationLeadThreadId: ThreadId,
});
export type FactoryMergeGroupRead = typeof FactoryMergeGroupRead.Type;
const Fields = { commandId: CommandId, groupId: Id };
export const FactoryMergeCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("merge.group.review"), ...Fields }),
  Schema.Struct({
    type: Schema.Literal("merge.group.approve"),
    ...Fields,
    reviewId: Id,
    expectedDigest: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("merge.group.reject"),
    ...Fields,
    reviewId: Id,
    expectedDigest: Id,
    reason: Text,
  }),
]);
export type FactoryMergeCommand = typeof FactoryMergeCommand.Type;
export const FactoryMergeHostCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("merge.group.inspected"),
    ...Fields,
    reviewId: Id,
    expectedStateRevision: NonNegativeInt,
    digest: Id,
    members: Members,
    integrationVerificationId: Id,
    integrationPreparationId: Id,
    inputDigest: Id,
    testArtifactDigest: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("merge.group.inspect.failed"),
    ...Fields,
    reviewId: Id,
    reason: Text,
  }),
]);
export const FactoryMergeEffectIntent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("merge.group.inspect"), groupId: Id, reviewId: Id }),
  Schema.Struct({
    type: Schema.Literal("merge.group.notify"),
    groupId: Id,
    eventId: Id,
    recipientAssignmentIds: Schema.Array(FactoryAssignmentId).check(Schema.isMaxLength(31)),
    text: Text,
  }),
]);

export const FactoryMergeGroupQuery = Schema.Struct({ groupId: Id });
export type FactoryMergeGroupQuery = typeof FactoryMergeGroupQuery.Type;
