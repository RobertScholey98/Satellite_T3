import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  RunAttemptId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryAssignmentId } from "./factoryControls.ts";
import { FactoryTaskComplexity } from "./factoryModels.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";
import { PullRequestRef } from "./pullRequest.ts";

export const FactoryDependencyId = TrimmedNonEmptyString.pipe(Schema.brand("FactoryDependencyId"));
export type FactoryDependencyId = typeof FactoryDependencyId.Type;

export const FactoryEvidence = Schema.Struct({
  label: TrimmedNonEmptyString,
  location: TrimmedNonEmptyString,
});
export type FactoryEvidence = typeof FactoryEvidence.Type;

export const FactoryAssignmentScope = Schema.Struct({
  description: TrimmedNonEmptyString,
  completionCondition: TrimmedNonEmptyString,
  requiresPullRequest: Schema.Boolean,
});
export type FactoryAssignmentScope = typeof FactoryAssignmentScope.Type;

export const FactorySupportingWork = Schema.Struct({
  title: TrimmedNonEmptyString,
  scope: FactoryAssignmentScope,
  complexity: FactoryTaskComplexity,
  kind: Schema.Literals(["implementation", "rule-change"]),
  sourcePaths: Schema.Array(TrimmedNonEmptyString),
  creatableDirectories: Schema.Array(TrimmedNonEmptyString),
  controlPaths: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type FactorySupportingWork = typeof FactorySupportingWork.Type;

export const FactoryUnblockCondition = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pull-request-merged"),
    projectId: ProjectId,
    ref: Schema.optionalKey(PullRequestRef),
    expectedHeadSha: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("report-delivered"),
    recipientThreadId: ThreadId,
    requirement: TrimmedNonEmptyString,
  }),
]);
export type FactoryUnblockCondition = typeof FactoryUnblockCondition.Type;

export const FactoryDeliveryEvidence = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pull-request-merged"),
    id: TrimmedNonEmptyString,
    projectId: ProjectId,
    ref: PullRequestRef,
    headSha: TrimmedNonEmptyString,
    mergedAt: IsoDateTime,
    observedAt: IsoDateTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("report-delivered"),
    id: TrimmedNonEmptyString,
    assignmentId: FactoryAssignmentId,
    recipientThreadId: ThreadId,
    messageId: MessageId,
    summary: TrimmedNonEmptyString,
    evidence: Schema.Array(FactoryEvidence),
    deliveredAt: IsoDateTime,
  }),
]);
export type FactoryDeliveryEvidence = typeof FactoryDeliveryEvidence.Type;

export const FactoryDeliveryClaim = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pull-request"), ref: PullRequestRef }),
  Schema.Struct({
    kind: Schema.Literal("report"),
    recipientThreadId: ThreadId,
    messageId: MessageId,
  }),
]);
export type FactoryDeliveryClaim = typeof FactoryDeliveryClaim.Type;

