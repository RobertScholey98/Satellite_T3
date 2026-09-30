import { describe, expect, it } from "vite-plus/test";
import type { IssueBoardItem, IssueBoardMapping, OpenWorkDocument } from "@t3tools/contracts";
import { documentsAtStep, issueCanStart, validWorktreeName } from "./work.logic";

const item: IssueBoardItem = {
  itemId: "item",
  columnId: "ready-id",
  version: null,
  issue: {
    ref: {
      hostKind: "github",
      host: "github.com",
      repository: "team/repo",
      id: "123",
      number: 123,
      url: "https://github.com/team/repo/issues/123",
    },
    title: "Fix",
    state: "open",
    updatedAt: "2026-01-01",
    labels: [],
  },
};
const mapping: IssueBoardMapping = {
  ready: "ready-id",
  inProgress: "doing-id",
  inPullRequest: "pr-id",
  completed: "done-id",
  moveOnMerge: false,
};

describe("issue work eligibility", () => {
  it("only starts in the configured remote Ready column", () => {
    expect(issueCanStart(item, mapping)).toBe(true);
    expect(issueCanStart({ ...item, columnId: "doing-id" }, mapping)).toBe(false);
    expect(issueCanStart(item, null)).toBe(false);
  });
  it("starts in any configured Ready column and stops offering Start when it is removed", () => {
    const multiple = { ...mapping, ready: ["ready-id", "triaged-id"] };
    const triaged = { ...item, columnId: "triaged-id" };
    expect(issueCanStart(item, multiple)).toBe(true);
    expect(issueCanStart(triaged, multiple)).toBe(true);
    expect(issueCanStart({ ...item, columnId: "doing-id" }, multiple)).toBe(false);
    expect(issueCanStart({ ...item, columnId: null }, multiple)).toBe(false);
    expect(issueCanStart(triaged, { ...multiple, ready: ["ready-id"] })).toBe(false);
  });
  it("rejects branch names Git cannot create", () => {
    expect(validWorktreeName("issue-123")).toBe(true);
    expect(validWorktreeName("feature/issue-123")).toBe(true);
    for (const name of [
      "",
      "bad name",
      "foo..bar",
      "-flag",
      "foo/.hidden",
      "branch.lock",
      "a//b",
      "a@{b",
      "a\\b",
    ])
      expect(validWorktreeName(name)).toBe(false);
  });
});

describe("worktree document history", () => {
  it("keeps fixed commit links apart from WIP and unassigned files", () => {
    const base: OpenWorkDocument = {
      id: "first",
      title: "Review",
      worktreeId: "tree",
      source: { kind: "linked", folderLinkId: "folder", path: "review.md" },
      step: { kind: "commit", commitSha: "old" },
      favorite: false,
      available: true,
      unresolved: null,
    };
    const documents = [
      base,
      { ...base, id: "second", step: { kind: "commit" as const, commitSha: "new" } },
      { ...base, id: "wip", step: { kind: "wip" as const } },
      { ...base, id: "unassigned", step: { kind: "unassigned" as const } },
    ];
    expect(
      documentsAtStep(documents, { kind: "commit", commitSha: "old" }).map(
        (document) => document.id,
      ),
    ).toEqual(["first"]);
    expect(documentsAtStep(documents, { kind: "wip" }).map((document) => document.id)).toEqual([
      "wip",
    ]);
    expect(
      documentsAtStep(documents, { kind: "unassigned" }).map((document) => document.id),
    ).toEqual(["unassigned"]);
  });
});
