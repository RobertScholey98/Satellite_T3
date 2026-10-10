import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryAssignmentId } from "./factoryControls.ts";
import { FactoryRetroEvidenceRef } from "./factoryRetros.ts";
import { FactoryInvestigationCursor } from "./factoryImprovementEvidence.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(6_000));
const Notes = Schema.String.check(Schema.isMaxLength(6_000));
const Ids = Schema.Array(Id).check(Schema.isMaxLength(100));
const bounded = (minimum: number, maximum: number) =>
  NonNegativeInt.check(Schema.isBetween({ minimum, maximum }));
export const FactoryImprovementSettings = Schema.Struct({
  enabled: Schema.Boolean,
  routineThreshold: bounded(1, 1_000),
  maxAgeHours: bounded(1, 168),
  sampleEvery: bounded(1, 100),
  maxBatchItems: bounded(1, 20),
  maxSummaryChars: bounded(1_000, 16_000),
  routineBatchesPerDay: bounded(0, 24),
});
export type FactoryImprovementSettings = typeof FactoryImprovementSettings.Type;
export const FactoryImprovementConfiguration = Schema.Struct({
  ...FactoryImprovementSettings.fields,
  id: Id,
  approvedBy: CommandId,
  approvedAt: IsoDateTime,
});
export type FactoryImprovementConfiguration = typeof FactoryImprovementConfiguration.Type;

export const FactoryImprovementIntake = Schema.Struct({
  id: Id,
  findingId: Id,
  sourceDigest: Id,
  projectId: ProjectId,
  assignmentId: FactoryAssignmentId,
  origin: Schema.Literals(["explicit-escalation", "retro"]),
  sampling: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("all") }),
    Schema.Struct({
      kind: Schema.Literal("local"),
      ordinal: NonNegativeInt,
      selected: Schema.Boolean,
    }),
  ]),
  summary: Text,
  queuedAt: IsoDateTime,
  delivery: Schema.Union([
    Schema.Struct({ phase: Schema.Literals(["skipped", "queued"]) }),
    Schema.Struct({ phase: Schema.Literal("batched"), batchId: Id }),
  ]),
});
export type FactoryImprovementIntake = typeof FactoryImprovementIntake.Type;

export const FactoryImprovementBatch = Schema.Struct({
  id: Id,
  managerId: ThreadId,
  kind: Schema.Literals(["urgent", "routine"]),
  intakeIds: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  digest: Id,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  budgetDay: Schema.NullOr(Id),
  createdAt: IsoDateTime,
  delivery: Schema.Union([
    Schema.Struct({ status: Schema.Literal("pending"), failure: Schema.optionalKey(Text) }),
    Schema.Struct({
      status: Schema.Literal("delivered"),
      messageId: MessageId,
      deliveredAt: IsoDateTime,
    }),
  ]),
});
export type FactoryImprovementBatch = typeof FactoryImprovementBatch.Type;