export const FactoryDependency = Schema.Struct({
  id: FactoryDependencyId,
  assignmentId: FactoryAssignmentId,
  description: TrimmedNonEmptyString,
  unblockCondition: FactoryUnblockCondition,
  requestedBy: ThreadId,
  evidence: Schema.Array(FactoryEvidence),
  state: Schema.Literals([
    "requested",
    "approved",
    "commissioned",
    "checking",
    "usable",
    "unusable",
  ]),
  supportingAssignmentId: Schema.optionalKey(FactoryAssignmentId),
  authorization: Schema.optionalKey(
    Schema.Struct({ commandId: CommandId, managerId: ThreadId, work: FactorySupportingWork }),
  ),
  delivery: Schema.optionalKey(FactoryDeliveryEvidence),
  usability: Schema.optionalKey(
    Schema.Struct({
      deliveryId: TrimmedNonEmptyString,
      usable: Schema.Boolean,
      evidence: Schema.Array(FactoryEvidence),
      checkedAt: IsoDateTime,
    }),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryDependency = typeof FactoryDependency.Type;

export const FactoryRecoveryEscalation = Schema.Struct({
  failure: TrimmedNonEmptyString,
  attempts: Schema.Array(TrimmedNonEmptyString),
  options: Schema.Array(TrimmedNonEmptyString),
  recommendation: TrimmedNonEmptyString,
});
export type FactoryRecoveryEscalation = typeof FactoryRecoveryEscalation.Type;

export const FactoryRecoveryIncident = Schema.Struct({
  id: TrimmedNonEmptyString,
  sourceRunId: Schema.optionalKey(RunId),
  sourceAttemptId: Schema.optionalKey(RunAttemptId),
  phase: Schema.Literals([
    "reconciling",
    "diagnosing",
    "replanning",
    "replacing",
    "continuing",
    "escalated",
  ]),
  reason: TrimmedNonEmptyString,
  evidence: Schema.Array(FactoryEvidence),
  diagnosisThreadId: Schema.optionalKey(ThreadId),
  replacementThreadId: Schema.optionalKey(ThreadId),
  replacementModelSelection: Schema.optionalKey(ModelSelection),
  plan: Schema.optionalKey(TrimmedNonEmptyString),
  escalation: Schema.optionalKey(FactoryRecoveryEscalation),
});
export type FactoryRecoveryIncident = typeof FactoryRecoveryIncident.Type;

export const FactoryAssignmentOversight = Schema.Struct({
  decisionPending: Schema.optionalKey(TrimmedNonEmptyString),
  progress: Schema.optionalKey(
    Schema.Struct({
      summary: TrimmedNonEmptyString,
      remainingWork: Schema.String,
      evidence: Schema.Array(FactoryEvidence),
      reportedAt: IsoDateTime,
    }),
  ),
  lastObservedRun: Schema.optionalKey(
    Schema.Struct({
      threadId: ThreadId,
      runId: RunId,
      attemptId: Schema.NullOr(RunAttemptId),
      status: OrchestrationV2RunStatus,
    }),
  ),
  deliveryClaim: Schema.optionalKey(FactoryDeliveryClaim),
  delivery: Schema.optionalKey(FactoryDeliveryEvidence),
  recovery: Schema.Struct({
    cyclesUsed: NonNegativeInt,
    incident: Schema.optionalKey(FactoryRecoveryIncident),
    history: Schema.Array(FactoryRecoveryIncident),
  }),
});
export type FactoryAssignmentOversight = typeof FactoryAssignmentOversight.Type;

const QualifiedProfile = Schema.Struct({
  status: Schema.Literal("qualified"),
  profileId: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
});
export const FactoryAuxiliaryThread = Schema.Struct({
  threadId: ThreadId,
  assignmentId: FactoryAssignmentId,
  managerId: ThreadId,
  projectId: ProjectId,
  kind: Schema.Literal("diagnosis"),
  incidentId: TrimmedNonEmptyString,
  cycle: NonNegativeInt,
  status: Schema.Literals(["pending", "running", "complete", "failed"]),
  modelSelection: ModelSelection,
  qualification: Schema.optionalKey(QualifiedProfile),
  sourceDigest: Schema.optionalKey(TrimmedNonEmptyString),
  findings: Schema.optionalKey(
    Schema.Struct({ summary: TrimmedNonEmptyString, evidence: Schema.Array(FactoryEvidence) }),
  ),
  failure: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryAuxiliaryThread = typeof FactoryAuxiliaryThread.Type;

export const FactoryExpectedWait = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("dependency"),
    dependencyIds: Schema.Array(FactoryDependencyId),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    ref: PullRequestRef,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal("human-decision"), reason: TrimmedNonEmptyString }),
]);
export type FactoryExpectedWait = typeof FactoryExpectedWait.Type;

const AssignmentCommandFields = { commandId: CommandId, assignmentId: FactoryAssignmentId };
const RecoveryCommandFields = { ...AssignmentCommandFields, incidentId: TrimmedNonEmptyString };
export const FactoryOversightCommand = Schema.Union([
  Schema.Struct({
    ...AssignmentCommandFields,
    type: Schema.Literal("assignment.progress"),
    summary: TrimmedNonEmptyString,
    remainingWork: Schema.String,
    evidence: Schema.Array(FactoryEvidence),
  }),
  Schema.Struct({
    ...AssignmentCommandFields,
    type: Schema.Literal("dependency.request"),
    dependencyId: FactoryDependencyId,
    description: TrimmedNonEmptyString,
    unblockCondition: FactoryUnblockCondition,
    evidence: Schema.Array(FactoryEvidence),
  }),
  Schema.Struct({
    ...AssignmentCommandFields,
    type: Schema.Literal("assignment.wait"),
    wait: FactoryExpectedWait,
  }),
  Schema.Struct({ ...AssignmentCommandFields, type: Schema.Literal("assignment.wait.resolve") }),
  Schema.Struct({
    type: Schema.Literal("dependency.approve"),
    commandId: CommandId,
    dependencyId: FactoryDependencyId,
    work: FactorySupportingWork,
  }),
  Schema.Struct({
    type: Schema.Literal("dependency.check-usability"),
    commandId: CommandId,
    dependencyId: FactoryDependencyId,
    deliveryId: TrimmedNonEmptyString,
    usable: Schema.Boolean,
    evidence: Schema.Array(FactoryEvidence),
  }),
  Schema.Struct({
    ...AssignmentCommandFields,
    type: Schema.Literal("assignment.delivery.request"),
    claim: FactoryDeliveryClaim,
  }),
  Schema.Struct({ ...RecoveryCommandFields, type: Schema.Literal("assignment.recovery.begin") }),
  Schema.Struct({
    type: Schema.Literal("auxiliary.report"),
    commandId: CommandId,
    threadId: ThreadId,
    summary: TrimmedNonEmptyString,
    evidence: Schema.Array(FactoryEvidence),
  }),
  Schema.Struct({
    ...RecoveryCommandFields,
    type: Schema.Literal("assignment.recovery.replan"),
    plan: TrimmedNonEmptyString,
    replaceLead: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...RecoveryCommandFields,
    type: Schema.Literal("assignment.recovery.escalate"),
    escalation: FactoryRecoveryEscalation,
  }),
]);
export type FactoryOversightCommand = typeof FactoryOversightCommand.Type;

export const FactoryReconciliationObservation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("active"), reason: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("expected-wait"), reason: TrimmedNonEmptyString }),
  Schema.Struct({
    kind: Schema.Literals(["outstanding", "ambiguous"]),
    reason: TrimmedNonEmptyString,
    evidence: Schema.Array(FactoryEvidence),
    runId: Schema.optionalKey(RunId),
    attemptId: Schema.optionalKey(RunAttemptId),
  }),
]);
export type FactoryReconciliationObservation = typeof FactoryReconciliationObservation.Type;

