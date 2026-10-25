import {
  ProjectId,
  ThreadId,
  type FactoryWorkspaceAssignment,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  factoryMergeConfirmText,
  factoryMergeHeldPaths,
  resolveFactoryMergeRows,
  type FactoryLeadThreadLinks,
} from "./factoryMergeLogic";

const PROJECT = ProjectId.make("project");

function assignment(
  id: string,
  overrides: Partial<FactoryWorkspaceAssignment> = {},
): FactoryWorkspaceAssignment {
  return {
    id,
    managerId: "manager-1",
    title: `Work ${id}`,
    state: "waiting-user",
    source: "ticket",
    complexity: "small",
    team: "custom",
    leadThreadId: ThreadId.make(`${id}-lead`),
    checklist: [],
    waitingReason: null,
    claimedAt: "2026-10-24T09:00:00.000Z",
    controlViolations: [],
    ...overrides,
  };
}

function link(
  number: number,
  snapshot: Partial<ThreadPullRequestSnapshot> | null = {},
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "acme/app",
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    source: "agent",
    linkedAt: "2026-10-24T08:00:00.000Z",
    snapshot:
      snapshot === null
        ? null
        : {
            state: "open",
            title: `Change ${number}`,
            headBranch: `branch-${number}`,
            baseBranch: "main",
            isDraft: false,
            updatedAt: "2026-10-24T08:30:00.000Z",
            syncedAt: "2026-10-24T08:31:00.000Z",
            checksState: "passing",
            mergeability: "mergeable",
            ...snapshot,
          },
    stack: null,
    ...overrides,
  };
}

const leads = (entries: Record<string, ReadonlyArray<ThreadPullRequestLink>>) =>
  new Map<ThreadId, FactoryLeadThreadLinks>(
    Object.entries(entries).map(([threadId, pullRequests]) => [
      ThreadId.make(threadId),
      { projectId: PROJECT, pullRequests },
    ]),
  );

const summary = (rows: ReturnType<typeof resolveFactoryMergeRows>) =>
  rows.map((row) => [row.assignmentId, row.number, row.status]);

