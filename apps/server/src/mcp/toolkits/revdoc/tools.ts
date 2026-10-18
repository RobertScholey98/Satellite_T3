import {
  OrchestratorMcpFailure,
  RevdocAction,
  RevdocCaptureEvidenceInput,
  RevdocError,
  RevdocEvidence,
  RevdocItemDetail,
  RevdocItemId,
  RevdocItemSummary,
  RevdocPass,
  RevdocPassStarted,
  RevdocRecordResultInput,
  RevdocReviewHeader,
  RevdocTestSelection,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RevdocService from "../../../revdoc/RevdocService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const shared = {
  failure: Schema.Union([RevdocError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    RevdocService.RevdocService,
    PreviewAutomationBroker.PreviewAutomationBroker,
  ],
};

const target = {
  threadId: Schema.optionalKey(ThreadId).annotate({
    description: "The thread whose worktree's review to use. Defaults to the calling thread.",
  }),
  worktreePath: Schema.optionalKey(TrimmedNonEmptyString).annotate({
    description: "Another worktree of the same repository. Defaults to the thread's own.",
  }),
};

const RevdocReadTool = Tool.make("revdoc_read", {
  ...shared,
  description:
    "Read this worktree's Revdoc review: each check with the person's outcome and note, needs-retest and stale markers, and the latest AI result. Pass attentionOnly to get only broken, change-requested, failed, blocked, and needs-retest checks. Output is capped at 60 KB and says when it was truncated.",
  parameters: Schema.Struct({
    ...target,
    attentionOnly: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({
    review: Schema.NullOr(RevdocReviewHeader),
    activePass: Schema.NullOr(RevdocPass),
    items: Schema.Array(RevdocItemDetail),
    truncated: Schema.Boolean,
  }),
})
  .annotate(Tool.Title, "Read the Revdoc review")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RevdocGenerateTool = Tool.make("revdoc_generate", {
  ...shared,
  description:
    "Start a Revdoc generation pass that reconciles the review checklist with this worktree's current changes and conversation. Outcomes and notes stay on their checks. Returns the pass id; read the review when it finishes. action generate-and-test also starts AI testing afterwards.",
  parameters: Schema.Struct({ ...target, action: Schema.optionalKey(RevdocAction) }),
  success: RevdocPassStarted,
})
  .annotate(Tool.Title, "Generate the Revdoc review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const RevdocTestTool = Tool.make("revdoc_test", {
  ...shared,
  description:
    "Start an AI test pass of this worktree's Revdoc review as your delegated task. You are woken when it finishes; then read the review for results. selection remaining tests checks without a passing result or needing retest, failed retests failed and blocked checks, and items tests the given itemIds.",
  parameters: Schema.Struct({
    selection: RevdocTestSelection,
    itemIds: Schema.optionalKey(Schema.Array(RevdocItemId)),
  }),
  success: RevdocPassStarted,
})
  .annotate(Tool.Title, "Test the Revdoc review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const RevdocCancelTool = Tool.make("revdoc_cancel", {
  ...shared,
  description:
    "Cancel the running Revdoc pass for this worktree. A cancelled generation writes nothing more; a cancelled test keeps the results already recorded.",
  parameters: Schema.Struct(target),
  success: Schema.Struct({}),
})
  .annotate(Tool.Title, "Cancel the Revdoc pass")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RevdocRecordResultTool = Tool.make("revdoc_record_result", {
  ...shared,
  description:
    "For the Revdoc testing agent only. Record one check's result as soon as it finishes: state passed, failed, or blocked; method browser or command; the steps or commands run; and the observed behaviour. A browser pass needs evidence from revdoc_capture_evidence first.",
  parameters: RevdocRecordResultInput,
  success: RevdocItemSummary,
})
  .annotate(Tool.Title, "Record a Revdoc result")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RevdocCaptureEvidenceTool = Tool.make("revdoc_capture_evidence", {
  ...shared,
  description:
    "For the Revdoc testing agent only. Capture a screenshot of your browser preview tab (or the current tab) as evidence for one check. Fails with no_browser_host or browser_access_off when no browser can capture; then record the check as blocked with that reason.",
  parameters: RevdocCaptureEvidenceInput,
  success: RevdocEvidence,
})
  .annotate(Tool.Title, "Capture Revdoc evidence")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const RevdocToolkit = Toolkit.make(
  RevdocReadTool,
  RevdocGenerateTool,
  RevdocTestTool,
  RevdocCancelTool,
  RevdocRecordResultTool,
  RevdocCaptureEvidenceTool,
);
