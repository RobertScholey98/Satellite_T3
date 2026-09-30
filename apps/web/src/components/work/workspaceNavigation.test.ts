import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { readWorkAreaSearch, writeWorkAreaSearch } from "./workspaceNavigation";
import { writePullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("work area navigation", () => {
  it("reopens the selected tab with independent board, worktree, and PR identities", () => {
    const disk = storage();
    const selection = {
      involvement: "authored" as const,
      state: "open" as const,
      tab: "issues" as const,
      boardEnvironmentId: EnvironmentId.make("source"),
      boardProjectId: ProjectId.make("board-project"),
      boardId: "board",
      issueId: "ticket",
      workEnvironmentId: EnvironmentId.make("destination"),
      worktreePath: "C:/work/tree",
      selectedEnvironmentId: EnvironmentId.make("review"),
      selectedProjectId: ProjectId.make("review-project"),
      selectedHost: "github.example.com",
      repository: "owner/repo",
      number: 42,
    };
    writeWorkAreaSearch(selection, disk);
    expect(readWorkAreaSearch(disk)).toEqual(selection);
    writeWorkAreaSearch({ ...selection, tab: "open" }, disk);
    expect(readWorkAreaSearch(disk)).toEqual({ ...selection, tab: "open" });
  });

  it("does not reopen a ticket or PR that was dismissed", () => {
    const disk = storage();
    writeWorkAreaSearch(
      {
        involvement: "all",
        state: "open",
        tab: "issues",
        issueId: "ticket",
        repository: "owner/repo",
        number: 12,
      },
      disk,
    );
    writeWorkAreaSearch({ involvement: "all", state: "open", tab: "issues" }, disk);
    expect(readWorkAreaSearch(disk)).toEqual({ involvement: "all", state: "open", tab: "issues" });
  });

  it("falls back to existing PR preferences for missing or invalid workspace state", () => {
    const disk = storage();
    writePullRequestListPreferences(
      { involvement: "reviewing", state: "all", q: "label:bug" },
      disk,
    );
    expect(readWorkAreaSearch(disk)).toEqual({
      involvement: "reviewing",
      state: "all",
      q: "label:bug",
    });
    disk.setItem("t3.workArea.navigation", '{"state":"invalid"}');
    expect(readWorkAreaSearch(disk).involvement).toBe("reviewing");
    disk.setItem("t3.workArea.navigation", "broken json");
    expect(readWorkAreaSearch(disk).q).toBe("label:bug");
  });

  it("tolerates unavailable storage and drops unknown fields", () => {
    const unavailable = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readWorkAreaSearch(unavailable)).toEqual({ involvement: "all", state: "open" });
    expect(() =>
      writeWorkAreaSearch({ involvement: "all", state: "open" }, unavailable),
    ).not.toThrow();
    const disk = storage();
    disk.setItem(
      "t3.workArea.navigation",
      '{"involvement":"all","state":"open","unexpected":"ignored"}',
    );
    expect(readWorkAreaSearch(disk)).toEqual({ involvement: "all", state: "open" });
  });
});
