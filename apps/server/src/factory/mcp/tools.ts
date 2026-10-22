import {
  FactoryAssignment,
  FactoryClaimCompleteInput,
  FactoryCommissionInput,
  FactoryCompleteInput,
  FactoryCreateTeamInput,
  FactoryDelegateInput,
  FactoryDependency,
  FactoryManagerState,
  FactoryOnboardingReport,
  FactoryOperationError,
  FactoryPickupInput,
  FactoryRecoverInput,
  FactoryReportDependencyInput,
  FactoryRole,
  FactoryRoleBrief,
  FactoryStatus,
  FactoryTeamPreset,
  FactoryUpdateChecklistInput,
  FactoryWorkerRole,
  McpCapabilityUnavailableError,
  ModelSelection,
  NodeId,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { FactoryService } from "../FactoryService.ts";

export class FactoryToolFailedError extends Schema.TaggedError<FactoryToolFailedError>()(
  "FactoryToolFailedError",
  { reason: FactoryOperationError.fields.reason, message: Schema.String },
) {}

const FactoryToolFailure = Schema.Union([
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  FactoryToolFailedError,
]);

export const ProposeOnboardingResult = Schema.Struct({
  managerId: Schema.String,
  managerName: Schema.String,
  state: FactoryManagerState,
  controlPaths: Schema.Array(Schema.String),
  message: Schema.String,
});
export type ProposeOnboardingResult = typeof ProposeOnboardingResult.Type;

const ProposeOnboardingTool = Tool.make("factory_propose_onboarding", {
  description:
    "For an engineering manager that is onboarding. Submit your onboarding report: the control paths you propose to protect (glob patterns relative to the repository root that no team may edit), gaps in how the issue board maps to the factory, open choices the user needs to make, and a short summary. Nothing is picked up until the user approves the report in Satellite. Call it again to revise the report. After calling it, ask the user in this thread to review and approve it.",
  parameters: FactoryOnboardingReport,
  success: ProposeOnboardingResult,
  failure: FactoryToolFailure,
  // The access check loads the calling thread to confirm it still owns a live run.
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Propose factory onboarding")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const RoleBriefResult = Schema.Struct({
  ...FactoryRoleBrief.fields,
  message: Schema.String,
});
export type RoleBriefResult = typeof RoleBriefResult.Type;

const RoleBriefTool = Tool.make("factory_role_brief", {
  description:
    "Return the current filled-in role skill for an engineering factory role (manager, lead, implementer, reviewer or verifier). A manager can reread its own after the user edits it, and a lead can pass the right one to a worker.",
  parameters: Schema.Struct({ role: FactoryRole }),
  success: RoleBriefResult,
  failure: FactoryToolFailure,
  dependencies: [McpInvocationContext.McpInvocationContext, FactoryService],
})
  .annotate(Tool.Title, "Read factory role brief")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const StatusResult = Schema.Struct({
  ...FactoryStatus.fields,
  message: Schema.String,
});
export type StatusResult = typeof StatusResult.Type;

const StatusTool = Tool.make("factory_status", {
  description:
    "For an engineering manager. Return your capacity under the concurrency cap, your live assignments, the Ready tickets on connected boards with no live assignment (each marked judged once you picked it up or skipped it as it is now), and the project's pickup guidance. Call it before judging tickets.",
  parameters: Schema.Struct({}),
  success: StatusResult,
  failure: FactoryToolFailure,
  dependencies: [McpInvocationContext.McpInvocationContext, FactoryService],
})
  .annotate(Tool.Title, "Read factory status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const PickupResult = Schema.Struct({
  decision: FactoryPickupInput.fields.decision,
  assignment: Schema.NullOr(FactoryAssignment),
  message: Schema.String,
});
export type PickupResult = typeof PickupResult.Type;

const PickupTool = Tool.make("factory_pickup", {
  description:
    "For an engineering manager. Judge one Ready ticket against the pickup guidance from factory_status. `start` launches a lead on the ticket and needs a brief, a completion condition and a complexity that is not `large`; recommend a large ticket to the user instead. `skip` records your reason so the ticket is not offered again until it changes. The server re-checks the concurrency cap and that the ticket is still in a Ready column, and refuses with a reason if either fails.",
  parameters: FactoryPickupInput,
  success: PickupResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Judge a Ready ticket")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const CommissionResult = Schema.Struct({
  assignment: FactoryAssignment,
  message: Schema.String,
});
export type CommissionResult = typeof CommissionResult.Type;

