import {
  FactoryAssignment,
  FactoryCommissionInput,
  FactoryManagerState,
  FactoryOnboardingReport,
  FactoryOperationError,
  FactoryPickupInput,
  FactoryRole,
  FactoryRoleBrief,
  FactoryStatus,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
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
    "For an engineering manager. Start an assignment the user asked for in this thread. It skips the pickup guidance and the rule against starting `large` tickets, but still respects the concurrency cap. In this version it needs the number of a ticket in a Ready column.",
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

export const FactoryToolkit = Toolkit.make(
  ProposeOnboardingTool,
  RoleBriefTool,
  StatusTool,
  PickupTool,
  CommissionTool,
);
