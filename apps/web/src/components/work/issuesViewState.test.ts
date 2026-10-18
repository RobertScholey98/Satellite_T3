import type { IssueAttempt, IssueMove, IssueRef } from "@t3tools/contracts";
import { ProjectId, SourceControlProviderKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ISSUES_PREFERENCES,
  branchNameProblem,
  canResumeAttempt,
  groupBoardColumns,
  readIssuesPreferences,
  selectMoveBanners,
  writeIssuesPreferences,
} from "./issuesViewState";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const ref = (number: number): IssueRef => ({
  hostKind: SourceControlProviderKind.make("github"),
  host: "github.com",
  repository: "acme/web",
  id: `issue-${number}`,
  number,
  url: `https://github.com/acme/web/issues/${number}`,
});

const move = (
  id: string,
  number: number,
  status: IssueMove["status"],
  createdAt: string,
  error: string | null = null,
): IssueMove => ({
  id,
  boardId: "board",
  issue: ref(number),
  columnId: "in-progress",
  origin: status === "skipped" ? "automatic" : "manual",
  attemptId: null,
  status,
  error,
  createdAt,
});

const titles: Record<string, string> = { "in-progress": "In progress" };
const columnTitle = (id: string) => titles[id] ?? id;

describe("issues preferences", () => {
  it("round-trips search and filters per scope", () => {
    const storage = memoryStorage();
    const value = { query: "#12", issueState: "OPEN", issueHost: "github.com" };
    writeIssuesPreferences("env\nproject", value, storage);
    expect(readIssuesPreferences("env\nproject", storage)).toEqual(value);
    expect(readIssuesPreferences("env\nother", storage)).toEqual(DEFAULT_ISSUES_PREFERENCES);
  });

  it("falls back to defaults for unreadable values", () => {
    const storage = memoryStorage({ "satellite:issues:view:v1:scope": '{"query":3}' });
    expect(readIssuesPreferences("scope", storage)).toEqual(DEFAULT_ISSUES_PREFERENCES);
  });
});

describe("selectMoveBanners", () => {
  it("shows skipped and failed moves with their reasons", () => {
    const banners = selectMoveBanners(
      [
        move("skipped", 1, "skipped", "2026-10-01T00:00:00Z", "moved by hand to Blocked"),
        move("failed", 2, "failed", "2026-10-01T00:00:00Z", "Project access denied."),
      ],
      columnTitle,
    );
    expect(banners.map((banner) => banner.message)).toEqual([
      "Automatic move to In progress skipped: moved by hand to Blocked.",
      "Move to In progress failed: Project access denied.",
    ]);
  });

  it("hides applied, superseded, and pending moves", () => {
    expect(
      selectMoveBanners(
        [
          move("applied", 1, "applied", "2026-10-01T00:00:00Z"),
          move("superseded", 2, "superseded", "2026-10-01T00:00:00Z"),
          move("pending", 3, "pending", "2026-10-01T00:00:00Z"),
        ],
        columnTitle,
      ),
    ).toEqual([]);
  });

  it("considers only each ticket's latest move", () => {
    const banners = selectMoveBanners(
      [
        move("old-failure", 1, "failed", "2026-10-01T00:00:00Z", "offline"),
        move("new-applied", 1, "applied", "2026-10-02T00:00:00Z"),
        move("old-applied", 2, "applied", "2026-10-01T00:00:00Z"),
        move("new-skip", 2, "skipped", "2026-10-02T00:00:00Z", "moved by hand to Done"),
      ],
      columnTitle,
    );
    expect(banners.map((banner) => banner.move.id)).toEqual(["new-skip"]);
  });
});

describe("groupBoardColumns", () => {
  it("puts items without a known column in Unassigned and applies the search", () => {
    const item = (number: number, columnId: string | null) => ({
      issue: {
        ref: ref(number),
        title: `Ticket ${number}`,
        state: "OPEN",
        updatedAt: "",
        labels: [],
      },
      itemId: `item-${number}`,
      columnId,
      version: null,
    });
    const grouped = groupBoardColumns(
      {
        columns: [{ id: "ready", title: "Ready" }],
        items: [item(1, "ready"), item(2, null), item(3, "gone"), item(4, "ready")],
      },
      "",
    );
    expect(grouped.columns[0]?.items.map((entry) => entry.itemId)).toEqual(["item-1", "item-4"]);
    expect(grouped.unassigned.map((entry) => entry.itemId)).toEqual(["item-2", "item-3"]);
    expect(
      groupBoardColumns({ columns: [], items: [item(1, null), item(4, null)] }, "#4").unassigned,
    ).toHaveLength(1);
  });
});

describe("canResumeAttempt", () => {
  const attempt = (id: string, overrides: Partial<IssueAttempt>): IssueAttempt => ({
    id,
    boardId: "board",
    issue: ref(1),
    projectId: ProjectId.make("project"),
    threadId: ThreadId.make(`thread-${id}`),
    worktreePath: null,
    status: "ended",
    active: false,
    endedReason: "user",
    automaticMoves: "on",
    createdAt: "2026-10-01T00:00:00Z",
    startedAt: null,
    controllingPullRequest: null,
    ...overrides,
  });

  it("offers Resume only for attempts a person stopped while nothing else works the ticket", () => {
    const stopped = attempt("stopped", {});
    expect(canResumeAttempt(stopped, [stopped])).toBe(true);
    expect(
      canResumeAttempt(stopped, [
        stopped,
        attempt("live", { active: true, status: "working", endedReason: null }),
      ]),
    ).toBe(false);
    const superseded = attempt("superseded", { endedReason: "superseded" });
    expect(canResumeAttempt(superseded, [superseded])).toBe(false);
  });
});

describe("branchNameProblem", () => {
  it("accepts ordinary branch names and refuses ones git would reject", () => {
    expect(branchNameProblem("issue-42")).toBeNull();
    expect(branchNameProblem("feature/issue-42")).toBeNull();
    for (const name of [
      "",
      "has space",
      "a..b",
      "trailing/",
      "x.lock",
      "-flag",
      "a/.hidden",
      "a~b",
    ]) {
      expect(branchNameProblem(name)).not.toBeNull();
    }
  });
});
