import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { toolGroupAction, workEntryDisplayIndicatesToolFailure } from "./presentation.ts";
import {
  providerErrorPresentation,
  turnItemLifecycleStatus,
  workLogEntryFromTurnItem,
} from "./workLogEntry.ts";
import { fixtureTime, projectedTurnItem, turnItemBase } from "./workLogTestFixtures.ts";

const entryOf = (item: OrchestrationV2TurnItem) =>
  workLogEntryFromTurnItem(projectedTurnItem(item));

describe("workLogEntryFromTurnItem", () => {
  it("lists every file a multi-file edit changed", () => {
    expect(
      entryOf({
        ...turnItemBase("edit-many"),
        type: "file_change",
        fileName: "src/a.ts",
        changes: [
          { path: "src/a.ts", operation: "update" },
          { path: "src/b.ts", operation: "add" },
          { path: "src/c.ts", operation: "delete" },
        ],
      }),
    ).toMatchObject({
      label: "Changed 3 files",
      changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      tone: "tool",
      toolTitle: "File change",
    });
    expect(
      entryOf({ ...turnItemBase("edit-one"), type: "file_change", fileName: "src/a.ts" }),
    ).toMatchObject({ label: "Changed src/a.ts", changedFiles: ["src/a.ts"] });
  });

  it("keeps an approval's request kind, which decides how its row groups", () => {
    const command = entryOf({
      ...turnItemBase("approve-command"),
      type: "approval_request",
      status: "waiting",
      requestId: RuntimeRequestId.make("request-1"),
      requestKind: "command",
      prompt: "Run rm -rf build?",
    });
    expect(command).toMatchObject({
      label: "Approval requested",
      detail: "Run rm -rf build?",
      requestKind: "command",
      tone: "tool",
      toolLifecycleStatus: "inProgress",
    });

    const fileRead = entryOf({
      ...turnItemBase("approve-read"),
      type: "approval_request",
      requestId: RuntimeRequestId.make("request-2"),
      requestKind: "file-read",
    });
    expect(fileRead).toMatchObject({ detail: "file-read", requestKind: "file-read" });
    expect(toolGroupAction(fileRead)).toBe("read");
  });

  it("shows the questions a pending request asks and the answers it got", () => {
    const question = {
      header: "Scope",
      question: "Which files?",
      options: [{ label: "All", description: "Every file" }],
    };
    expect(
      entryOf({
        ...turnItemBase("input"),
        type: "user_input_request",
        status: "waiting",
        requestId: RuntimeRequestId.make("request-3"),
        questions: [
          { ...question, id: "scope" },
          { id: "mode", header: "Mode", question: "Fast or safe?", options: [] },
        ],
      }),
    ).toMatchObject({
      label: "Input requested",
      detail: "Which files? · Fast or safe?",
      tone: "tool",
    });

    const questionAnswer = {
      requestId: "request-4",
      questionTextById: { scope: "Which files?" },
      answers: { scope: "All" },
      attachmentsByQuestionId: {},
    };
    expect(
      entryOf({
        ...turnItemBase("input-answered"),
        type: "user_input_request",
        requestId: RuntimeRequestId.make("request-4"),
        questions: [{ ...question, id: "scope" }],
        questionAnswer,
      }),
    ).toMatchObject({ label: "Answered questions", detail: "Which files?", questionAnswer });
  });

  it("tones a created thread as tool work", () => {
    expect(
      entryOf({
        ...turnItemBase("thread-created"),
        type: "thread_created",
        targetThreadId: ThreadId.make("thread-child"),
        targetRunId: null,
        targetProviderInstanceId: ProviderInstanceId.make("codex"),
        targetModel: "gpt-5",
      }),
    ).toMatchObject({ label: "Created thread", tone: "tool" });
  });

  it("names the activity behind compactions, notices, and provider errors", () => {
    const failure = {
      class: "provider_error" as const,
      message: "Boom",
      code: null,
      retryable: null,
    };
    const entries = [
      entryOf({
        ...turnItemBase("compaction"),
        type: "compaction",
        driver: null,
        summary: "Kept the plan",
        beforeTokenCount: 120_000,
        afterTokenCount: 20_000,
      }),
      entryOf({ ...turnItemBase("notice"), type: "system_notice", message: "Provider restarted" }),
      entryOf({ ...turnItemBase("error"), type: "error", status: "failed", failure }),
      entryOf({
        ...turnItemBase("usage"),
        type: "error",
        status: "failed",
        failure: { ...failure, class: "usage_limit", message: "Limit hit" },
      }),
      entryOf({
        ...turnItemBase("retry"),
        type: "error",
        status: "running",
        failure,
        retry: { attempt: 2, maxAttempts: 5, retryDelayMs: 1_500 },
      }),
    ];
    expect(
      entries.map(({ label, detail, sourceActivityKind }) => ({
        label,
        detail,
        sourceActivityKind,
      })),
    ).toEqual([
      {
        label: "Context compacted 120K → 20K tokens",
        detail: "Kept the plan",
        sourceActivityKind: "context-compaction",
      },
      { label: "Provider restarted", detail: undefined, sourceActivityKind: "runtime.warning" },
      { label: "Provider error", detail: "Boom", sourceActivityKind: "runtime.error" },
      { label: "Usage limit reached", detail: "Limit hit", sourceActivityKind: "runtime.warning" },
      {
        label: "Retrying provider (2/5)",
        detail: "Boom Retrying in 1.5s.",
        sourceActivityKind: undefined,
      },
    ]);
  });

  it("carries the command a command item ran", () => {
    expect(
      entryOf({
        ...turnItemBase("command"),
        type: "command_execution",
        input: "vp check",
        exitCode: 0,
      }),
    ).toMatchObject({
      label: "Ran command",
      command: "vp check",
      rawCommand: "vp check",
      toolTitle: "Command",
      tone: "tool",
      toolLifecycleStatus: "completed",
    });
  });

  it("previews items without a dedicated row and labels notifications by their summary", () => {
    expect(
      entryOf({ ...turnItemBase("interrupted"), type: "run_interrupt_result", message: "Stopped" }),
    ).toMatchObject({ label: "run interrupt result", detail: "Stopped", tone: "info" });
    expect(
      entryOf({
        ...turnItemBase("subagent"),
        type: "subagent",
        status: "running",
        subagentId: NodeId.make("node-subagent"),
        origin: "provider_native",
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claude"),
        childThreadId: null,
        prompt: "Investigate tests",
        progress: "Reading files",
        result: null,
      }),
    ).toMatchObject({ detail: "Reading files", tone: "tool", toolLifecycleStatus: "inProgress" });

    const notification = entryOf({
      ...turnItemBase("notification"),
      type: "notification",
      source: { kind: "background_task" },
      outcome: "completed",
      summary: "Build finished",
      detail: "All green",
    });
    expect(notification.label).toBe("Build finished");
    expect(notification.detail).toBeUndefined();
  });
});

