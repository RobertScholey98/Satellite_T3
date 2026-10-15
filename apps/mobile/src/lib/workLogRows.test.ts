import { MessageId, RunId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { summarizeToolGroup } from "@t3tools/client-runtime/work-log/presentation";
import {
  projectedTurnItem,
  turnItemBase,
  workLogScenario,
} from "@t3tools/client-runtime/work-log/test-fixtures";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadFeed,
  deriveThreadFeedPresentation,
  workEntryRowLabel,
  type ThreadFeedLatestRun,
} from "./threadActivity";

interface Row {
  readonly label: string;
  readonly heading: string;
  readonly detail: string | null;
  readonly tone: string;
  readonly status: string | null;
  readonly group: string;
}

function renderedRows(): Record<string, Row> {
  const rows: Record<string, Row> = {};
  for (const entry of buildThreadFeed(workLogScenario)) {
    if (entry.type !== "activity-group") continue;
    for (const activity of entry.activities) {
      rows[activity.workEntry.id] = {
        label: activity.summary,
        heading: workEntryRowLabel(activity.workEntry),
        detail: activity.detail,
        tone: activity.workEntry.tone,
        status: activity.status,
        group: summarizeToolGroup([activity.workEntry]).summary,
      };
    }
  }
  return rows;
}

// Rows as mobile rendered them before web and mobile shared one work-log mapper.
const baseRows = {
  "edit-one": {
    label: "Changed src/a.ts",
    heading: "src/a.ts",
    detail: "src/a.ts",
    tone: "tool",
    status: "success",
    group: "Changed 1 file",
  },
  "edit-many": {
    label: "Changed 3 files",
    heading: "src/a.ts",
    detail: "src/a.ts",
    tone: "tool",
    status: "success",
    group: "Changed 1 file",
  },
  "approve-command": {
    label: "Approval requested",
    heading: "Approval requested",
    detail: null,
    tone: "info",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-command-prompt": {
    label: "Approval requested",
    heading: "Allow command?",
    detail: "Allow command?",
    tone: "info",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-file-read": {
    label: "Approval requested",
    heading: "Approval requested",
    detail: null,
    tone: "info",
    status: "success",
    group: "Read 1 file",
  },
  "approve-file-read-prompt": {
    label: "Approval requested",
    heading: "Allow file-read?",
    detail: "Allow file-read?",
    tone: "info",
    status: "success",
    group: "Read 1 file",
  },
  "approve-file-change": {
    label: "Approval requested",
    heading: "Approval requested",
    detail: null,
    tone: "info",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-file-change-prompt": {
    label: "Approval requested",
    heading: "Allow file-change?",
    detail: "Allow file-change?",
    tone: "info",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-mcp-elicitation": {
    label: "Approval requested",
    heading: "Approval requested",
    detail: null,
    tone: "info",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-mcp-elicitation-prompt": {
    label: "Approval requested",
    heading: "Allow mcp-elicitation?",
    detail: "Allow mcp-elicitation?",
    tone: "info",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-permission": {
    label: "Approval requested",
    heading: "Approval requested",
    detail: null,
    tone: "info",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-permission-prompt": {
    label: "Approval requested",
    heading: "Allow permission?",
    detail: "Allow permission?",
    tone: "info",
    status: "success",
    group: "Used 1 tool",
  },
  question: {
    label: "Input requested",
    heading: "Proceed?",
    detail: "Proceed?",
    tone: "info",
    status: "neutral",
    group: "Received 1 update",
  },
  "question-titled": {
    label: "Plan questions",
    heading: "Proceed?",
    detail: "Proceed?",
    tone: "info",
    status: "neutral",
    group: "Received 1 update",
  },
  "question-answered": {
    label: "Input requested",
    heading: "Proceed?",
    detail: "Proceed?",
    tone: "info",
    status: "success",
    group: "Received 1 update",
  },
  "question-answered-titled": {
    label: "Plan questions",
    heading: "Proceed?",
    detail: "Proceed?",
    tone: "info",
    status: "success",
    group: "Received 1 update",
  },
  "thread-created": {
    label: "Thread created",
    heading: "thread-child",
    detail: "thread-child",
    tone: "info",
    status: null,
    group: "Created 1 thread",
  },
  "provider-retry": {
    label: "Provider error",
    heading: "Overloaded",
    detail: "Overloaded",
    tone: "info",
    status: "neutral",
    group: "Received 1 update",
  },
  "command-ok": {
    label: "Command",
    heading: "vp check",
    detail: "vp check",
    tone: "tool",
    status: "success",
    group: "Ran 1 command",
  },
  "command-exit-1": {
    label: "Command",
    heading: "vp test",
    detail: "vp test",
    tone: "tool",
    status: "failure",
    group: "Ran 1 command",
  },
  "command-no-exit": {
    label: "Command",
    heading: "ls",
    detail: "ls",
    tone: "tool",
    status: "success",
    group: "Ran 1 command",
  },
};

