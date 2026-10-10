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
import { FactoryEvidence } from "./factoryOversight.ts";
import { PullRequestRef } from "./pullRequest.ts";

export const FactoryDeliveryImpact = Schema.Struct({
  classification: Schema.Literals([
    "none",
    "established-pattern",
    "substantial-ui",
    "major-ui",
    "unclear",
  ]),
  changedFlows: Schema.Boolean,
  journeys: Schema.String,
  navigation: Schema.String,
  layout: Schema.String,
  sharedComponents: Schema.String,
  summary: TrimmedNonEmptyString,
  evidence: Schema.Array(FactoryEvidence),
});
export type FactoryDeliveryImpact = typeof FactoryDeliveryImpact.Type;

export const FactoryPreviewAppConfiguration = Schema.Struct({
  imageId: TrimmedNonEmptyString,
  executable: Schema.Literal("/usr/local/bin/node"),
  args: Schema.Array(Schema.String),
  port: NonNegativeInt,
  data: Schema.Literal("ephemeral"),
});
export type FactoryPreviewAppConfiguration = typeof FactoryPreviewAppConfiguration.Type;
export const FactoryApprovedPreviewConfiguration = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  configuration: FactoryPreviewAppConfiguration,
  approvedAt: IsoDateTime,
  authorizingCommandId: CommandId,
});
export type FactoryApprovedPreviewConfiguration = typeof FactoryApprovedPreviewConfiguration.Type;

export const FactoryPreviewPublicationPolicy = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
  approvedAt: IsoDateTime,
  authorizingCommandId: CommandId,
});

export const FactoryPublishedUxEvidence = Schema.Struct({
  operationsDigest: TrimmedNonEmptyString,
  commitOid: TrimmedNonEmptyString,
  urls: Schema.Array(TrimmedNonEmptyString),
});
export type FactoryPublishedUxEvidence = typeof FactoryPublishedUxEvidence.Type;

export const FactoryProjectMergeRule = Schema.Struct({
  projectId: ProjectId,
  version: NonNegativeInt,
  enabled: Schema.Boolean,
  kinds: Schema.Array(Schema.Literals(["implementation", "rule-change"])),
  allowedPaths: Schema.Array(TrimmedNonEmptyString),
  excludedPaths: Schema.Array(TrimmedNonEmptyString),
  allowEstablishedPatterns: Schema.Boolean,
  approvedAt: IsoDateTime,
  authorizingCommandId: CommandId,
});
export type FactoryProjectMergeRule = typeof FactoryProjectMergeRule.Type;

export const FactoryRevisionReview = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  candidateDigest: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "running", "passed", "changes-requested", "failed"]),
  confirmsImpact: Schema.optionalKey(Schema.Boolean),
  findings: Schema.optionalKey(TrimmedNonEmptyString),
  evidence: Schema.Array(FactoryEvidence),
});
export type FactoryRevisionReview = typeof FactoryRevisionReview.Type;

export const FactoryRevisionHostEvidence = Schema.Struct({
  headSha: TrimmedNonEmptyString,
  baseSha: TrimmedNonEmptyString,
  complete: Schema.Boolean,
  checks: Schema.Literals(["passed", "pending", "failed", "unknown"]),
  reviews: Schema.Literals(["passed", "pending", "failed", "unknown"]),
  mergeable: Schema.Boolean,
  conditionalMerge: Schema.Boolean,
  reasons: Schema.Array(TrimmedNonEmptyString),
  observedAt: IsoDateTime,
});
export type FactoryRevisionHostEvidence = typeof FactoryRevisionHostEvidence.Type;

export const FactoryRevisionUxEvidence = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  candidateDigest: TrimmedNonEmptyString,
  reviewThreadId: ThreadId,
  operationsDigest: TrimmedNonEmptyString,
  screenshots: Schema.Array(FactoryEvidence),
  journeys: Schema.Array(FactoryEvidence),
  observedAt: IsoDateTime,
});
export type FactoryRevisionUxEvidence = typeof FactoryRevisionUxEvidence.Type;