describe("resolveFactoryMergeRows", () => {
  it("lists only the open pull requests on this manager's live lead threads", () => {
    const rows = resolveFactoryMergeRows(
      [
        assignment("a"),
        assignment("other", { managerId: "manager-2" }),
        assignment("done", { state: "completed" }),
        assignment("unstaffed", { leadThreadId: null }),
      ],
      "manager-1",
      leads({
        "a-lead": [
          link(1),
          link(2, { state: "merged" }),
          link(3, { state: "closed" }),
          link(4, null),
          link(5, {}, { source: "stack-dismissed" }),
        ],
        "other-lead": [link(6)],
        "done-lead": [link(7)],
      }),
    );
    expect(summary(rows)).toEqual([["a", 1, "ready"]]);
  });

  it("lists the pull requests on a replaced lead's thread once, beside the current lead's", () => {
    const replaced = assignment("a", {
      leadThreadId: ThreadId.make("a-lead-2"),
      previousLeadThreadIds: [ThreadId.make("a-lead")],
    });
    const rows = resolveFactoryMergeRows(
      [replaced],
      "manager-1",
      leads({ "a-lead": [link(7), link(8)], "a-lead-2": [link(8), link(9)] }),
    );
    expect(summary(rows)).toEqual([
      ["a", 7, "ready"],
      ["a", 8, "ready"],
      ["a", 9, "ready"],
    ]);
  });

  it("gives each pull request the state that keeps it from merging", () => {
    const rows = resolveFactoryMergeRows(
      [assignment("working", { claimedAt: null }), assignment("claimed")],
      "manager-1",
      leads({
        // Unclaimed work is in progress even when its pull request would merge.
        "working-lead": [link(1)],
        "claimed-lead": [
          link(2, { isDraft: true }),
          link(3, { mergeability: "conflicting", checksState: "failing" }),
          link(4, { checksState: "failing" }),
          link(5, { checksState: "pending" }),
          link(6, { checksState: null }),
          link(7, { mergeability: "unknown" }),
          link(8, { mergeability: undefined }),
          link(9),
        ],
      }),
    );
    expect(summary(rows)).toEqual([
      ["claimed", 9, "ready"],
      ["working", 1, "in-progress"],
      ["claimed", 2, "in-progress"],
      ["claimed", 3, "needs-rebase"],
      ["claimed", 4, "checks-failing"],
      ["claimed", 5, "checks-running"],
      ["claimed", 6, "checks-missing"],
      ["claimed", 7, "mergeability-unknown"],
      ["claimed", 8, "mergeability-unknown"],
    ]);
  });

  it("puts ready pull requests first, the longest claimed first, then the rest in feed order", () => {
    const rows = resolveFactoryMergeRows(
      [
        assignment("old", { claimedAt: "2026-10-24T11:00:00.000Z" }),
        assignment("new", { claimedAt: "2026-10-24T10:00:00.000Z" }),
        assignment("working", { claimedAt: null }),
      ],
      "manager-1",
      leads({
        "old-lead": [link(12, { checksState: "pending" }), link(11)],
        "new-lead": [link(21)],
        "working-lead": [link(31)],
      }),
    );
    expect(summary(rows)).toEqual([
      ["new", 21, "ready"],
      ["old", 11, "ready"],
      ["old", 12, "checks-running"],
      ["working", 31, "in-progress"],
    ]);
  });

  it("names the protected paths a pull request changes, matching the repository in any case", () => {
    const [row, clean] = resolveFactoryMergeRows(
      [
        assignment("a", {
          controlViolations: [
            {
              pullRequest: { host: "github.com", repository: "acme/app", number: 1 },
              paths: ["AGENTS.md", ".github/workflows/ci.yml"],
            },
          ],
        }),
      ],
      "manager-1",
      leads({ "a-lead": [link(1, {}, { repository: "Acme/App" }), link(2)] }),
    );
    expect(row!.status).toBe("ready");
    expect(row!.protectedPaths).toEqual(["AGENTS.md", ".github/workflows/ci.yml"]);
    expect(clean!.protectedPaths).toEqual([]);
  });

  it("tells paths waiting on the user's answer from paths the factory holds", () => {
    const ask = (paths: ReadonlyArray<string>, state: "open" | "declined") => ({
      id: `ask-${state}`,
      paths,
      reason: "",
      source: "pull-request" as const,
      pullRequest: { host: "github.com", repository: "acme/app", number: 1 },
      state,
      createdAt: "2026-10-24T09:00:00.000Z",
      answeredAt: null,
    });
    const [row, clean] = resolveFactoryMergeRows(
      [
        assignment("a", {
          controlViolations: [
            {
              pullRequest: { host: "github.com", repository: "acme/app", number: 1 },
              paths: ["AGENTS.md", ".github/workflows/ci.yml"],
            },
          ],
          protectedPathAsks: [
            ask(["AGENTS.md"], "open"),
            ask([".github/workflows/ci.yml"], "declined"),
          ],
        }),
      ],
      "manager-1",
      leads({ "a-lead": [link(1), link(2)] }),
    );
    expect(row!.awaitingAnswer).toEqual(["AGENTS.md"]);
    expect(factoryMergeHeldPaths(row!)).toEqual([".github/workflows/ci.yml"]);
    expect(factoryMergeConfirmText(row!)).toBe(
      [
        "Merge #1 over its protected paths?",
        "Waiting for your answer on the team's card: AGENTS.md.",
        "The factory is holding it for: .github/workflows/ci.yml.",
        "Merging overrides the hold.",
      ].join("\n"),
    );
    expect(factoryMergeConfirmText(clean!)).toBeNull();
  });
});
