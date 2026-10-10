import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { IssueAttemptLink } from "./issues.ts";
import {
  FactoryImprovementConfiguration,
  FactoryImprovementIntake,
  FactoryImprovementBatch,
  FactoryImprovementInvestigation,
  FactoryImprovementProposal,
  FactoryImprovementDecision,
  FactoryImprovementFeedback,
  FactoryImprovementRecurrence,
  FactoryImprovementEvidenceRead,
  FactoryImprovementCommand,
  FactoryImprovementHostCommand,
  FactoryImprovementEffectIntent,
} from "./factoryImprovements.ts";
import {
  FactorySchedulingConfiguration,
  FactoryScheduleCandidate,
  FactoryScheduleAuthority,
  FactorySchedulingCommand,
  FactorySchedulingHostCommand,
  FactorySchedulingEffectIntent,
} from "./factoryScheduling.ts";
import {
  FactoryModelChoice,
  FactoryModelPolicy,
  FactoryModelPolicyOverrides,
  FactoryTaskComplexity,
} from "./factoryModels.ts";
import { FactoryStartingSource } from "./factorySources.ts";
import {
  FactoryAssignmentCompletion,
  FactoryRetro,
  FactoryFinding,
  FactoryFollowup,
  FactoryProjectTracker,
  FactoryRetroCommand,
  FactoryRetroHostCommand,
  FactoryRetroEffectIntent,
} from "./factoryRetros.ts";
import {
  FactoryAssignmentDelivery,
  FactoryDeliveryCommand,
  FactoryDeliveryHostCommand,
  FactoryDeliveryEffectIntent,
  FactoryProjectMergeRule,
  FactoryApprovedPreviewConfiguration,
  FactoryPreviewPublicationPolicy,
} from "./factoryDelivery.ts";
import {
  FactoryAssignmentOversight,
  FactoryAuxiliaryThread,
  FactoryDependency,
  FactoryDependencyId,
  FactoryEvidence,
  FactoryExpectedWait,
  FactoryOversightCommand,
  FactoryOversightEffectIntent,
  FactoryOversightHostCommand,
  FactorySupportingWork,
} from "./factoryOversight.ts";
import {
  FactoryAssignmentId,
  FactoryControl,
  FactoryControlId,
  FactoryControlCommand,
  FactoryControlHostCommand,
  FactoryControlEffectIntent,
  FactoryGuidance,
} from "./factoryControls.ts";
export { FactoryAssignmentId } from "./factoryControls.ts";
export { FactoryAssignmentScope, FactoryEvidence } from "./factoryOversight.ts";

export const FactoryWorkflowVersion = Schema.Struct({
  repositoryRoot: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
});
export type FactoryWorkflowVersion = typeof FactoryWorkflowVersion.Type;

export const FactoryBoundaryId = TrimmedNonEmptyString.pipe(Schema.brand("FactoryBoundaryId"));
export type FactoryBoundaryId = typeof FactoryBoundaryId.Type;

export const FactoryGate = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  executable: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  cwd: TrimmedNonEmptyString,
  timeoutMs: NonNegativeInt,
  protectedInputs: Schema.Array(TrimmedNonEmptyString),
});
export type FactoryGate = typeof FactoryGate.Type;

export const FactoryBoundaryConfiguration = Schema.Struct({
  protectedPaths: Schema.Array(TrimmedNonEmptyString),
  writablePaths: Schema.Array(TrimmedNonEmptyString),
  creatableDirectories: Schema.Array(TrimmedNonEmptyString),
  gates: Schema.Array(FactoryGate),
});
export type FactoryBoundaryConfiguration = typeof FactoryBoundaryConfiguration.Type;

export const FactoryBoundary = Schema.Struct({
  ...FactoryBoundaryConfiguration.fields,
  id: FactoryBoundaryId,
  projectId: ProjectId,
  sourceRevision: TrimmedNonEmptyString,
  workflow: FactoryWorkflowVersion,
  profileId: TrimmedNonEmptyString,
  approvedAt: IsoDateTime,
});
export type FactoryBoundary = typeof FactoryBoundary.Type;