export const FactoryOversightHostCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("auxiliary.reconcile.requested"),
    commandId: CommandId,
    threadId: ThreadId,
    triggerId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("auxiliary.reconciled"),
    commandId: CommandId,
    threadId: ThreadId,
    triggerId: TrimmedNonEmptyString,
    observation: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("active") }),
      Schema.Struct({ kind: Schema.Literal("failed"), reason: TrimmedNonEmptyString }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("project.reconcile.requested"),
    commandId: CommandId,
    projectId: ProjectId,
    triggerId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...AssignmentCommandFields,
    type: Schema.Literal("assignment.run.observed"),
    threadId: ThreadId,
    runId: RunId,
    attemptId: Schema.NullOr(RunAttemptId),
    status: OrchestrationV2RunStatus,
  }),
  Schema.Struct({
    ...AssignmentCommandFields,
    type: Schema.Literal("assignment.reconcile.requested"),
    triggerId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...AssignmentCommandFields,
    type: Schema.Literal("assignment.reconciled"),
    triggerId: TrimmedNonEmptyString,
    observation: FactoryReconciliationObservation,
  }),
  Schema.Struct({
    commandId: CommandId,
    type: Schema.Literal("dependency.delivery.observed"),
    dependencyId: FactoryDependencyId,
    delivery: FactoryDeliveryEvidence,
  }),
  Schema.Struct({
    ...AssignmentCommandFields,
    type: Schema.Literal("assignment.delivery.recorded"),
    delivery: FactoryDeliveryEvidence,
  }),
  Schema.Struct({
    commandId: CommandId,
    type: Schema.Literal("auxiliary.started"),
    threadId: ThreadId,
    qualification: QualifiedProfile,
    sourceDigest: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    commandId: CommandId,
    type: Schema.Literal("auxiliary.prepared"),
    threadId: ThreadId,
    qualification: QualifiedProfile,
    sourceDigest: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    commandId: CommandId,
    type: Schema.Literal("auxiliary.failed"),
    threadId: ThreadId,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...RecoveryCommandFields,
    type: Schema.Literal("assignment.replacement.recorded"),
    threadId: ThreadId,
    previousThreadId: ThreadId,
    qualification: QualifiedProfile,
  }),
  Schema.Struct({
    ...RecoveryCommandFields,
    type: Schema.Literal("assignment.replacement.prepared"),
    threadId: ThreadId,
    previousThreadId: ThreadId,
    qualification: QualifiedProfile,
  }),
  Schema.Struct({
    ...RecoveryCommandFields,
    type: Schema.Literal("assignment.replacement.failed"),
    threadId: ThreadId,
    reason: TrimmedNonEmptyString,
  }),
]);
export type FactoryOversightHostCommand = typeof FactoryOversightHostCommand.Type;

export const FactoryOversightEffectIntent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("auxiliary.reconcile"),
    threadId: ThreadId,
    triggerId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("assignment.reconcile"),
    assignmentId: FactoryAssignmentId,
    triggerId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("auxiliary.launch"),
    assignmentId: FactoryAssignmentId,
    threadId: ThreadId,
    incidentId: TrimmedNonEmptyString,
    cycle: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("assignment.replace-lead"),
    assignmentId: FactoryAssignmentId,
    threadId: ThreadId,
    previousThreadId: ThreadId,
    incidentId: TrimmedNonEmptyString,
    modelSelection: ModelSelection,
  }),
]);
export type FactoryOversightEffectIntent = typeof FactoryOversightEffectIntent.Type;
