import {
  FactoryCommandResult,
  FactoryDispatchInput,
  FactoryError,
  FactorySnapshot,
  OrchestratorMcpFailure,
  FactoryPreviewActionInput,
  FactoryPreviewActionResult,
  FactoryPreviewFinishInput,
  FactoryRevisionUxEvidence,
  PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as FactoryMcpGuard from "../../../factory/FactoryMcpGuard.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FactoryPreviewService } from "../../../factory/FactoryPreviewService.ts";

const dependencies = [
  FactoryMcpGuard.FactoryMcpGuard,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const failure = Schema.Union([FactoryError, OrchestratorMcpFailure]);
const previewDependencies = [...dependencies, FactoryPreviewService];
export const FactoryPreviewSnapshotTool = Tool.make("factory_preview_snapshot", {
  description:
    "Inspect the current independent review's isolated candidate app. Returns semantic page state and an actual PNG image; journals both against the immutable candidate and named journey. Use these locators for factory_preview_action. No external or user tab can be selected.",
  parameters: Schema.Struct({
    commandId: FactoryPreviewActionInput.fields.commandId,
    instanceId: FactoryPreviewActionInput.fields.instanceId,
    journey: FactoryPreviewActionInput.fields.journey,
  }),
  success: Schema.Struct({
    ...PreviewAutomationSnapshot.fields,
    sequence: FactoryPreviewActionResult.fields.sequence,
    receiptDigest: FactoryPreviewActionResult.fields.receiptDigest,
  }),
  failure,
  failureMode: "return",
  dependencies: previewDependencies,
}).annotate(Tool.Readonly, true);
export const FactoryPreviewSnapshotToolkit = Toolkit.make(FactoryPreviewSnapshotTool);

export const FactoryToolkit = Toolkit.make(
  Tool.make("factory_preview_action", {
    description:
      "Exercise a named journey in the independent review's isolated immutable candidate app. Paths are relative to that app; no arbitrary URL, browser tab, script evaluation, upload, or host access. Use factory_preview_snapshot for page inspection and PNG images.",
    parameters: FactoryPreviewActionInput.check(
      Schema.makeFilter(
        (input) =>
          input.action.type !== "snapshot" ||
          "Use factory_preview_snapshot to inspect the page and its screenshot.",
      ),
    ),
    success: FactoryPreviewActionResult,
    failure,
    failureMode: "return",
    dependencies: previewDependencies,
  }),
  Tool.make("factory_preview_finish", {
    description:
      "Seal host-recorded UX evidence for this independent candidate review. Every named journey needs actual navigation, inspection, interaction, and screenshots. This cannot attest arbitrary files or URLs. Finish this before delivery.review.report.",
    parameters: FactoryPreviewFinishInput,
    success: FactoryRevisionUxEvidence,
    failure,
    failureMode: "return",
    dependencies: previewDependencies,
  }),
  Tool.make("factory_snapshot", {
    description:
      "Read this managed thread's manager and assignment state. The server derives scope from your authenticated thread.",
    parameters: Tool.EmptyParams,
    success: FactorySnapshot,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("factory_dispatch", {
    description:
      "Submit a factory command as this authenticated managed thread. Managers commission scoped implementation assignments against a human request; authorizationMessageId selects that request, or defaults to their latest direct human message. Leads use scoped mutation/verification and declare all required PRs in assignment.completion.plan. Report evidenced problems immediately with finding.report; escalate shared causes with finding.escalate. After host-confirmed conclusion, the read-only retro lead submits retro.team.submit and its manager submits retro.manager.submit. followup.request creates project triage tickets without starting implementation. Human-only decisions cannot be made through this tool.",
    parameters: FactoryDispatchInput,
    success: FactoryCommandResult,
    failure,
    failureMode: "return",
    dependencies,
  }),
);
