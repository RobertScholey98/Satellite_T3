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
import {
  FactoryBoundaryConfiguration,
  FactoryBoundaryId,
  FactoryDiscoveryQualification,
  FactoryWorkflowVersion,
} from "./factoryBoundaries.ts";
import { FactorySupportingWork, FactoryWait } from "./factoryOversight.ts";
import { FactoryRetroEvidenceRef } from "./factoryRetros.ts";
import { FactoryStartingSource } from "./factorySources.ts";
import { FactoryModelPolicy, FactoryModelPolicyOverrides } from "./factoryModels.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(300));
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(6_000));
const AssignmentIds = Schema.Array(FactoryAssignmentId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
);

export const FactorySharedRepository = Schema.Struct({
  id: Id,
  managerId: ThreadId,
  projectId: ProjectId,
  kind: Schema.Literals(["skills", "workflow-tooling"]),
  repositoryRoot: TrimmedNonEmptyString,
  boundaryId: FactoryBoundaryId,
  enabled: Schema.Boolean,
  registeredAt: IsoDateTime,
});
export type FactorySharedRepository = typeof FactorySharedRepository.Type;

export const FactorySharedWorkPlan = Schema.Struct({
  proposalId: Id,
  proposalRevision: Id,
  repositoryId: Id,
  work: FactorySupportingWork,
  expectedBenefit: Text,
  assessmentApproach: Text,
  changesSkills: Schema.Boolean,
  weakensRules: Schema.Boolean,
});
export type FactorySharedWorkPlan = typeof FactorySharedWorkPlan.Type;
export const FactorySharedWork = Schema.Struct({
  id: Id,
  managerId: ThreadId,
  plan: FactorySharedWorkPlan,
  createdAt: IsoDateTime,
  notification: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ phase: Schema.Literal("pending") }),
      Schema.Struct({ phase: Schema.Literal("superseded") }),
      Schema.Struct({ phase: Schema.Literal("failed"), reason: Text }),
      Schema.Struct({
        phase: Schema.Literal("delivered"),
        messageId: MessageId,
        deliveredAt: IsoDateTime,
      }),
    ]),
  ),
  lifecycle: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("proposed") }),
    Schema.Struct({
      phase: Schema.Literal("authorized"),
      commandId: CommandId,
      authorizedAt: IsoDateTime,
    }),
    Schema.Struct({
      phase: Schema.Literal("commissioned"),
      commandId: CommandId,
      authorizedAt: IsoDateTime,
      assignmentId: FactoryAssignmentId,
    }),
    Schema.Struct({
      phase: Schema.Literal("revoked"),
      reason: Text,
      revokedAt: IsoDateTime,
      assignmentId: Schema.NullOr(FactoryAssignmentId),
    }),
  ]),
});
export type FactorySharedWork = typeof FactorySharedWork.Type;

export const FactoryExperimentSettings = Schema.Struct({
  enabled: Schema.Boolean,
  maxConcurrent: NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  maxPerInvestigation: NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
});
export type FactoryExperimentSettings = typeof FactoryExperimentSettings.Type;
export const FactoryExperimentConfiguration = Schema.Struct({
  ...FactoryExperimentSettings.fields,
  configuredAt: IsoDateTime,
  commandId: CommandId,
});
export type FactoryExperimentConfiguration = typeof FactoryExperimentConfiguration.Type;
export const FactoryWorkflowExperiment = Schema.Struct({
  id: Id,
  managerId: ThreadId,
  repositoryId: Id,
  investigationId: Id,
  assignmentId: FactoryAssignmentId,
  expectedBenefit: Text,
  assessmentApproach: Text,
  createdAt: IsoDateTime,
});
export type FactoryWorkflowExperiment = typeof FactoryWorkflowExperiment.Type;
export const FactorySharedAssignment = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("implementation"), repositoryId: Id, workId: Id }),
  Schema.Struct({ kind: Schema.Literal("experiment"), repositoryId: Id, experimentId: Id }),
]);
export type FactorySharedAssignment = typeof FactorySharedAssignment.Type;

