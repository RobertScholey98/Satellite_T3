import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type IssueBoardSummary,
  type IssueBoardView,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  isQueuedThreadCreationSendable,
} from "../../../state/thread-outbox-model";
import { issueStartTask, loadReadyIssues, readyIssues } from "./issueStart";

const LAPTOP = EnvironmentId.make("laptop");
const PROJECT = ProjectId.make("project");

function issue(number: number, title: string) {
  return {
    ref: {
      hostKind: "github" as const,
      host: "github.com",
      repository: "acme/app",
      id: `I_${number}`,
      number,
      url: `https://github.com/acme/app/issues/${number}`,
    },
    title,
    state: "open",
    updatedAt: "2026-10-14T00:00:00.000Z",
    labels: [],
  };
}

const MAPPED: IssueBoardSummary = {
  id: "board",
  projectId: PROJECT,
  title: "Sprint",
  locator: {
    kind: "github-project",
    host: "github.com",
    owner: "acme",
    ownerKind: "organization",
    projectNumber: 1,
  },
  mapping: {
    ready: ["ready", "triage"],
    inProgress: "doing",
    inPullRequest: "review",
    completed: "done",
    moveOnMerge: true,
  },
};
const UNMAPPED: IssueBoardSummary = { ...MAPPED, id: "unmapped", title: "Backlog", mapping: null };

const VIEW: IssueBoardView = {
  board: MAPPED,
  columns: [],
  items: [
    { issue: issue(7, "Checkout fails"), itemId: "a", columnId: "ready", version: null },
    { issue: issue(8, "Slow search"), itemId: "b", columnId: "triage", version: null },
    { issue: issue(9, "Dark mode"), itemId: "c", columnId: "doing", version: null },
    { issue: issue(10, "Unsorted"), itemId: "d", columnId: null, version: null },
  ],
  attempts: [],
  moves: [],
};

describe("readyIssues", () => {
  it("keeps issues in any Ready column of a mapped board", () => {
    expect(readyIssues([VIEW, { ...VIEW, board: UNMAPPED }])).toEqual([
      { boardId: "board", boardTitle: "Sprint", issue: issue(7, "Checkout fails") },
      { boardId: "board", boardTitle: "Sprint", issue: issue(8, "Slow search") },
    ]);
  });
});

describe("loadReadyIssues", () => {
  it("opens only boards with a column mapping", async () => {
    const opened: string[] = [];
    const result = await loadReadyIssues({
      environmentId: LAPTOP,
      projectId: PROJECT,
      listBoards: async () => AsyncResult.success([MAPPED, UNMAPPED]),
      openBoard: async ({ input }) => {
        opened.push(input.boardId);
        return AsyncResult.success(VIEW);
      },
    });

    expect(opened).toEqual(["board"]);
    expect(result).toEqual({
      issues: [
        { boardId: "board", boardTitle: "Sprint", issue: issue(7, "Checkout fails") },
        { boardId: "board", boardTitle: "Sprint", issue: issue(8, "Slow search") },
      ],
    });
  });

  it("reports why the boards could not load", async () => {
    const result = await loadReadyIssues({
      environmentId: LAPTOP,
      projectId: PROJECT,
      listBoards: async () =>
        AsyncResult.failure(Cause.fail(new Error("GitHub CLI is not signed in."))),
      openBoard: async () => AsyncResult.success(VIEW),
    });

    expect(result).toEqual({ error: "GitHub CLI is not signed in." });
  });
});

describe("issueStartTask", () => {
  it("queues a sendable worktree creation that keeps its issue through storage", () => {
    const task = issueStartTask({
      project: { environmentId: LAPTOP, id: PROJECT, title: "App", workspaceRoot: "/repo" },
      readyIssue: { boardId: "board", boardTitle: "Sprint", issue: issue(7, "Checkout fails") },
      worktreeName: "issue-7",
      baseBranch: "main",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      ids: {
        threadId: "thread",
        commandId: "command",
        messageId: "message",
        requestId: "request",
        createdAt: "2026-10-15T10:00:00.000Z",
      },
    });

    expect(task).toEqual({
      environmentId: "laptop",
      threadId: "thread",
      messageId: "message",
      commandId: "command",
      text: "Work on issue #7: Checkout fails",
      attachments: [],
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      creation: {
        projectId: "project",
        projectTitle: "App",
        projectCwd: "/repo",
        workspaceMode: "worktree",
        branch: "main",
        worktreePath: null,
      },
      issue: {
        sourceEnvironmentId: "laptop",
        sourceProjectId: "project",
        boardId: "board",
        issue: issue(7, "Checkout fails").ref,
        title: "Checkout fails",
        worktreeName: "issue-7",
        requestId: "request",
      },
      createdAt: "2026-10-15T10:00:00.000Z",
    });
    expect(isQueuedThreadCreationSendable(task)).toBe(true);
    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(task))).toEqual(task);
  });
});