export const FactoryAssignmentGrant = Schema.Struct({
  boundaryId: FactoryBoundaryId,
  epoch: NonNegativeInt,
  sourcePaths: Schema.Array(TrimmedNonEmptyString),
  creatableDirectories: Schema.Array(TrimmedNonEmptyString),
  controlChange: Schema.NullOr(
    Schema.Struct({
      authorizationId: TrimmedNonEmptyString,
      paths: Schema.Array(TrimmedNonEmptyString),
    }),
  ),
});
export type FactoryAssignmentGrant = typeof FactoryAssignmentGrant.Type;

export const FactoryFileMutation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    path: TrimmedNonEmptyString,
    content: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("write"),
    path: TrimmedNonEmptyString,
    content: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("delete"), path: TrimmedNonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("rename"),
    path: TrimmedNonEmptyString,
    to: TrimmedNonEmptyString,
  }),
]);
export type FactoryFileMutation = typeof FactoryFileMutation.Type;

export const FactoryVerification = Schema.Struct({
  artifactId: TrimmedNonEmptyString,
  boundaryId: FactoryBoundaryId,
  epoch: NonNegativeInt,
  sourceDigest: TrimmedNonEmptyString,
  gates: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      status: Schema.Literals(["passed", "failed"]),
      exitCode: Schema.NullOr(Schema.Number),
      output: Schema.String,
    }),
  ),
  checkedAt: IsoDateTime,
});
export type FactoryVerification = typeof FactoryVerification.Type;

export const FactoryPolicy = Schema.Struct({
  delivery: Schema.Literals(["human-approval", "project-rule"]),
  projectImprovements: Schema.Literals(["create-tickets", "project-rule"]),
  sharedWorkflow: Schema.Literal("investigate-and-recommend"),
  authorizeRuleWeakening: Schema.Boolean,
  recoveryCycles: NonNegativeInt,
});
export type FactoryPolicy = typeof FactoryPolicy.Type;

export const FactoryPolicyOverrides = Schema.Struct({
  delivery: Schema.optionalKey(FactoryPolicy.fields.delivery),
  projectImprovements: Schema.optionalKey(FactoryPolicy.fields.projectImprovements),
  sharedWorkflow: Schema.optionalKey(FactoryPolicy.fields.sharedWorkflow),
  authorizeRuleWeakening: Schema.optionalKey(FactoryPolicy.fields.authorizeRuleWeakening),
  recoveryCycles: Schema.optionalKey(FactoryPolicy.fields.recoveryCycles),
});
export type FactoryPolicyOverrides = typeof FactoryPolicyOverrides.Type;

export const FactoryWait = Schema.Union([
  FactoryExpectedWait,
  Schema.Struct({
    kind: Schema.Literal("flow-review"),
    holdId: TrimmedNonEmptyString,
    artifactId: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literals(["execution-boundary", "authority", "recovery", "delivered"]),
    reason: TrimmedNonEmptyString,
  }),
]);
export type FactoryWait = typeof FactoryWait.Type;

export const FactoryOnboardingFinding = Schema.Struct({
  description: TrimmedNonEmptyString,
  evidence: Schema.Array(FactoryEvidence),
});

export const FactoryOnboardingReport = Schema.Struct({
  summary: TrimmedNonEmptyString,
  instructions: Schema.Array(FactoryOnboardingFinding),
  checks: Schema.Array(FactoryOnboardingFinding),
  tracker: FactoryOnboardingFinding,
  verificationTools: Schema.Array(FactoryOnboardingFinding),
  protectedControls: Schema.Array(FactoryOnboardingFinding),
  unresolvedDecisions: Schema.Array(FactoryOnboardingFinding),
  proposedBoundary: Schema.optionalKey(FactoryBoundaryConfiguration),
});
export type FactoryOnboardingReport = typeof FactoryOnboardingReport.Type;

