import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { FactoryAssignment } from "./factory.ts";

const decodeAssignment = Schema.decodeUnknownSync(FactoryAssignment);

/** An assignment as a server from before protected-path asks sends it. */
const OLDER_ASSIGNMENT = {
  id: "assignment-1",
  managerId: "manager-1",
  projectId: "project-1",
  title: "Fix the empty list",
  brief: "Guard List.tsx.",
  completionCondition: "The tests pass.",
  source: "ticket",
  issue: null,
  attemptId: null,
  leadThreadId: null,
  complexity: "small",
  state: "active",
  team: { preset: "custom", members: [] },
  recoveryUsed: 0,
  waitingReason: null,
  cancelReason: null,
  claim: null,
  takenOver: false,
  dependencies: [],
  teamVerdict: null,
  checklist: [],
  digest: null,
  controlViolations: [],
  retro: { teamDoneAt: null, managerDoneAt: null },
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  endedAt: null,
};

const ask = (paths: ReadonlyArray<string>) => ({
  id: "ask-1",
  paths,
  reason: "Pull request #7 changes these protected files.",
  source: "pull-request",
  pullRequest: { host: "github.com", repository: "acme/app", number: 7 },
  state: "open",
  createdAt: "2026-10-24T00:00:00.000Z",
  answeredAt: null,
});

describe("FactoryAssignment", () => {
  it("decodes an older server's assignment with no protected-path asks", () => {
    expect(decodeAssignment(OLDER_ASSIGNMENT).protectedPathAsks).toEqual([]);
  });

  it("keeps a stored ask's paths exactly as the pull request reported them", () => {
    const long = `docs/${"x".repeat(1100)}/AGENTS.md`;
    const decoded = decodeAssignment({
      ...OLDER_ASSIGNMENT,
      protectedPathAsks: [ask([" AGENTS.md", long])],
    });
    expect(decoded.protectedPathAsks[0]!.paths).toEqual([" AGENTS.md", long]);
  });
});
