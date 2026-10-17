import { type OpenWorktreeSummary, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ownerPullRequest, resolveWorktreeOwner, selectWorktree } from "./openWork.logic";

const thread = (
  id: string,
  worktreePath: string | null,
  updatedAt: string,
  relationshipToParent: "fork" | "subagent" | null = null,
) => ({
  id,
  worktreePath,
  updatedAt,
  lineage: {
    parentThreadId: relationshipToParent ? ThreadId.make("parent") : null,
    relationshipToParent,
    rootThreadId: ThreadId.make("parent"),
  },
});

const worktree = (path: string) =>
  ({
    path,
    projectIds: [],
    branch: null,
    head: null,
    baseRef: null,
    ahead: null,
    behind: null,
    primary: false,
  }) satisfies OpenWorktreeSummary;

describe("resolveWorktreeOwner", () => {
  it("finds no owner when no thread works in the worktree", () => {
    expect(
      resolveWorktreeOwner([thread("elsewhere", "/repo/other", "2026-10-01T00:00:00Z")], "/repo/a"),
    ).toBeNull();
    expect(resolveWorktreeOwner([thread("local", null, "2026-10-01T00:00:00Z")], "/repo/a")).toBe(
      null,
    );
  });

  it("returns the one thread in the worktree", () => {
    expect(
      resolveWorktreeOwner([thread("only", "/repo/a", "2026-10-01T00:00:00Z")], "/repo/a")?.id,
    ).toBe("only");
  });

  it("prefers the parent over a newer subagent sharing its worktree", () => {
    const threads = [
      thread("subagent", "/repo/a", "2026-10-03T00:00:00Z", "subagent"),
      thread("parent", "/repo/a", "2026-10-01T00:00:00Z"),
      thread("older-parent", "/repo/a", "2026-09-01T00:00:00Z"),
    ];
    expect(resolveWorktreeOwner(threads, "/repo/a")?.id).toBe("parent");
  });

  it("gives a delegated task its own worktree", () => {
    const threads = [
      thread("parent", "/repo/a", "2026-10-03T00:00:00Z"),
      thread("delegated", "/repo/task", "2026-10-01T00:00:00Z", "subagent"),
    ];
    expect(resolveWorktreeOwner(threads, "/repo/task")?.id).toBe("delegated");
  });

  it("matches paths across a trailing separator and Windows drive case", () => {
    expect(
      resolveWorktreeOwner([thread("unix", "/repo/a/", "2026-10-01T00:00:00Z")], "/repo/a")?.id,
    ).toBe("unix");
    expect(
      resolveWorktreeOwner(
        [thread("windows", "C:\\Repos\\A\\", "2026-10-01T00:00:00Z")],
        "c:/repos/a",
      )?.id,
    ).toBe("windows");
  });
});

describe("selectWorktree", () => {
  const worktrees = [worktree("/repo"), worktree("/repo-a"), worktree("/repo-b")];

  it("selects an explicit request, and reports it missing once it is removed", () => {
    expect(selectWorktree(worktrees, "/repo-b/", "/repo-a")).toEqual({
      kind: "selected",
      worktree: worktrees[2],
    });
    expect(selectWorktree(worktrees.slice(0, 2), "/repo-b", "/repo-a")).toEqual({
      kind: "missing",
      path: "/repo-b",
    });
  });

  it("falls back from the remembered worktree to the first listed", () => {
    expect(selectWorktree(worktrees, undefined, "/repo-a")).toEqual({
      kind: "selected",
      worktree: worktrees[1],
    });
    expect(selectWorktree(worktrees, undefined, "/gone")).toEqual({
      kind: "selected",
      worktree: worktrees[0],
    });
    expect(selectWorktree([], undefined, "/repo-a")).toEqual({ kind: "none" });
  });
});

describe("ownerPullRequest", () => {
  const projectId = ProjectId.make("project");
  const link = (
    number: number,
    linkedAt: string,
    source: "manual" | "stack-dismissed" = "manual",
  ) => ({
    host: "github.com",
    repository: "owner/repo",
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    source,
    linkedAt,
    snapshot: null,
    stack: null,
  });

  it("uses the newest pull request linked through the list when no single link is set", () => {
    expect(
      ownerPullRequest({
        projectId,
        pullRequests: [
          link(7, "2026-10-01T00:00:00.000Z"),
          link(9, "2026-10-03T00:00:00.000Z"),
          link(12, "2026-10-04T00:00:00.000Z", "stack-dismissed"),
        ],
        linkedPullRequest: null,
        branchPullRequest: null,
      }),
    ).toEqual({ projectId, repository: "owner/repo", number: 9, host: "github.com" });
  });

  it("falls back to the single linked or branch pull request, and to none", () => {
    const single = { projectId, repository: "owner/repo", number: 3, url: "https://x/3" };
    expect(
      ownerPullRequest({
        projectId,
        pullRequests: [],
        linkedPullRequest: null,
        branchPullRequest: single,
      }),
    ).toEqual({ projectId, repository: "owner/repo", number: 3, host: null });
    expect(
      ownerPullRequest({
        projectId,
        pullRequests: [],
        linkedPullRequest: null,
        branchPullRequest: null,
      }),
    ).toBeNull();
  });
});