export const FactoryPublicationDestination = Schema.Struct({
  reservationId: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  treeOid: TrimmedNonEmptyString,
  ref: Schema.optionalKey(PullRequestRef),
});
export type FactoryPublicationDestination = typeof FactoryPublicationDestination.Type;

export const FactoryCandidateVerification = Schema.Struct({
  artifactId: TrimmedNonEmptyString,
  sourceDigest: TrimmedNonEmptyString,
  passed: Schema.Boolean,
  checkedAt: IsoDateTime,
});

export const FactoryDeliveryRevision = Schema.Struct({
  id: TrimmedNonEmptyString,
  operationId: TrimmedNonEmptyString,
  selectedPaths: Schema.Array(TrimmedNonEmptyString),
  commitMessage: TrimmedNonEmptyString,
  grantEpoch: NonNegativeInt,
  boundaryId: TrimmedNonEmptyString,
  workflowRevision: TrimmedNonEmptyString,
  startingSourceId: TrimmedNonEmptyString,
  candidateId: Schema.optionalKey(TrimmedNonEmptyString),
  candidateDigest: Schema.optionalKey(TrimmedNonEmptyString),
  status: Schema.Literals(["capturing", "captured", "publishing", "published", "failed"]),
  publication: Schema.optionalKey(FactoryPublicationDestination),
  verification: Schema.optionalKey(FactoryCandidateVerification),
  reviews: Schema.Array(FactoryRevisionReview),
  hostEvidence: Schema.optionalKey(FactoryRevisionHostEvidence),
  uxEvidence: Schema.optionalKey(FactoryRevisionUxEvidence),
  publishedUxEvidence: Schema.optionalKey(FactoryPublishedUxEvidence),
  preview: Schema.optionalKey(
    Schema.Struct({
      instanceId: TrimmedNonEmptyString,
      configurationId: TrimmedNonEmptyString,
      reviewId: TrimmedNonEmptyString,
      threadId: ThreadId,
      status: Schema.Literals(["starting", "ready", "stopping", "stopped", "failed"]),
      origin: Schema.optionalKey(TrimmedNonEmptyString),
      error: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
  bundleDigest: Schema.optionalKey(TrimmedNonEmptyString),
  approval: Schema.optionalKey(
    Schema.Struct({
      expectedHeadSha: TrimmedNonEmptyString,
      bundleDigest: TrimmedNonEmptyString,
      ruleVersion: Schema.NullOr(NonNegativeInt),
      authority: Schema.Literals(["human", "project-rule"]),
      commandId: CommandId,
      approvedAt: IsoDateTime,
    }),
  ),
  merge: Schema.optionalKey(
    Schema.Struct({
      operationId: TrimmedNonEmptyString,
      status: Schema.Literals(["requested", "unknown", "merged", "failed"]),
      requestedAt: IsoDateTime,
      mergedAt: Schema.optionalKey(IsoDateTime),
      reason: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
  error: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type FactoryDeliveryRevision = typeof FactoryDeliveryRevision.Type;

export const FactoryAssignmentDelivery = Schema.Struct({
  revisions: Schema.Array(FactoryDeliveryRevision),
  currentRevisionId: Schema.optionalKey(TrimmedNonEmptyString),
  impact: Schema.optionalKey(FactoryDeliveryImpact),
  directionHeld: Schema.Boolean,
  flow: Schema.optionalKey(
    Schema.Struct({
      holdId: TrimmedNonEmptyString,
      status: Schema.Literals(["stopping", "held", "releasing", "released"]),
      qualification: Schema.optionalKey(
        Schema.Struct({
          status: Schema.Literal("qualified"),
          profileId: TrimmedNonEmptyString,
          checkedAt: IsoDateTime,
        }),
      ),
      sourceDigest: Schema.optionalKey(TrimmedNonEmptyString),
      artifactId: Schema.optionalKey(TrimmedNonEmptyString),
      pendingArtifactId: Schema.optionalKey(TrimmedNonEmptyString),
      error: Schema.optionalKey(TrimmedNonEmptyString),
      artifactDigest: Schema.optionalKey(TrimmedNonEmptyString),
      artifact: Schema.optionalKey(
        Schema.Struct({
          title: TrimmedNonEmptyString,
          content: TrimmedNonEmptyString,
          format: Schema.Literals(["markdown", "html"]),
        }),
      ),
      decision: Schema.optionalKey(
        Schema.Struct({
          artifactDigest: TrimmedNonEmptyString,
          approved: Schema.Boolean,
          commandId: CommandId,
        }),
      ),
    }),
  ),
  readiness: Schema.Array(TrimmedNonEmptyString),
  retroFindings: Schema.Array(TrimmedNonEmptyString),
});
export type FactoryAssignmentDelivery = typeof FactoryAssignmentDelivery.Type;

const assignmentFields = { commandId: CommandId, assignmentId: FactoryAssignmentId };
const revisionFields = { ...assignmentFields, revisionId: TrimmedNonEmptyString };
export const FactoryDeliveryCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("delivery.preview.publication.configure"),
    commandId: CommandId,
    projectId: ProjectId,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.preview.configure"),
    commandId: CommandId,
    projectId: ProjectId,
    configuration: FactoryPreviewAppConfiguration,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.preview.start"),
    ...revisionFields,
    reviewId: TrimmedNonEmptyString,
    configurationId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.preview.stop"),
    ...revisionFields,
    instanceId: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("delivery.flow.retry"), ...assignmentFields }),
  Schema.Struct({ type: Schema.Literal("delivery.retry"), ...revisionFields }),
  Schema.Struct({
    type: Schema.Literal("delivery.rules.configure"),
    commandId: CommandId,
    projectId: ProjectId,
    enabled: Schema.Boolean,
    kinds: FactoryProjectMergeRule.fields.kinds,
    allowedPaths: FactoryProjectMergeRule.fields.allowedPaths,
    excludedPaths: FactoryProjectMergeRule.fields.excludedPaths,
    allowEstablishedPatterns: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.impact.declare"),
    ...assignmentFields,
    impact: FactoryDeliveryImpact,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.capture"),
    ...assignmentFields,
    expectedEpoch: NonNegativeInt,
    selectedPaths: Schema.Array(TrimmedNonEmptyString),
    commitMessage: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.publish"),
    ...revisionFields,
    title: TrimmedNonEmptyString,
    body: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("delivery.review.request"), ...revisionFields }),
  Schema.Struct({
    type: Schema.Literal("delivery.review.report"),
    ...revisionFields,
    reviewId: TrimmedNonEmptyString,
    verdict: Schema.Literals(["passed", "changes-requested"]),
    confirmsImpact: Schema.Boolean,
    findings: TrimmedNonEmptyString,
    evidence: Schema.Array(FactoryEvidence),
  }),
  Schema.Struct({ type: Schema.Literal("delivery.ready"), ...revisionFields }),
  Schema.Struct({
    type: Schema.Literal("delivery.approve"),
    ...revisionFields,
    expectedHeadSha: TrimmedNonEmptyString,
    bundleDigest: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("delivery.merge"), ...revisionFields }),
  Schema.Struct({ type: Schema.Literal("delivery.review.handback"), ...assignmentFields }),
  Schema.Struct({
    type: Schema.Literal("delivery.flow.submit"),
    ...assignmentFields,
    title: TrimmedNonEmptyString,
    content: TrimmedNonEmptyString,
    format: Schema.Literals(["markdown", "html"]),
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.flow.decide"),
    ...assignmentFields,
    artifactDigest: TrimmedNonEmptyString,
    approved: Schema.Boolean,
  }),
]);
export type FactoryDeliveryCommand = typeof FactoryDeliveryCommand.Type;

export const FactoryDeliveryHostCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("delivery.preview.recorded"),
    ...revisionFields,
    instanceId: TrimmedNonEmptyString,
    status: Schema.Literals(["ready", "stopped", "failed"]),
    origin: Schema.optionalKey(TrimmedNonEmptyString),
    error: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.flow.failed"),
    ...assignmentFields,
    holdId: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.review.prepared"),
    ...revisionFields,
    reviewId: TrimmedNonEmptyString,
    profileId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.captured"),
    ...revisionFields,
    candidateId: TrimmedNonEmptyString,
    candidateDigest: TrimmedNonEmptyString,
    publication: FactoryPublicationDestination,
    verification: FactoryCandidateVerification,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.published"),
    ...revisionFields,
    ref: PullRequestRef,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.inspected"),
    ...revisionFields,
    expectedStateRevision: Schema.Number,
    evidence: FactoryRevisionHostEvidence,
    bundleDigest: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.ux.recorded"),
    ...revisionFields,
    evidence: FactoryRevisionUxEvidence,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.ux.published"),
    ...revisionFields,
    evidence: FactoryPublishedUxEvidence,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.merge.recorded"),
    ...revisionFields,
    operationId: TrimmedNonEmptyString,
    status: Schema.Literals(["unknown", "merged", "failed"]),
    mergedAt: Schema.optionalKey(IsoDateTime),
    reason: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.effect.failed"),
    ...revisionFields,
    operationId: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.review.started"),
    ...revisionFields,
    reviewId: TrimmedNonEmptyString,
    profileId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.flow.recorded"),
    ...assignmentFields,
    holdId: TrimmedNonEmptyString,
    held: Schema.Boolean,
    qualification: Schema.optionalKey(
      Schema.Struct({
        status: Schema.Literal("qualified"),
        profileId: TrimmedNonEmptyString,
        checkedAt: IsoDateTime,
      }),
    ),
    sourceDigest: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.flow.artifact"),
    ...assignmentFields,
    holdId: TrimmedNonEmptyString,
    artifactId: TrimmedNonEmptyString,
    artifactDigest: TrimmedNonEmptyString,
    artifact: Schema.optionalKey(
      Schema.Struct({
        title: TrimmedNonEmptyString,
        content: TrimmedNonEmptyString,
        format: Schema.Literals(["markdown", "html"]),
      }),
    ),
  }),
]);
export type FactoryDeliveryHostCommand = typeof FactoryDeliveryHostCommand.Type;

