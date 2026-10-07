import {
  McpCapabilityUnavailableError,
  RevdocDetail,
  RevdocError,
  RevdocTestTarget,
  RevdocRecordTestInput,
  RevdocCaptureInput,
  RevdocTestStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as RevdocService from "../../../revdoc/RevdocService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, RevdocService.RevdocService];
const failure = Schema.Union([RevdocError, McpCapabilityUnavailableError]);
const ReadRevdoc = Tool.make("read_revdoc", {
  description:
    "Read the current worktree's .revdoc/review.json, including grouped tests, human outcomes, notes, and recorded evidence. Threads sharing a worktree share this review. Human feedback is not an instruction to mark tests complete.",
  success: RevdocDetail,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const RunRevdoc = Tool.make("run_revdoc", {
  description:
    "Start or resume a background to-rev-doc pass for this thread's worktree using the configured Revdoc model. Saves .revdoc/review.json as batches finish, preserving feedback. Interrupted passes reuse completed batches when the source and conversation are unchanged. Returns immediately; read_revdoc retrieves the partial or finished review. Does not run tests or approve work.",
  success: Schema.Void,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const CancelRevdoc = Tool.make("cancel_revdoc", {
  description:
    "Cancel this worktree's background Revdoc pass. Keeps the saved review and feedback.",
  success: Schema.Void,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const TestRevdoc = Tool.make("test_revdoc", {
  description:
    "Start a separate background testing thread for this worktree's review. Runs real checks and records AI results and Browser screenshots without changing human outcomes. Use remaining for untested, blocked, failed, or stale checks; failed to retry failures; all for every check. Optional testIds selects specific checks. Requires user authorization to run test commands and browser interactions.",
  parameters: Schema.Struct({
    selection: RevdocTestStartInput.fields.selection,
    testIds: RevdocTestStartInput.fields.testIds,
  }),
  success: Schema.Void,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const BeginTest = Tool.make("begin_revdoc_test", {
  description:
    "Mark a selected check running in the active Revdoc testing run. Only that run's assigned testing thread can report. Call before exercising the behavior.",
  parameters: RevdocTestTarget,
  success: Schema.Void,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const CaptureEvidence = Tool.make("capture_revdoc_evidence", {
  description:
    "Capture a real PNG screenshot from the testing thread's Browser tab and attach it to the active check. Call after actually reaching the relevant state; provide its tabId and a descriptive caption. Screenshot paths are assigned by the server. Requires Browser access.",
  parameters: RevdocCaptureInput,
  success: Schema.Void,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const RecordTest = Tool.make("record_revdoc_test", {
  description:
    "Save the active check's AI result independently of human review. Include actual steps or commands and observed behavior/output; use blocked for unexecuted checks with a specific reason. Browser passes require a screenshot captured in this run. Source or checklist edits invalidate the attempt. Only the assigned testing thread may report.",
  parameters: RevdocRecordTestInput,
  success: Schema.Void,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const RevdocToolkit = Toolkit.make(
  ReadRevdoc,
  RunRevdoc,
  CancelRevdoc,
  TestRevdoc,
  BeginTest,
  CaptureEvidence,
  RecordTest,
);
export const RevdocToolkitHandlersLive = RevdocToolkit.toLayer(
  Effect.gen(function* () {
    const revdoc = yield* RevdocService.RevdocService;
    return RevdocToolkit.of({
      read_revdoc: () =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireMcpCapability("documents");
          return yield* revdoc.get({ threadId: scope.threadId });
        }),
      run_revdoc: () =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireMcpCapability("documents");
          return yield* revdoc.start({ threadId: scope.threadId, action: "generate" });
        }),
      test_revdoc: (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireMcpCapability("documents");
          return yield* revdoc.startTesting({ ...input, threadId: scope.threadId });
        }),
      begin_revdoc_test: (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireMcpCapability("documents");
          return yield* revdoc.beginTest(scope, input);
        }),
      capture_revdoc_evidence: (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireMcpCapability("documents");
          return yield* revdoc.captureEvidence(scope, input);
        }),
      record_revdoc_test: (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireMcpCapability("documents");
          return yield* revdoc.recordTest(scope, input);
        }),
      cancel_revdoc: () =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireMcpCapability("documents");
          return yield* revdoc.cancel({ threadId: scope.threadId });
        }),
    });
  }),
);
