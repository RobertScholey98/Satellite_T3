import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  controllingPullRequestOf,
  deriveStage,
  firstRunProgress,
  stageColumn,
  type AttemptFacts,
} from "./attemptStage.ts";

const link = (
  number: number,
  linkedAt: string,
  overrides: Partial<ThreadPullRequestLink> = {},
  state: "open" | "closed" | "merged" | null = "open",
): ThreadPullRequestLink =>
  ({
    host: "github.com",
    repository: "acme/app",
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    source: "agent",
    linkedAt,
    snapshot:
      state === null
        ? null
        : {
            state,
            title: `PR ${number}`,
            headBranch: `issue-${number}`,
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: linkedAt,
          },
    stack: null,
    ...overrides,
  }) as ThreadPullRequestLink;

describe("firstRunProgress", () => {
  const at = DateTime.makeUnsafe("2026-10-17T10:00:00Z");
  it.each([
    ["no run yet", [], "none"],
    ["queued", [{ ordinal: 1, status: "queued", startedAt: null }], "pending"],
    ["started", [{ ordinal: 1, status: "running", startedAt: at }], "running"],
    ["completed", [{ ordinal: 1, status: "completed", startedAt: at }], "running"],
    [
      "failed before starting",
      [{ ordinal: 1, status: "failed", startedAt: null }],
      "failed-before-running",
    ],
    [
      "only the first run counts",
      [
        { ordinal: 2, status: "failed", startedAt: null },
        { ordinal: 1, status: "completed", startedAt: at },
      ],
      "running",
    ],
  ] as const)("%s", (_name, runs, expected) => {
    expect(firstRunProgress(runs)).toBe(expected);
  });
});

describe("controllingPullRequestOf", () => {
  it("is the newest linked pull request", () => {
    expect(
      controllingPullRequestOf([
        link(1, "2026-10-17T10:00:00.000Z", {}, "closed"),
        link(2, "2026-10-17T11:00:00.000Z"),
      ]),
    ).toEqual({
      host: "github.com",
      repository: "acme/app",
      number: 2,
      url: "https://github.com/acme/app/pull/2",
      state: "open",
    });
  });
  it("ignores stack layers and dismissed links, and treats an unsynced link as open", () => {
    expect(
      controllingPullRequestOf([
        link(1, "2026-10-17T10:00:00.000Z", {}, null),
        link(2, "2026-10-17T11:00:00.000Z", { source: "stack" }),
        link(3, "2026-10-17T12:00:00.000Z", { source: "stack-dismissed" }),
      ]),
    ).toMatchObject({ number: 1, state: "open" });
  });
  it("is null with no links", () => {
    expect(controllingPullRequestOf([])).toBeNull();
  });
});

describe("deriveStage", () => {
  const pr = (state: "open" | "closed" | "merged") => ({
    host: "github.com",
    repository: "acme/app",
    number: 5,
    url: "u",
    state,
  });
  const facts = (overrides: Partial<AttemptFacts>): AttemptFacts => ({
    worktreeReady: true,
    firstRun: "running",
    controllingPullRequest: null,
    ...overrides,
  });
  it.each([
    ["worktree not ready", { worktreeReady: false }, "launching"],
    ["first run still pending", { firstRun: "pending" }, "launching"],
    ["launch never reached the agent", { firstRun: "failed-before-running" }, "failed"],
    ["running without a pull request", {}, "working"],
    ["open pull request", { controllingPullRequest: pr("open") }, "in-pr"],
    ["closed without merge", { controllingPullRequest: pr("closed") }, "working"],
    ["merged", { controllingPullRequest: pr("merged") }, "merged"],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(deriveStage(facts(overrides))).toBe(expected);
  });
});

describe("stageColumn", () => {
  const mapping = {
    ready: ["ready"],
    inProgress: "progress",
    inPullRequest: "review",
    completed: "done",
    moveOnMerge: true,
  };
  it("maps each stage to its column", () => {
    expect(
      (["launching", "working", "in-pr", "merged"] as const).map((stage) =>
        stageColumn(stage, mapping),
      ),
    ).toEqual([null, "progress", "review", "done"]);
  });
  it("leaves a merged ticket where it is when moving on merge is off", () => {
    expect(stageColumn("merged", { ...mapping, moveOnMerge: false })).toBeNull();
  });
});