const CommissionTool = Tool.make("factory_commission", {
  description:
    "For an engineering manager. Start an assignment the user asked for in this thread. It skips the pickup guidance and the rule against starting `large` tickets, but still respects the concurrency cap. Pass the number of a ticket in a Ready column to work on it; without one the lead gets its own worktree on a new branch. Pass `dependencyId` to deliver an open dependency another lead reported; that start ignores the cap, because the blocked assignment already holds a slot.",
  parameters: FactoryCommissionInput,
  success: CommissionResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Commission factory work")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const AssignmentResult = Schema.Struct({
  assignment: FactoryAssignment,
  message: Schema.String,
});
export type AssignmentResult = typeof AssignmentResult.Type;

const ClaimCompleteTool = Tool.make("factory_claim_complete", {
  description:
    "For a factory lead. Claim that your assignment's completion condition is met. Give the evidence: the checks you ran with their results and how each part of the condition is met. List the pull requests that deliver the work; each must already be linked on this thread. The user reviews and merges them; you never merge. The assignment moves to its retro once no pull request linked on this thread is still open.",
  parameters: FactoryClaimCompleteInput,
  success: AssignmentResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Claim factory assignment complete")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ReportDependencyResult = Schema.Struct({
  dependency: FactoryDependency,
  assignment: FactoryAssignment,
  message: Schema.String,
});
export type ReportDependencyResult = typeof ReportDependencyResult.Type;

const ReportDependencyTool = Tool.make("factory_report_dependency", {
  description:
    "For a factory lead. Record a blocker outside your assignment's scope: a short title, a brief for whoever delivers it, and the condition that unblocks you. The manager is told, and your assignment waits as `blocked` until that work is delivered. Do not widen your scope to get around it.",
  parameters: FactoryReportDependencyInput,
  success: ReportDependencyResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Report a factory dependency")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const RecoverTool = Tool.make("factory_recover", {
  description:
    "For an engineering manager. Recover a stalled assignment. `rebrief` sends your brief to the same lead; `replace` starts a new lead in the stalled lead's worktree and branch with the original brief plus yours. Each uses one recovery from the allowance. Once the allowance is spent, the assignment goes to the user instead, with your brief as the recommendation.",
  parameters: FactoryRecoverInput,
  success: AssignmentResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Recover a stalled assignment")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CompleteTool = Tool.make("factory_complete", {
  description:
    "For an engineering manager. End an assignment in its retro once you have read the lead's team retro. Record whether the team was a good or poor fit for the work and why.",
  parameters: FactoryCompleteInput,
  success: AssignmentResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Complete a factory assignment")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const DelegateResult = Schema.Struct({
  taskId: NodeId,
  childThreadId: ThreadId,
  role: FactoryWorkerRole,
  model: ModelSelection,
  message: Schema.String,
});
export type DelegateResult = typeof DelegateResult.Type;

const DelegateTool = Tool.make("factory_delegate", {
  description:
    "For a factory lead. Start a team member: a child thread that gets the role's skill, your assignment's completion condition and protected paths, then your task. The role must be on your assignment's team with a free place, and the model one the team allows for that role; leave the model out for the first one allowed. The child shares this worktree. Its completion wakes this thread; use task_status with the returned taskId only when you need its result mid-turn.",
  parameters: FactoryDelegateInput,
  success: DelegateResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
    OrchestratorMcpService.OrchestratorMcpService,
  ],
})
  .annotate(Tool.Title, "Start a factory team member")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ChecklistResult = Schema.Struct({
  checklist: FactoryAssignment.fields.checklist,
  message: Schema.String,
});
export type ChecklistResult = typeof ChecklistResult.Type;

const UpdateChecklistTool = Tool.make("factory_update_checklist", {
  description:
    "For a factory lead. Replace your assignment's checklist with the steps of your plan, each `done`, `in-progress` or `not-started`: at most 20 steps of at most 120 characters. The user sees it in Satellite; it never wakes the manager. Keep it to steps, not narration.",
  parameters: FactoryUpdateChecklistInput,
  success: ChecklistResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Update the factory checklist")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CreateTeamResult = Schema.Struct({
  preset: FactoryTeamPreset,
  message: Schema.String,
});
export type CreateTeamResult = typeof CreateTeamResult.Type;

const CreateTeamTool = Tool.make("factory_create_team", {
  description:
    "For an engineering manager. Add a team preset, only after the user agreed to it in this thread. Every model a member names must be in the model pool, and the name must not match an existing preset. It cannot edit or remove presets; the user does that in Satellite.",
  parameters: FactoryCreateTeamInput,
  success: CreateTeamResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Add a factory team preset")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const FactoryToolkit = Toolkit.make(
  ProposeOnboardingTool,
  RoleBriefTool,
  StatusTool,
  PickupTool,
  CommissionTool,
  ClaimCompleteTool,
  ReportDependencyTool,
  RecoverTool,
  CompleteTool,
  DelegateTool,
  UpdateChecklistTool,
  CreateTeamTool,
);
