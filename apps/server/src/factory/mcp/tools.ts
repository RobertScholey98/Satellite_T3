import {
  FactoryManagerState,
  FactoryOnboardingReport,
  FactoryOperationError,
  FactoryRole,
  FactoryRoleBrief,
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

export const FactoryToolkit = Toolkit.make(ProposeOnboardingTool, RoleBriefTool);