export const FactoryDiscoveryQualification = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("qualified"),
    profileId: TrimmedNonEmptyString,
    checkedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: TrimmedNonEmptyString,
  }),
]);
export type FactoryDiscoveryQualification = typeof FactoryDiscoveryQualification.Type;

const FactoryManagerFields = {
  id: ThreadId,
  threadId: ThreadId,
  name: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  modelOverrides: Schema.optionalKey(FactoryModelPolicyOverrides),
  workflow: FactoryWorkflowVersion,
  overrides: FactoryPolicyOverrides,
  boundaryId: Schema.optionalKey(FactoryBoundaryId),
  status: Schema.Literals(["onboarding", "blocked", "active", "paused"]),
  threadStatus: Schema.Literals(["pending", "created"]),
  launchStatus: Schema.Literals(["pending", "delivered"]),
  wait: Schema.NullOr(FactoryWait),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

export const FactoryManager = Schema.Union([
  Schema.Struct({
    ...FactoryManagerFields,
    role: Schema.Literal("project"),
    projectId: ProjectId,
  }),
  Schema.Struct({
    ...FactoryManagerFields,
    role: Schema.Literal("system"),
    projectId: Schema.Null,
    workspaceProjectId: ProjectId,
    qualification: FactoryDiscoveryQualification,
  }),
]);
export type FactoryManager = typeof FactoryManager.Type;

const FactoryWorkRequestFields = {
  ...FactorySupportingWork.fields,
  managerId: ThreadId,
};

export const FactoryAssignment = Schema.Struct({
  id: FactoryAssignmentId,
  managerId: ThreadId,
  threadId: ThreadId,
  projectId: ProjectId,
  scheduling: Schema.optionalKey(
    Schema.Struct({
      candidateId: TrimmedNonEmptyString,
      authority: FactoryScheduleAuthority,
      issueAttempt: IssueAttemptLink,
    }),
  ),
  kind: Schema.Literals(["onboarding", "implementation", "rule-change"]),
  title: Schema.optionalKey(TrimmedNonEmptyString),
  scope: Schema.optionalKey(FactorySupportingWork.fields.scope),
  oversight: Schema.optionalKey(FactoryAssignmentOversight),
  delivery: Schema.optionalKey(FactoryAssignmentDelivery),
  completion: Schema.optionalKey(FactoryAssignmentCompletion),
  previousLeadThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  modelSelection: Schema.optionalKey(ModelSelection),
  modelPolicy: Schema.optionalKey(FactoryModelPolicy),
  modelChoice: Schema.optionalKey(FactoryModelChoice),
  complexity: Schema.optionalKey(FactoryTaskComplexity),
  startingSource: Schema.optionalKey(FactoryStartingSource),
  origin: Schema.optionalKey(Schema.Literals(["new", "handover"])),
  preparation: Schema.optionalKey(Schema.Literals(["stopping", "capturing", "preparing", "ready"])),
  verification: Schema.optionalKey(FactoryVerification),
  outcome: Schema.optionalKey(
    Schema.Struct({ kind: Schema.Literal("cancelled"), controlId: FactoryControlId }),
  ),
  authorization: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("human"), commandId: CommandId }),
      Schema.Struct({
        kind: Schema.Literal("manager"),
        commandId: CommandId,
        threadId: ThreadId,
        messageId: Schema.optionalKey(MessageId),
      }),
    ]),
  ),
  status: Schema.Literals(["pending", "running", "waiting", "complete"]),
  threadStatus: Schema.Literals(["pending", "created"]),
  launchStatus: Schema.Literals(["pending", "delivered"]),
  qualification: FactoryDiscoveryQualification,
  workflow: FactoryWorkflowVersion,
  grantedPolicy: FactoryPolicy,
  grant: Schema.optionalKey(FactoryAssignmentGrant),
  wait: Schema.NullOr(FactoryWait),
  report: Schema.NullOr(FactoryOnboardingReport),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryAssignment = typeof FactoryAssignment.Type;