export const FactoryWorkflowRelease = Schema.Struct({
  id: Id,
  repositoryId: Id,
  version: FactoryWorkflowVersion,
  snapshotDigest: Id,
  proposalId: Id,
  proposalRevision: Id,
  assignmentId: Schema.NullOr(FactoryAssignmentId),
  provenance: Schema.Literal("owned-codex-library"),
  baselineOrigin: Schema.Literal("pstack-codex-adaptation"),
  registeredAt: IsoDateTime,
});
export type FactoryWorkflowRelease = typeof FactoryWorkflowRelease.Type;
export const FactoryWorkflowAdoptionScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("default") }),
  Schema.Struct({
    kind: Schema.Literal("managers"),
    managerIds: Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
]);
export type FactoryWorkflowAdoptionScope = typeof FactoryWorkflowAdoptionScope.Type;
export const FactoryWorkflowAdoption = Schema.Struct({
  id: Id,
  /** Null resets the scope to each manager's own approved workflow. */
  releaseId: Schema.NullOr(Id),
  scope: FactoryWorkflowAdoptionScope,
  commandId: CommandId,
  adoptedAt: IsoDateTime,
});
export type FactoryWorkflowAdoption = typeof FactoryWorkflowAdoption.Type;
export const FactoryWorkflowOverride = Schema.Struct({ managerId: ThreadId, adoptionId: Id });
export type FactoryWorkflowOverride = typeof FactoryWorkflowOverride.Type;

export const FactoryWorkflowMigration = Schema.Struct({
  id: Id,
  assignmentId: FactoryAssignmentId,
  /** Null restores the team on its current pinned version. */
  releaseId: Schema.NullOr(Id),
  previousVersion: FactoryWorkflowVersion,
  previousEpoch: NonNegativeInt,
  /** The profile the team last ran in. A cancelled restart's retro inspects with it. */
  previousProfileId: Schema.optionalKey(TrimmedNonEmptyString),
  preparedEpoch: Schema.NullOr(NonNegativeInt),
  retainedAuthorityReason: Schema.NullOr(Text),
  previousState: Schema.Struct({
    status: Schema.Literals(["pending", "running", "waiting", "complete"]),
    wait: Schema.NullOr(FactoryWait),
  }),
  kind: Schema.Literals(["migration", "trial", "restore"]),
  reason: Text,
  commandId: CommandId,
  createdAt: IsoDateTime,
  lifecycle: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("stopping") }),
    Schema.Struct({ phase: Schema.Literal("preparing"), startingSource: FactoryStartingSource }),
    Schema.Struct({
      phase: Schema.Literal("failed"),
      step: Schema.Literals(["stop", "prepare"]),
      reason: Text,
      startingSource: Schema.NullOr(FactoryStartingSource),
    }),
    Schema.Struct({
      phase: Schema.Literal("ready"),
      completedAt: IsoDateTime,
      resume: Schema.Union([
        Schema.Struct({ phase: Schema.Literal("pending") }),
        Schema.Struct({ phase: Schema.Literal("failed"), reason: Text }),
        Schema.Struct({ phase: Schema.Literal("delivered"), deliveredAt: IsoDateTime }),
      ]),
    }),
  ]),
});
export type FactoryWorkflowMigration = typeof FactoryWorkflowMigration.Type;

export const FactoryImprovementValidation = Schema.Struct({
  id: Id,
  proposalId: Id,
  proposalRevision: Id,
  assignmentId: Schema.NullOr(FactoryAssignmentId),
  releaseId: Schema.NullOr(Id),
  outcome: Schema.Literals(["success", "failure", "insufficient-evidence"]),
  evidence: Schema.Array(FactoryRetroEvidenceRef).check(Schema.isMaxLength(100)),
  assessment: Text,
  recommendedNextStep: Text,
  recordedAt: IsoDateTime,
});
export type FactoryImprovementValidation = typeof FactoryImprovementValidation.Type;

export const FactoryModelRecommendationTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("default"), policy: FactoryModelPolicy }),
  Schema.Struct({
    kind: Schema.Literal("manager"),
    managerId: ThreadId,
    overrides: FactoryModelPolicyOverrides,
  }),
]);
export const FactoryModelRecommendation = Schema.Struct({
  id: Id,
  proposalId: Id,
  proposalRevision: Id,
  target: FactoryModelRecommendationTarget,
  rationale: Text,
  createdAt: IsoDateTime,
  applied: Schema.NullOr(Schema.Struct({ commandId: CommandId, appliedAt: IsoDateTime })),
  declined: Schema.optionalKey(
    Schema.Struct({ commandId: CommandId, reason: Text, declinedAt: IsoDateTime }),
  ),
});
export type FactoryModelRecommendation = typeof FactoryModelRecommendation.Type;

