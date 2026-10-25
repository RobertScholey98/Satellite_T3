import {
  FactoryAskManagerInput,
  FactoryAssignment,
  FactoryClaimCompleteInput,
  FactoryCommissionInput,
  FactoryCompleteInput,
  FactoryCreateTeamFromDefinitionsInput,
  FactoryDefinitionsView,
  FactoryDelegateInput,
  FactoryDependency,
  FactoryDraftTicketInput,
  FactoryDraftTicketResult,
  FactoryFinding,
  FactoryFindingsListInput,
  FactoryManagerState,
  FactoryOnboardingDetected,
  FactoryOnboardingProposalInput,
  FactoryOperationError,
  FactoryPickupInput,
  FactoryRecordFindingInput,
  FactoryRecoverInput,
  FactoryReportDependencyInput,
  FactoryRole,
  FactoryRoleBrief,
  FactoryStatus,
  FactoryTeamDefinition,
  FactoryUpdateChecklistInput,
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
import { FactoryConfigStore } from "../config/FactoryConfigStore.ts";
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
  /** What Satellite read itself, so the manager sees the boards the user will choose from. */
  detected: FactoryOnboardingDetected,
  message: Schema.String,
});
export type ProposeOnboardingResult = typeof ProposeOnboardingResult.Type;