export const FactorySnapshot = Schema.Struct({
  revision: NonNegativeInt,
  improvementConfigurations: Schema.Array(FactoryImprovementConfiguration).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  improvementIntakes: Schema.Array(FactoryImprovementIntake).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  improvementBatches: Schema.Array(FactoryImprovementBatch).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  improvementInvestigations: Schema.Array(FactoryImprovementInvestigation).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  improvementProposals: Schema.Array(FactoryImprovementProposal).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  improvementDecisions: Schema.Array(FactoryImprovementDecision).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  improvementFeedback: Schema.Array(FactoryImprovementFeedback).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  improvementRecurrences: Schema.Array(FactoryImprovementRecurrence).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  improvementEvidenceReads: Schema.Array(FactoryImprovementEvidenceRead).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  schedulingConfigurations: Schema.Array(FactorySchedulingConfiguration).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  scheduleCandidates: Schema.Array(FactoryScheduleCandidate).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  retros: Schema.Array(FactoryRetro).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  findings: Schema.Array(FactoryFinding).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  followups: Schema.Array(FactoryFollowup).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  projectTrackers: Schema.Array(FactoryProjectTracker).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  defaults: FactoryPolicy,
  modelDefaults: Schema.optionalKey(FactoryModelPolicy),
  managers: Schema.Array(FactoryManager),
  assignments: Schema.Array(FactoryAssignment),
  boundaries: Schema.Array(FactoryBoundary),
  controls: Schema.Array(FactoryControl).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  guidance: Schema.Array(FactoryGuidance).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  dependencies: Schema.Array(FactoryDependency).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  auxiliaryThreads: Schema.Array(FactoryAuxiliaryThread).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  mergeRules: Schema.Array(FactoryProjectMergeRule).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  previewConfigurations: Schema.Array(FactoryApprovedPreviewConfiguration).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  previewPublicationPolicies: Schema.Array(FactoryPreviewPublicationPolicy).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type FactorySnapshot = typeof FactorySnapshot.Type;

export const FactoryQuery = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
});
export type FactoryQuery = typeof FactoryQuery.Type;

