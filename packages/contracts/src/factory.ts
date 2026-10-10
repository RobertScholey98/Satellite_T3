import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const FactoryAssignmentId = TrimmedNonEmptyString.pipe(Schema.brand("FactoryAssignmentId"));
export type FactoryAssignmentId = typeof FactoryAssignmentId.Type;

export const FactoryWorkflowVersion = Schema.Struct({
  repositoryRoot: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
});
export type FactoryWorkflowVersion = typeof FactoryWorkflowVersion.Type;

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

export const FactoryWait = Schema.Struct({
  kind: Schema.Literals(["execution-boundary", "human-decision"]),
  reason: TrimmedNonEmptyString,
});
export type FactoryWait = typeof FactoryWait.Type;

export const FactoryEvidence = Schema.Struct({
  label: TrimmedNonEmptyString,
  location: TrimmedNonEmptyString,
});
export type FactoryEvidence = typeof FactoryEvidence.Type;

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
  workflow: FactoryWorkflowVersion,
  overrides: FactoryPolicyOverrides,
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
  }),
]);
export type FactoryManager = typeof FactoryManager.Type;

export const FactoryAssignment = Schema.Struct({
  id: FactoryAssignmentId,
  managerId: ThreadId,
  threadId: ThreadId,
  projectId: ProjectId,
  kind: Schema.Literal("onboarding"),
  status: Schema.Literals(["pending", "running", "waiting", "complete"]),
  threadStatus: Schema.Literals(["pending", "created"]),
  launchStatus: Schema.Literals(["pending", "delivered"]),
  qualification: FactoryDiscoveryQualification,
  workflow: FactoryWorkflowVersion,
  grantedPolicy: FactoryPolicy,
  wait: Schema.NullOr(FactoryWait),
  report: Schema.NullOr(FactoryOnboardingReport),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryAssignment = typeof FactoryAssignment.Type;

export const FactorySnapshot = Schema.Struct({
  revision: NonNegativeInt,
  defaults: FactoryPolicy,
  managers: Schema.Array(FactoryManager),
  assignments: Schema.Array(FactoryAssignment),
});
export type FactorySnapshot = typeof FactorySnapshot.Type;

export const FactoryQuery = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
});
export type FactoryQuery = typeof FactoryQuery.Type;

export const FactoryCommand = Schema.Union([
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

export const FactoryEffectIntent = Schema.Struct({
  type: Schema.Literal("thread.launch"),
  purpose: Schema.Literals(["manager", "onboarding"]),
  threadId: ThreadId,
  managerId: ThreadId,
  assignmentId: FactoryAssignmentId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  workflow: FactoryWorkflowVersion,
  profileId: TrimmedNonEmptyString,
});
export type FactoryEffectIntent = typeof FactoryEffectIntent.Type;

export const FactoryCommandResult = Schema.Struct({
  revision: NonNegativeInt,
  managerId: Schema.optionalKey(ThreadId),
  assignmentId: Schema.optionalKey(FactoryAssignmentId),
});
export type FactoryCommandResult = typeof FactoryCommandResult.Type;

export class FactoryError extends Schema.TaggedError<FactoryError>()("FactoryError", {
  code: Schema.Literals([
    "permission-denied",
    "project-already-managed",
    "manager-not-found",
    "assignment-not-found",
    "invalid-state",
    "command-conflict",
    "persistence",
    "launch-failed",
    "execution-unavailable",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
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
      case "persistence":
        return "Could not read or save engineering-management state.";
      case "launch-failed":
        return "Could not start the managed thread. Its recorded work is available for retry.";
      case "execution-unavailable":
        return "This environment does not have a qualified execution boundary for this assignment.";
    }
  }
}
