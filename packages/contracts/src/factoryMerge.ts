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
import { FactoryBoundaryId } from "./factoryBoundaries.ts";
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
export const FactoryMergeMemberReceipt = Schema.Struct({
  id: Id,
  operationId: Id,
  assignmentId: FactoryAssignmentId,
  revisionId: Id,
  ref: PullRequestRef,
  headSha: Id,
  targetBranch: Id,
  mergeCommitSha: Id,
  mergedAt: IsoDateTime,
  observedAt: IsoDateTime,
});
export type FactoryMergeMemberReceipt = typeof FactoryMergeMemberReceipt.Type;
export const FactoryMergeMemberOutcome = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("pending") }),
  Schema.Struct({
    phase: Schema.Literal("unknown"),
    attemptId: Id,
    submittedAt: IsoDateTime,
    reason: Schema.NullOr(Text),
  }),
  Schema.Struct({ phase: Schema.Literal("confirmed"), receipt: FactoryMergeMemberReceipt }),
]);
export type FactoryMergeMemberOutcome = typeof FactoryMergeMemberOutcome.Type;
export const FactoryMergeOperationMember = Schema.Struct({
  reviewed: FactoryMergeReviewMember,
  authority: Schema.Struct({
    boundaryId: FactoryBoundaryId,
    grantEpoch: NonNegativeInt,
    integrationGrantId: Id,
    capabilityId: Id,
    targetBranch: Id,
  }),
  attempts: NonNegativeInt.check(Schema.isLessThanOrEqualTo(3)),
  outcome: FactoryMergeMemberOutcome,
});
export type FactoryMergeOperationMember = typeof FactoryMergeOperationMember.Type;
export const FactoryMergeFrozenProof = Schema.Struct({
  integrationPreparationId: Id,
  integrationVerificationId: Id,
  inputDigest: Id,
  testArtifactDigest: Id,
  captureArtifactId: Id,
  captureDigest: Id,
  coordinatorCapabilityId: Id,
  coordinatorDigest: Id,
  integrationLeadThreadId: ThreadId,
  integrationGrantEpoch: NonNegativeInt,
  planIds: Schema.Array(Id),
  stoppedAt: IsoDateTime,
  digest: Id,
});
export type FactoryMergeFrozenProof = typeof FactoryMergeFrozenProof.Type;
const Recovery = Schema.Literals(["reconcile", "same-vector", "new-review", "none"]);
export const FactoryMergeOperation = Schema.Struct({
  id: Id,
  groupId: Id,
  integrationId: Id,
  integrationAssignmentId: FactoryAssignmentId,
  reviewId: Id,
  reviewDigest: Id,
  authorizingCommandId: CommandId,
  members: Schema.Array(FactoryMergeOperationMember).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(30),
  ),
  lifecycle: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("preparing") }),
    Schema.Struct({ phase: Schema.Literal("running"), frozen: FactoryMergeFrozenProof }),
    Schema.Struct({
      phase: Schema.Literal("attention"),
      frozen: Schema.NullOr(FactoryMergeFrozenProof),
      reason: Text,
      recommendation: Text,
      retry: Recovery,
    }),
    Schema.Struct({
      phase: Schema.Literal("stopped"),
      frozen: Schema.NullOr(FactoryMergeFrozenProof),
      reason: Text,
      stoppedAt: IsoDateTime,
    }),
    Schema.Struct({
      phase: Schema.Literal("completed"),
      frozen: FactoryMergeFrozenProof,
      receiptDigest: Id,
      completedAt: IsoDateTime,
    }),
  ]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryMergeOperation = typeof FactoryMergeOperation.Type;
export const FactoryMergeOperationReadiness = Schema.Struct({
  status: Schema.Literals([
    "idle",
    "preparing",
    "merging",
    "partial",
    "attention",
    "stopped",
    "completed",
  ]),
  confirmedCount: NonNegativeInt,
  memberCount: NonNegativeInt,
  reasons: Reasons,
  recommendation: Schema.NullOr(Text),
  canStart: Schema.Boolean,
  canReconcile: Schema.Boolean,
  canRetry: Schema.Boolean,
  canStop: Schema.Boolean,
});
export type FactoryMergeOperationReadiness = typeof FactoryMergeOperationReadiness.Type;
export const FactoryMergeGroupRead = Schema.Struct({
  group: FactoryMergeGroup,
  readiness: FactoryMergeGroupReadiness,
  currentReview: Schema.NullOr(FactoryMergeGroupReview),
  integrationLeadThreadId: ThreadId,
  operation: Schema.NullOr(FactoryMergeOperation),
  operationReadiness: FactoryMergeOperationReadiness,
});
export type FactoryMergeGroupRead = typeof FactoryMergeGroupRead.Type;
const Fields = { commandId: CommandId, groupId: Id };
export const FactoryMergeCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("merge.group.start"),
    ...Fields,
    reviewId: Id,
    expectedDigest: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("merge.operation.reconcile"),
    commandId: CommandId,
    operationId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("merge.operation.retry"),
    commandId: CommandId,
    operationId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("merge.operation.stop"),
    commandId: CommandId,
    operationId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("merge.operation.escalate"),
    commandId: CommandId,
    operationId: Id,
    reason: Text,
    recommendation: Text,
  }),
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
    type: Schema.Literal("merge.operation.frozen"),
    commandId: CommandId,
    operationId: Id,
    expectedStateRevision: NonNegativeInt,
    frozen: FactoryMergeFrozenProof,
  }),
  Schema.Struct({
    type: Schema.Literal("merge.operation.submitting"),
    commandId: CommandId,
    operationId: Id,
    assignmentId: FactoryAssignmentId,
    attemptId: Id,
    expectedAttempt: NonNegativeInt,
    expectedStateRevision: NonNegativeInt,
    evidenceDigest: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("merge.operation.observed"),
    commandId: CommandId,
    operationId: Id,
    assignmentId: FactoryAssignmentId,
    attemptId: Schema.optionalKey(Id),
    observation: Schema.Union([
      Schema.Struct({ phase: Schema.Literal("confirmed"), receipt: FactoryMergeMemberReceipt }),
      Schema.Struct({
        phase: Schema.Literal("open"),
        headSha: Id,
        targetBranch: Id,
        queued: Schema.Literal(false),
        observedAt: IsoDateTime,
      }),
      Schema.Struct({
        phase: Schema.Literal("rejected"),
        classification: Schema.Literals(["transient", "permanent"]),
        reason: Text,
        headSha: Id,
        targetBranch: Id,
        observedAt: IsoDateTime,
      }),
      Schema.Struct({ phase: Schema.Literal("unresolved"), reason: Text, observedAt: IsoDateTime }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("merge.operation.held"),
    commandId: CommandId,
    operationId: Id,
    reason: Text,
    recommendation: Text,
    retry: Recovery,
  }),
  Schema.Struct({
    type: Schema.Literal("merge.operation.completed"),
    commandId: CommandId,
    operationId: Id,
    receiptDigest: Id,
  }),
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
  Schema.Struct({ type: Schema.Literal("merge.operation.prepare"), operationId: Id }),
  Schema.Struct({ type: Schema.Literal("merge.operation.advance"), operationId: Id }),
  Schema.Struct({ type: Schema.Literal("merge.operation.reconcile"), operationId: Id }),
  Schema.Struct({ type: Schema.Literal("merge.operation.resume"), operationId: Id }),
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