export const FactoryCommand = Schema.Union([
  FactoryImprovementCommand,
  Schema.Struct({
    type: Schema.Literal("system.create"),
    commandId: CommandId,
    workspaceProjectId: ProjectId,
    name: Schema.optionalKey(TrimmedNonEmptyString),
    modelSelection: ModelSelection,
    workflow: FactoryWorkflowVersion,
  }),
  Schema.Struct({
    type: Schema.Literal("system.retry"),
    commandId: CommandId,
    managerId: ThreadId,
    modelSelection: Schema.optionalKey(ModelSelection),
    workflow: Schema.optionalKey(FactoryWorkflowVersion),
  }),
  FactorySchedulingCommand,
  FactoryRetroCommand,
  FactoryDeliveryCommand,
  FactoryControlCommand,
  FactoryOversightCommand,
  Schema.Struct({
    type: Schema.Literal("models.defaults.configure"),
    commandId: CommandId,
    policy: FactoryModelPolicy,
  }),
  Schema.Struct({
    type: Schema.Literal("manager.models.configure"),
    commandId: CommandId,
    managerId: ThreadId,
    overrides: FactoryModelPolicyOverrides,
  }),
  Schema.Struct({
    type: Schema.Literal("assignment.commission"),
    commandId: CommandId,
    ...FactoryWorkRequestFields,
    authorizationMessageId: Schema.optionalKey(MessageId),
    dependencyId: Schema.optionalKey(FactoryDependencyId),
    candidateId: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("assignment.handover"),
    commandId: CommandId,
    ...FactoryWorkRequestFields,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("assignment.retry"),
    commandId: CommandId,
    assignmentId: FactoryAssignmentId,
  }),
  Schema.Struct({
    type: Schema.Literal("assignment.file.mutate"),
    commandId: CommandId,
    assignmentId: FactoryAssignmentId,
    expectedEpoch: NonNegativeInt,
    operation: FactoryFileMutation,
  }),
  Schema.Struct({
    type: Schema.Literal("assignment.verify"),
    commandId: CommandId,
    assignmentId: FactoryAssignmentId,
    expectedEpoch: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("policy.defaults.configure"),
    commandId: CommandId,
    defaults: FactoryPolicy,
  }),
  Schema.Struct({
    type: Schema.Literal("assignments.extend-grant"),
    commandId: CommandId,
    assignmentIds: Schema.Array(FactoryAssignmentId),
  }),
  Schema.Struct({
    type: Schema.Literal("manager.approve-onboarding"),
    commandId: CommandId,
    managerId: ThreadId,
    configuration: FactoryBoundaryConfiguration,
  }),
  Schema.Struct({
    type: Schema.Literal("manager.create"),
    commandId: CommandId,
    projectId: ProjectId,
    name: Schema.optionalKey(TrimmedNonEmptyString),
    modelSelection: ModelSelection,
    workflow: FactoryWorkflowVersion,
  }),
  Schema.Struct({
    type: Schema.Literal("manager.configure"),
    commandId: CommandId,
    managerId: ThreadId,
    overrides: FactoryPolicyOverrides,
  }),
  Schema.Struct({
    type: Schema.Literal("manager.retry-onboarding"),
    commandId: CommandId,
    managerId: ThreadId,
    workflow: Schema.optionalKey(FactoryWorkflowVersion),
    modelSelection: Schema.optionalKey(ModelSelection),
  }),
  Schema.Struct({
    type: Schema.Literal("onboarding.report"),
    commandId: CommandId,
    assignmentId: FactoryAssignmentId,
    report: FactoryOnboardingReport,
  }),
]);
export type FactoryCommand = typeof FactoryCommand.Type;

export const FACTORY_WS_METHODS = {
  getSnapshot: "factory.getSnapshot",
  dispatchCommand: "factory.dispatchCommand",
  subscribe: "factory.subscribe",
} as const;

export const FactoryDispatchInput = Schema.Struct({ command: FactoryCommand });
export type FactoryDispatchInput = typeof FactoryDispatchInput.Type;

export const FactoryHostCommand = Schema.Union([
  FactoryImprovementHostCommand,
  Schema.Struct({
    type: Schema.Literal("system.launch.recorded"),
    commandId: CommandId,
    managerId: ThreadId,
    profileId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("system.launch.failed"),
    commandId: CommandId,
    managerId: ThreadId,
    profileId: TrimmedNonEmptyString,
    threadCreated: Schema.Boolean,
    reason: TrimmedNonEmptyString,
  }),
  FactorySchedulingHostCommand,
  FactoryRetroHostCommand,
  FactoryDeliveryHostCommand,
  FactoryControlHostCommand,
  FactoryOversightHostCommand,
  Schema.Struct({
    type: Schema.Literal("assignment.preparation.recorded"),
    commandId: CommandId,
    assignmentId: FactoryAssignmentId,
    threadId: ThreadId,
    stage: Schema.Literals(["capturing", "preparing"]),
    startingSource: Schema.optionalKey(FactoryStartingSource),
  }),
  Schema.Struct({
    type: Schema.Literal("assignment.prepared"),
    commandId: CommandId,
    assignmentId: FactoryAssignmentId,
    threadId: ThreadId,
    qualification: FactoryDiscoveryQualification,
    startingSource: FactoryStartingSource,
  }),
  Schema.Struct({
    type: Schema.Literal("assignment.prepare.failed"),
    commandId: CommandId,
    assignmentId: FactoryAssignmentId,
    threadId: ThreadId,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.launch.started"),
    commandId: CommandId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.launch.recorded"),
    commandId: CommandId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.launch.failed"),
    commandId: CommandId,
    threadId: ThreadId,
    reason: TrimmedNonEmptyString,
  }),
]);
export type FactoryHostCommand = typeof FactoryHostCommand.Type;