export const FactoryWorkflowCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("shared.repository.register"),
    commandId: CommandId,
    projectId: ProjectId,
    kind: FactorySharedRepository.fields.kind,
    configuration: FactoryBoundaryConfiguration,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.repository.configure"),
    commandId: CommandId,
    repositoryId: Id,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.work.propose"),
    commandId: CommandId,
    ...FactorySharedWorkPlan.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.work.authorize"),
    commandId: CommandId,
    workId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.work.notify.retry"),
    commandId: CommandId,
    workId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.work.commission"),
    commandId: CommandId,
    workId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.work.revoke"),
    commandId: CommandId,
    workId: Id,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("experiment.configure"),
    commandId: CommandId,
    ...FactoryExperimentSettings.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("experiment.commission"),
    commandId: CommandId,
    repositoryId: Id,
    investigationId: Id,
    work: FactorySupportingWork,
    expectedBenefit: Text,
    assessmentApproach: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.release.register"),
    commandId: CommandId,
    repositoryId: Id,
    revision: Id,
    proposalId: Id,
    proposalRevision: Id,
    assignmentId: FactoryAssignmentId,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.adopt"),
    commandId: CommandId,
    releaseId: Schema.NullOr(Id),
    scope: FactoryWorkflowAdoptionScope,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.override.clear"),
    commandId: CommandId,
    managerId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.restart"),
    commandId: CommandId,
    /** Omitted only for a restore, which keeps each team's current pinned version. */
    releaseId: Schema.optionalKey(Id),
    assignmentIds: AssignmentIds,
    kind: FactoryWorkflowMigration.fields.kind,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.restart.retry"),
    commandId: CommandId,
    migrationId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.restart.continue"),
    commandId: CommandId,
    migrationId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("improvement.validation.record"),
    commandId: CommandId,
    proposalId: Id,
    proposalRevision: Id,
    assignmentId: Schema.optionalKey(FactoryAssignmentId),
    releaseId: Schema.optionalKey(Id),
    outcome: FactoryImprovementValidation.fields.outcome,
    evidence: FactoryImprovementValidation.fields.evidence,
    assessment: Text,
    recommendedNextStep: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.models.recommend"),
    commandId: CommandId,
    proposalId: Id,
    proposalRevision: Id,
    target: FactoryModelRecommendationTarget,
    rationale: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.models.apply"),
    commandId: CommandId,
    recommendationId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.models.decline"),
    commandId: CommandId,
    recommendationId: Id,
    reason: Text,
  }),
]);
export type FactoryWorkflowCommand = typeof FactoryWorkflowCommand.Type;
export const FactoryWorkflowHostCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("workflow.work.notified"),
    commandId: CommandId,
    workId: Id,
    managerId: ThreadId,
    messageId: MessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.work.notify.failed"),
    commandId: CommandId,
    workId: Id,
    managerId: ThreadId,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.restart.stopped"),
    commandId: CommandId,
    migrationId: Id,
    expectedStateRevision: NonNegativeInt,
    startingSource: FactoryStartingSource,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.restart.prepared"),
    commandId: CommandId,
    migrationId: Id,
    expectedStateRevision: NonNegativeInt,
    qualification: FactoryDiscoveryQualification,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.restart.failed"),
    commandId: CommandId,
    migrationId: Id,
    step: Schema.Literals(["stop", "prepare", "resume"]),
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.restart.resumed"),
    commandId: CommandId,
    migrationId: Id,
    profileId: Id,
  }),
]);
export type FactoryWorkflowHostCommand = typeof FactoryWorkflowHostCommand.Type;
export const FactoryWorkflowEffectIntent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("workflow.work.notify"), workId: Id, managerId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("workflow.restart.stop"),
    migrationId: Id,
    assignmentId: FactoryAssignmentId,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.restart.prepare"),
    migrationId: Id,
    assignmentId: FactoryAssignmentId,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.restart.resume"),
    migrationId: Id,
    assignmentId: FactoryAssignmentId,
  }),
  Schema.Struct({
    type: Schema.Literal("workflow.revoke"),
    assignmentIds: AssignmentIds,
    reason: Text,
  }),
]);
export type FactoryWorkflowEffectIntent = typeof FactoryWorkflowEffectIntent.Type;