export const FactoryInvestigationLifecycle = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("open") }),
  Schema.Struct({ phase: Schema.Literals(["awaiting-evidence", "closed"]), reason: Text }),
]);
export const FactoryImprovementInvestigation = Schema.Struct({
  id: Id,
  title: Text,
  findingIds: Ids,
  relatedInvestigationIds: Ids,
  uncertainty: Notes,
  assessment: Notes,
  lifecycle: FactoryInvestigationLifecycle,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryImprovementInvestigation = typeof FactoryImprovementInvestigation.Type;

export const FactoryImprovementScope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("projects"),
    projectIds: Schema.Array(ProjectId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
  Schema.Struct({ kind: Schema.Literal("capability"), name: Text }),
  Schema.Struct({ kind: Schema.Literal("workflow"), components: Ids.check(Schema.isMinLength(1)) }),
]);
export const FactoryImprovementProposalContent = Schema.Struct({
  problem: Text,
  scope: FactoryImprovementScope,
  exclusions: Notes,
  expectedBenefit: Text,
  tradeoffs: Text,
  uncertainty: Text,
  requestedDecision: Text,
  assessmentApproach: Schema.NullOr(Text),
});
export type FactoryImprovementProposalContent = typeof FactoryImprovementProposalContent.Type;
export const FactoryImprovementProposal = Schema.Struct({
  id: Id,
  investigationId: Id,
  revision: Id,
  content: FactoryImprovementProposalContent,
  phase: Schema.Literals(["draft", "human-review", "decided"]),
  createdAt: IsoDateTime,
  submittedAt: Schema.NullOr(IsoDateTime),
});
export type FactoryImprovementProposal = typeof FactoryImprovementProposal.Type;
export const FactoryImprovementDecision = Schema.Struct({
  proposalId: Id,
  revision: Id,
  outcome: Schema.Literals(["accepted", "rejected", "deferred"]),
  reason: Text,
  commandId: CommandId,
  decidedAt: IsoDateTime,
});
export type FactoryImprovementDecision = typeof FactoryImprovementDecision.Type;
export const FactoryImprovementFeedback = Schema.Struct({
  id: Id,
  proposalId: Id,
  revision: Id,
  usefulness: Schema.Literals(["useful", "noisy", "unclear"]),
  reason: Text,
  recordedAt: IsoDateTime,
});
export type FactoryImprovementFeedback = typeof FactoryImprovementFeedback.Type;
export const FactoryImprovementRecurrence = Schema.Struct({
  id: Id,
  investigationId: Id,
  findingId: Id,
  reason: Text,
  recordedAt: IsoDateTime,
});
export type FactoryImprovementRecurrence = typeof FactoryImprovementRecurrence.Type;
const EvidenceReadFields = {
  managerId: ThreadId,
  investigationId: Id,
  findingId: Id,
  evidenceRef: FactoryRetroEvidenceRef,
  digest: Id,
  characters: bounded(0, 16_000),
  cursor: FactoryInvestigationCursor,
  limit: bounded(1, 16_000),
};
export const FactoryImprovementEvidenceRead = Schema.Struct({
  ...EvidenceReadFields,
  id: Id,
  projectId: ProjectId,
  assignmentId: FactoryAssignmentId,
  readAt: IsoDateTime,
});
export type FactoryImprovementEvidenceRead = typeof FactoryImprovementEvidenceRead.Type;

export const FactoryImprovementCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("improvement.configure"),
    commandId: CommandId,
    ...FactoryImprovementSettings.fields,
  }),
  Schema.Struct({ type: Schema.Literal("improvement.flush"), commandId: CommandId }),
  Schema.Struct({
    type: Schema.Literal("improvement.batch.retry"),
    commandId: CommandId,
    batchId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("investigation.open"),
    commandId: CommandId,
    title: Text,
    findingIds: Ids.check(Schema.isMinLength(1)),
    relatedInvestigationIds: Ids,
    uncertainty: Notes,
  }),
  Schema.Struct({
    type: Schema.Literal("investigation.update"),
    commandId: CommandId,
    investigationId: Id,
    findingIds: Ids.check(Schema.isMinLength(1)),
    relatedInvestigationIds: Ids,
    uncertainty: Notes,
    assessment: Notes,
    lifecycle: FactoryInvestigationLifecycle,
  }),
  Schema.Struct({
    type: Schema.Literal("proposal.write"),
    commandId: CommandId,
    proposalId: Schema.optionalKey(Id),
    investigationId: Id,
    content: FactoryImprovementProposalContent,
  }),
  Schema.Struct({
    type: Schema.Literal("proposal.submit"),
    commandId: CommandId,
    proposalId: Id,
    revision: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("proposal.decide"),
    commandId: CommandId,
    proposalId: Id,
    revision: Id,
    outcome: FactoryImprovementDecision.fields.outcome,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("proposal.feedback"),
    commandId: CommandId,
    proposalId: Id,
    revision: Id,
    usefulness: FactoryImprovementFeedback.fields.usefulness,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("investigation.recurrence"),
    commandId: CommandId,
    investigationId: Id,
    findingId: Id,
    reason: Text,
  }),
]);
export type FactoryImprovementCommand = typeof FactoryImprovementCommand.Type;
export const FactoryImprovementHostCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("improvement.batch.failed"),
    commandId: CommandId,
    batchId: Id,
    digest: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("improvement.evidence.read"),
    commandId: CommandId,
    ...EvidenceReadFields,
  }),
  Schema.Struct({
    type: Schema.Literal("improvement.intake"),
    commandId: CommandId,
    findingId: Id,
    origin: FactoryImprovementIntake.fields.origin,
    sourceDigest: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("improvement.batch.requested"),
    commandId: CommandId,
    kind: FactoryImprovementBatch.fields.kind,
    force: Schema.optionalKey(Schema.Boolean),
    expectedStateRevision: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("improvement.batch.delivered"),
    commandId: CommandId,
    batchId: Id,
    digest: Id,
    messageId: MessageId,
  }),
]);
export type FactoryImprovementHostCommand = typeof FactoryImprovementHostCommand.Type;
export const FactoryImprovementEffectIntent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("improvement.reconcile") }),
  Schema.Struct({
    type: Schema.Literal("improvement.notify"),
    batchId: Id,
    managerId: ThreadId,
    digest: Id,
  }),
  Schema.Struct({ type: Schema.Literal("system.launch"), managerId: ThreadId, profileId: Id }),
]);
export type FactoryImprovementEffectIntent = typeof FactoryImprovementEffectIntent.Type;