export const FactoryDeliveryEffectIntent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("delivery.preview.start"),
    assignmentId: FactoryAssignmentId,
    revisionId: TrimmedNonEmptyString,
    instanceId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.preview.stop"),
    assignmentId: FactoryAssignmentId,
    revisionId: TrimmedNonEmptyString,
    instanceId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.capture"),
    assignmentId: FactoryAssignmentId,
    revisionId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.publish"),
    assignmentId: FactoryAssignmentId,
    revisionId: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
    body: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.review.launch"),
    assignmentId: FactoryAssignmentId,
    revisionId: TrimmedNonEmptyString,
    reviewId: TrimmedNonEmptyString,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.inspect"),
    assignmentId: FactoryAssignmentId,
    revisionId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.merge"),
    assignmentId: FactoryAssignmentId,
    revisionId: TrimmedNonEmptyString,
    operationId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.flow.hold"),
    assignmentId: FactoryAssignmentId,
    holdId: TrimmedNonEmptyString,
    held: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery.flow.capture"),
    assignmentId: FactoryAssignmentId,
    holdId: TrimmedNonEmptyString,
    artifactId: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
    content: TrimmedNonEmptyString,
    format: Schema.Literals(["markdown", "html"]),
  }),
]);
export type FactoryDeliveryEffectIntent = typeof FactoryDeliveryEffectIntent.Type;