const ProposeOnboardingTool = Tool.make("factory_propose_onboarding", {
  description:
    "For an engineering manager that is onboarding. Submit your onboarding proposal: a short summary, the project's purpose, the control paths you propose to protect (glob patterns relative to the repository root that no team may edit, each with its reason), findings that need no decision, and whether pickup should be on with the guidance you would judge tickets by. Put each open choice in as a question with 2 to 4 options and the 0-based index of the one you recommend, with your reason; the user answers each one when they review the proposal. Do not report board columns or the default branch: Satellite detects them itself and returns what it found. Nothing is picked up until the user reviews and approves the proposal in Satellite. Call it again to revise it.",
  parameters: FactoryOnboardingProposalInput,
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

export const DefinitionsResult = Schema.Struct({
  ...FactoryDefinitionsView.fields,
  message: Schema.String,
});
export type DefinitionsResult = typeof DefinitionsResult.Type;

const DefinitionsTool = Tool.make("factory_definitions", {
  description:
    "For an engineering manager or a factory lead. Return the factory config: the model pool, the workers, leads and managers, and each team with its own copies of its lead and members, plus any definition file that could not be read. Only the user changes these definitions, in Satellite; never edit the factory config files directly.",
  parameters: Tool.EmptyParams,
  success: DefinitionsResult,
  failure: FactoryToolFailure,
  dependencies: [McpInvocationContext.McpInvocationContext, FactoryService, FactoryConfigStore],
})
  .annotate(Tool.Title, "Read factory definitions")
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
    "For an engineering manager. Return your capacity under the concurrency cap, your live assignments, the tickets in your pickup columns with no live assignment (each marked judged once you picked it up or skipped it as it is now), `pickupEnabled`, and the `pickupGuidance` the user approved at onboarding. No ticket is returned while `pickupEnabled` is false, or before the user starts pickup. Call it before judging tickets.",
  parameters: Tool.EmptyParams,
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
    "For an engineering manager. Judge one ticket from factory_status against your pickup guidance. `start` launches a lead on the ticket and needs a brief, a completion condition and a complexity that is not `large`; recommend a large ticket to the user instead. `skip` records your reason so the ticket is not offered again until it changes. The server re-checks the concurrency cap and that the ticket is still in one of your confirmed pickup columns, and refuses with a reason if either fails. While pickup is off, or before the user starts it, it refuses every ticket.",
  parameters: FactoryPickupInput,
  success: PickupResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Judge a pickup ticket")
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
    "For an engineering manager. Start an assignment the user asked for in this thread. It skips the pickup guidance and the rule against starting `large` tickets, but still respects the concurrency cap. Pass the number of a ticket in any Ready column of a connected board, not only your pickup columns, to work on it; without one the lead gets its own worktree on a new branch. Pass `dependencyId` to deliver an open dependency another lead reported; that start ignores the cap, because the blocked assignment already holds a slot. Pass `protectedPaths` to name the exact protected files the team must edit, with the reason; patterns and unprotected paths are refused. The user allows or declines them on the team's card, and no agent can grant them.",
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

const AskManagerTool = Tool.make("factory_ask_manager", {
  description:
    "For a factory lead. Send a question that needs the manager or the user to the manager's thread. Keep working on anything it does not block; the answer arrives in this thread.",
  parameters: FactoryAskManagerInput,
  success: AssignmentResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Ask the factory manager")
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
    'For an engineering manager. End an assignment in its retro once the team retro is done and you have drafted its tickets. Record whether the team was a good or poor fit for the work and why. Pass `teamRetro: "skipped"` only when the lead\'s thread is gone or the user took it over, so no team retro will come.',
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
  /** Absent for a follow-up, whose run is not a delegated task. */
  taskId: Schema.optionalKey(NodeId),
  childThreadId: ThreadId,
  role: FactoryRole,
  model: ModelSelection,
  message: Schema.String,
});
export type DelegateResult = typeof DelegateResult.Type;

const DelegateTool = Tool.make("factory_delegate", {
  description:
    "For a factory lead. Start a team member: a child thread that gets the role's skill, your assignment's completion condition and protected paths, then your task. The role must be on your assignment's team with a free place, and the model one the team allows for that role; leave the model out for the first one allowed. The child shares this worktree. To give a finished member more work in its own thread, set continueThreadId to that thread; it takes a place the same way. A new child's completion wakes this thread; use task_status with the returned taskId only when you need its result mid-turn.",
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
  team: FactoryTeamDefinition,
  message: Schema.String,
});
export type CreateTeamResult = typeof CreateTeamResult.Type;

const CreateTeamTool = Tool.make("factory_create_team", {
  description:
    "For an engineering manager. Add a team to the factory config, only after the user agreed to it in this thread. The team is built from copies of existing definitions: the lead by leadId (absent means the first lead) and each member from a worker by workerId, with its count and an optional member name, which defaults to the worker's name. Read the ids with factory_definitions. Every model the copies list must be in the model pool, and the name must not match an existing team. It returns the new team's id, which you pass as teamId. When your onboarding result names the teams you may use, a new team is not among them until the user adds its id; the result message says so. It cannot edit or remove teams; the user does that in Satellite.",
  parameters: FactoryCreateTeamFromDefinitionsInput,
  success: CreateTeamResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Add a factory team")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const RecordFindingResult = Schema.Struct({
  finding: FactoryFinding,
  message: Schema.String,
});
export type RecordFindingResult = typeof RecordFindingResult.Type;

const RecordFindingTool = Tool.make("factory_record_finding", {
  description:
    "For any member of a factory team, lead or worker. Record something you learned, with the evidence for it. Class `implementation` is about this assignment only; `project` is about the project's code, tests, docs or agent instructions; `reusable` is something the next team should reuse; `shared` affects other teams; `uncertain` is something you could not confirm, so say what is uncertain. Add a workaround if you used one. Set `escalate` only when the manager must decide now; otherwise the finding waits for the retro.",
  parameters: FactoryRecordFindingInput,
  success: RecordFindingResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Record a factory finding")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const FindingsResult = Schema.Struct({
  findings: Schema.Array(FactoryFinding),
  message: Schema.String,
});
export type FindingsResult = typeof FindingsResult.Type;

const FindingsTool = Tool.make("factory_findings", {
  description:
    "For an engineering manager or a factory lead. Return the findings recorded on an assignment, oldest first, each with its class, evidence and the ticket draft that took it up, if any. A manager can read any of its assignments; a lead only its own.",
  parameters: FactoryFindingsListInput,
  success: FindingsResult,
  failure: FactoryToolFailure,
  dependencies: [McpInvocationContext.McpInvocationContext, FactoryService],
})
  .annotate(Tool.Title, "Read factory findings")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RetroDoneTool = Tool.make("factory_retro_done", {
  description:
    "For a factory lead whose assignment is in its retro. End the team retro once you have retroed with your workers and recorded the findings with factory_record_finding. The manager is then woken for the manager retro; you have nothing more to do.",
  parameters: Tool.EmptyParams,
  success: AssignmentResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Finish the team retro")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const DraftTicketResult = Schema.Struct({
  ...FactoryDraftTicketResult.fields,
  message: Schema.String,
});
export type DraftTicketResult = typeof DraftTicketResult.Type;

const DraftTicketTool = Tool.make("factory_draft_ticket", {
  description:
    "For an engineering manager. Draft a ticket into Retro triage for the user. Scope `project` is for the app itself: its code, tests, docs and agent instructions. Scope `factory` is for how the factory works: the workflow, role skills, team presets and Satellite setup. Name the findings it takes up. A draft never reaches the board until the user approves it. Returns similar drafts and open tickets: when one covers the same work, do not draft it again, and tell the user in this thread which drafts to merge in triage.",
  parameters: FactoryDraftTicketInput,
  success: DraftTicketResult,
  failure: FactoryToolFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FactoryService,
  ],
})
  .annotate(Tool.Title, "Draft a factory ticket")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const FactoryToolkit = Toolkit.make(
  ProposeOnboardingTool,
  RoleBriefTool,
  DefinitionsTool,
  StatusTool,
  PickupTool,
  CommissionTool,
  ClaimCompleteTool,
  ReportDependencyTool,
  AskManagerTool,
  RecoverTool,
  CompleteTool,
  DelegateTool,
  UpdateChecklistTool,
  CreateTeamTool,
  RecordFindingTool,
  FindingsTool,
  RetroDoneTool,
  DraftTicketTool,
);