export const FactoryDecisionCommand = Schema.Union([FactoryCommand, FactoryHostCommand]);
export type FactoryDecisionCommand = typeof FactoryDecisionCommand.Type;

export const FactoryThreadLaunchIntent = Schema.Struct({
  type: Schema.Literal("thread.launch"),
  purpose: Schema.Literals(["manager", "onboarding", "implementation"]),
  threadId: ThreadId,
  managerId: ThreadId,
  assignmentId: FactoryAssignmentId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  workflow: FactoryWorkflowVersion,
  profileId: TrimmedNonEmptyString,
});
export type FactoryThreadLaunchIntent = typeof FactoryThreadLaunchIntent.Type;
export const FactoryEffectIntent = Schema.Union([
  FactoryImprovementEffectIntent,
  FactorySchedulingEffectIntent,
  FactoryRetroEffectIntent,
  FactoryDeliveryEffectIntent,
  FactoryControlEffectIntent,
  FactoryOversightEffectIntent,
  FactoryThreadLaunchIntent,
  Schema.Struct({
    type: Schema.Literal("assignment.prepare"),
    managerId: ThreadId,
    assignmentId: FactoryAssignmentId,
    threadId: ThreadId,
    projectId: ProjectId,
  }),
]);
export type FactoryEffectIntent = typeof FactoryEffectIntent.Type;

export const FactoryCommandResult = Schema.Struct({
  revision: NonNegativeInt,
  intakeId: Schema.optionalKey(TrimmedNonEmptyString),
  batchId: Schema.optionalKey(TrimmedNonEmptyString),
  investigationId: Schema.optionalKey(TrimmedNonEmptyString),
  proposalId: Schema.optionalKey(TrimmedNonEmptyString),
  proposalRevision: Schema.optionalKey(TrimmedNonEmptyString),
  candidateId: Schema.optionalKey(TrimmedNonEmptyString),
  retroId: Schema.optionalKey(TrimmedNonEmptyString),
  findingId: Schema.optionalKey(TrimmedNonEmptyString),
  followupId: Schema.optionalKey(TrimmedNonEmptyString),
  controlId: Schema.optionalKey(FactoryControlId),
  managerId: Schema.optionalKey(ThreadId),
  assignmentId: Schema.optionalKey(FactoryAssignmentId),
  dependencyId: Schema.optionalKey(FactoryDependencyId),
  auxiliaryThreadId: Schema.optionalKey(ThreadId),
  verification: Schema.optionalKey(FactoryVerification),
  deliveryRevisionId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type FactoryCommandResult = typeof FactoryCommandResult.Type;

export class FactoryError extends Schema.TaggedError<FactoryError>()("FactoryError", {
  detail: Schema.optionalKey(TrimmedNonEmptyString),
  code: Schema.Literals([
    "permission-denied",
    "project-already-managed",
    "manager-not-found",
    "assignment-not-found",
    "invalid-state",
    "command-conflict",
    "stale-revision",
    "persistence",
    "launch-failed",
    "execution-unavailable",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    if (this.detail !== undefined) return this.detail;
    switch (this.code) {
      case "permission-denied":
        return "This caller cannot make that engineering-management decision.";
      case "project-already-managed":
        return "This project already has an engineering manager. Open its existing manager instead.";
      case "manager-not-found":
        return "The engineering manager was not found.";
      case "assignment-not-found":
        return "The managed assignment was not found.";
      case "invalid-state":
        return "This action is not available in the assignment's current state.";
      case "command-conflict":
        return "This command ID was already used for a different request.";
      case "stale-revision":
        return "The evidence changed before this decision was recorded. Reconcile it again.";
      case "persistence":
        return "Could not read or save engineering-management state.";
      case "launch-failed":
        return "Could not start the managed thread. Its recorded work is available for retry.";
      case "execution-unavailable":
        return "This environment does not have a qualified execution boundary for this assignment.";
    }
  }
}