const intendedChanges: Partial<Record<keyof typeof baseRows, Partial<Row>>> = {
  "edit-many": { heading: "src/a.ts +2 more", group: "Changed 3 files" },
  "approve-command": { tone: "tool" },
  "approve-command-prompt": { tone: "tool" },
  "approve-file-read": { tone: "tool", group: "Used 1 tool" },
  "approve-file-read-prompt": { tone: "tool", group: "Used 1 tool" },
  "approve-file-change": { tone: "tool" },
  "approve-file-change-prompt": { tone: "tool" },
  "approve-mcp-elicitation": { tone: "tool" },
  "approve-mcp-elicitation-prompt": { tone: "tool" },
  "approve-permission": { tone: "tool" },
  "approve-permission-prompt": { tone: "tool" },
  question: { tone: "tool", group: "Used 1 tool" },
  "question-titled": { tone: "tool", group: "Used 1 tool" },
  "question-answered": { tone: "tool", group: "Used 1 tool" },
  "question-answered-titled": { tone: "tool", group: "Used 1 tool" },
  "thread-created": { heading: "Thread created", tone: "tool" },
  "provider-retry": { heading: "Overloaded Retrying in 1.5s." },
};

describe("mobile work-log rows", () => {
  it("render as before the shared mapper, apart from the intended changes", () => {
    expect(renderedRows()).toEqual(
      Object.fromEntries(
        Object.entries(baseRows).map(([id, row]) => [
          id,
          { ...row, ...intendedChanges[id as keyof typeof baseRows] },
        ]),
      ),
    );
  });

  it("folds a terminal run without a completion time, and nothing for a queued run", () => {
    const runId = RunId.make("run-1");
    const items: ReadonlyArray<OrchestrationV2TurnItem> = [
      {
        ...turnItemBase("user", 0),
        type: "user_message",
        messageId: MessageId.make("message-user"),
        createdBy: "user",
        creationSource: "mobile",
        inputIntent: "turn_start",
        text: "Run checks",
        attachments: [],
      },
      { ...turnItemBase("command", 1), type: "command_execution", input: "vp check", exitCode: 0 },
      {
        ...turnItemBase("assistant", 2),
        type: "assistant_message",
        messageId: MessageId.make("message-assistant"),
        text: "Done",
        streaming: false,
      },
    ];
    const feed = buildThreadFeed(items.map((item) => projectedTurnItem(item)));
    const presented = (latestRun: ThreadFeedLatestRun) =>
      deriveThreadFeedPresentation(feed, latestRun, new Set()).map((entry) => entry.type);

    expect(
      presented({
        runId,
        status: "completed",
        startedAt: "2026-06-20T00:00:00.000Z",
        completedAt: null,
      }),
    ).toEqual(["message", "run-fold", "message"]);
    expect(
      presented({
        runId: RunId.make("run-2"),
        status: "queued",
        startedAt: null,
        completedAt: null,
      }),
    ).toEqual(["message", "run-fold", "message"]);
  });
});
