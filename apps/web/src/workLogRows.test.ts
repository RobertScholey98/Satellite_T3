import { summarizeToolGroup } from "@t3tools/client-runtime/work-log/presentation";
import { workLogScenario } from "@t3tools/client-runtime/work-log/test-fixtures";
import { getQuestionTextPreview } from "@t3tools/client-runtime/work-log/user-input";
import { describe, expect, it } from "vite-plus/test";

import { workEntryDisplayLabel } from "./components/chat/MessagesTimeline.logic";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
} from "./session-logic";

interface Row {
  readonly label: string;
  readonly heading: string;
  readonly detail: string | null;
  readonly tone: string;
  readonly status: string;
  readonly group: string;
}

function renderedRows(): Record<string, Row> {
  const rows: Record<string, Row> = {};
  for (const timelineEntry of deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: workLogScenario,
    optimisticMessages: [],
  })) {
    if (timelineEntry.kind !== "work") continue;
    const entry = timelineEntry.entry;
    const questionHeading = entry.questionAnswer
      ? getQuestionTextPreview(entry.questionAnswer)
      : "";
    rows[timelineEntry.id] = {
      label: entry.label,
      heading: questionHeading || workEntryDisplayLabel(entry, undefined),
      detail: entry.detail ?? null,
      tone: entry.tone,
      status: workEntryDisplayIndicatesToolFailure(entry)
        ? "failure"
        : workEntryIndicatesToolSuccess(entry)
          ? "success"
          : "neutral",
      group: summarizeToolGroup([entry]).summary,
    };
  }
  return rows;
}

// Rows as web rendered them before web and mobile shared one work-log mapper.
const baseRows = {
  "edit-one": {
    label: "Changed src/a.ts",
    heading: "src/a.ts",
    detail: null,
    tone: "tool",
    status: "success",
    group: "Changed 1 file",
  },
  "edit-many": {
    label: "Changed 3 files",
    heading: "src/a.ts +2 more",
    detail: null,
    tone: "tool",
    status: "success",
    group: "Changed 3 files",
  },
  "approve-command": {
    label: "Approval requested",
    heading: "command",
    detail: "command",
    tone: "tool",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-command-prompt": {
    label: "Approval requested",
    heading: "Allow command?",
    detail: "Allow command?",
    tone: "tool",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-file-read": {
    label: "Approval requested",
    heading: "file-read",
    detail: "file-read",
    tone: "tool",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-file-read-prompt": {
    label: "Approval requested",
    heading: "Allow file-read?",
    detail: "Allow file-read?",
    tone: "tool",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-file-change": {
    label: "Approval requested",
    heading: "file-change",
    detail: "file-change",
    tone: "tool",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-file-change-prompt": {
    label: "Approval requested",
    heading: "Allow file-change?",
    detail: "Allow file-change?",
    tone: "tool",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-mcp-elicitation": {
    label: "Approval requested",
    heading: "mcp-elicitation",
    detail: "mcp-elicitation",
    tone: "tool",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-mcp-elicitation-prompt": {
    label: "Approval requested",
    heading: "Allow mcp-elicitation?",
    detail: "Allow mcp-elicitation?",
    tone: "tool",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-permission": {
    label: "Approval requested",
    heading: "permission",
    detail: "permission",
    tone: "tool",
    status: "success",
    group: "Used 1 tool",
  },
  "approve-permission-prompt": {
    label: "Approval requested",
    heading: "Allow permission?",
    detail: "Allow permission?",
    tone: "tool",
    status: "success",
    group: "Used 1 tool",
  },
  question: {
    label: "Input requested",
    heading: "Input requested",
    detail: null,
    tone: "tool",
    status: "neutral",
    group: "Used 1 tool",
  },
  "question-titled": {
    label: "Plan questions",
    heading: "Plan questions",
    detail: null,
    tone: "tool",
    status: "neutral",
    group: "Used 1 tool",
  },
  "question-answered": {
    label: "Answered questions",
    heading: "Proceed?",
    detail: null,
    tone: "tool",
    status: "success",
    group: "Used 1 tool",
  },
  "question-answered-titled": {
    label: "Plan questions",
    heading: "Proceed?",
    detail: null,
    tone: "tool",
    status: "success",
    group: "Used 1 tool",
  },
  "thread-created": {
    label: "Created thread",
    heading: "Created thread",
    detail: null,
    tone: "tool",
    status: "success",
    group: "Created 1 thread",
  },
  "provider-retry": {
    label: "Retrying provider (2/5)",
    heading: "Retrying provider (2/5)",
    detail: "Overloaded Retrying in 1.5s.",
    tone: "info",
    status: "neutral",
    group: "Received 1 update",
  },
  "command-ok": {
    label: "Ran command",
    heading: "vp check",
    detail: null,
    tone: "tool",
    status: "success",
    group: "Ran 1 command",
  },
  "command-exit-1": {
    label: "Ran command",
    heading: "vp test",
    detail: null,
    tone: "tool",
    status: "failure",
    group: "Ran 1 command",
  },
  "command-no-exit": {
    label: "Ran command",
    heading: "ls",
    detail: null,
    tone: "tool",
    status: "success",
    group: "Ran 1 command",
  },
};

const intendedChanges: Partial<Record<keyof typeof baseRows, Partial<Row>>> = {
  "approve-command": { heading: "Approval requested", detail: null },
  "approve-file-read": { heading: "Approval requested", detail: null },
  "approve-file-change": { heading: "Approval requested", detail: null },
  "approve-mcp-elicitation": { heading: "Approval requested", detail: null },
  "approve-permission": { heading: "Approval requested", detail: null },
  question: { heading: "Proceed?", detail: "Proceed?" },
  "question-titled": { heading: "Proceed?", detail: "Proceed?" },
  "question-answered": { detail: "Proceed?" },
  "question-answered-titled": { detail: "Proceed?" },
};

describe("web work-log rows", () => {
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
});
