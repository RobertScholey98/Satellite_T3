import { describe, expect, it } from "vite-plus/test";
import {
  CommitRecommendation,
  SetCommitRecommendationInput,
  VcsStatusResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { activeCommitRecommendation, commitRecommendationLabel } from "./commitRecommendation.ts";

const recommendation: CommitRecommendation = {
  level: "recommended",
  reason: "The change is complete and its focused tests pass.",
  cwd: "/repo/worktree",
  branch: "feature",
  headCommit: "before-commit",
  assessedAt: "2026-10-04T00:00:00.000Z",
};
const status: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: "feature",
  headCommit: "before-commit",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "a.ts", insertions: 1, deletions: 0 }],
    insertions: 1,
    deletions: 0,
  },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

describe("commit recommendations", () => {
  it("shows the current assessment with a textual urgency label", () => {
    for (const level of ["recommended", "overdue"] as const) {
      const assessment = { ...recommendation, level };
      expect(activeCommitRecommendation(assessment, status, recommendation.cwd)).toBe(assessment);
      expect(commitRecommendationLabel(assessment)).toBe(`Commit ${level}`);
    }
  });

  it.each([
    { headCommit: "after-partial-commit" },
    { headCommit: undefined },
    { refName: "other-branch" },
    { hasWorkingTreeChanges: false },
    { isRepo: false },
  ])("hides advice when the checkout no longer matches: %o", (patch) => {
    expect(
      activeCommitRecommendation(recommendation, { ...status, ...patch }, recommendation.cwd),
    ).toBeNull();
  });

  it("does not leak advice to another worktree or show it before Git status loads", () => {
    expect(activeCommitRecommendation(recommendation, status, "/repo/other")).toBeNull();
    expect(activeCommitRecommendation(recommendation, null, recommendation.cwd)).toBeNull();
    expect(activeCommitRecommendation(null, status, recommendation.cwd)).toBeNull();
  });

  it("supports the first commit and hides the recommendation once it exists", () => {
    const initial = { ...recommendation, headCommit: null };
    expect(activeCommitRecommendation(initial, { ...status, headCommit: null }, initial.cwd)).toBe(
      initial,
    );
    expect(activeCommitRecommendation(initial, status, initial.cwd)).toBeNull();
  });

  it("requires a short explanation for advice and allows withdrawal without one", () => {
    const decode = Schema.decodeUnknownSync(SetCommitRecommendationInput);
    expect(decode({ level: "none" })).toEqual({ level: "none" });
    expect(() => decode({ level: "recommended" })).toThrow();
    expect(() => decode({ level: "overdue", reason: " " })).toThrow();
    expect(() => decode({ level: "recommended", reason: "x".repeat(501) })).toThrow();
    expect(() => decode({ level: "critical", reason: "Ready" })).toThrow();
  });
});