describe("turnItemLifecycleStatus", () => {
  it.each([
    ["pending", "inProgress"],
    ["running", "inProgress"],
    ["waiting", "inProgress"],
    ["completed", "completed"],
    ["idle", "idle"],
    ["failed", "failed"],
    ["cancelled", "stopped"],
    ["interrupted", "stopped"],
  ] as const)("reads a %s item as %s", (status, lifecycle) => {
    expect(
      turnItemLifecycleStatus({
        ...turnItemBase("notice"),
        status,
        type: "system_notice",
        message: "notice",
      }),
    ).toBe(lifecycle);
  });
});

describe("providerErrorPresentation", () => {
  const retryItem = {
    ...turnItemBase("provider-retry", 1),
    status: "running" as const,
    title: "Provider retry",
    completedAt: null,
    type: "error" as const,
    failure: {
      class: "provider_error" as const,
      message: "Claude API overloaded.",
      code: "api_error_529",
      retryable: true,
    },
    retry: { attempt: 2, maxAttempts: 10, retryDelayMs: 1_500 },
  } satisfies Extract<OrchestrationV2TurnItem, { readonly type: "error" }>;

  it("labels provider retry progress, delay, recovery, and exhaustion", () => {
    expect(
      providerErrorPresentation({
        ...retryItem,
        status: "failed",
        failure: { ...retryItem.failure, class: "usage_limit" },
      }),
    ).toMatchObject({ label: "Usage limit reached after 2/10 retries" });
    expect(providerErrorPresentation(retryItem)).toEqual({
      label: "Retrying provider (2/10)",
      detail: "Claude API overloaded. Retrying in 1.5s.",
    });
    expect(
      providerErrorPresentation({ ...retryItem, status: "completed", completedAt: fixtureTime }),
    ).toMatchObject({ label: "Provider recovered (2/10 retries)" });
    expect(
      providerErrorPresentation({
        ...retryItem,
        status: "failed",
        retry: { ...retryItem.retry, attempt: 10 },
        completedAt: fixtureTime,
      }),
    ).toMatchObject({ label: "Provider error after 10/10 retries" });
  });

  it("does not mark a recovered usage limit as a warning or a failure", () => {
    const recovered = entryOf({
      ...retryItem,
      status: "completed",
      completedAt: fixtureTime,
      failure: { ...retryItem.failure, class: "usage_limit" },
    });
    expect(recovered.label).toBe("Provider recovered (2/10 retries)");
    expect(recovered.sourceActivityKind).toBeUndefined();
    expect(workEntryDisplayIndicatesToolFailure(recovered)).toBe(false);
  });
});
