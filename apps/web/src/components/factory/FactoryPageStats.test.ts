import { type FactoryAssignmentStats, type FactoryTeamStats, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  factoryRoleTokenSegments,
  factoryStatsSinceDay,
  factoryTeamRows,
  formatFactoryCost,
  median,
} from "./FactoryPageStats";

const assignment = (
  id: string,
  team: string,
  overrides: Partial<FactoryAssignmentStats> = {},
): FactoryAssignmentStats => ({
  assignmentId: id,
  managerId: "manager",
  projectId: ProjectId.make("project"),
  team,
  complexity: "small",
  outcome: "completed",
  teamVerdict: "good",
  tokens: { input: 100, cachedInput: 0, output: 10 },
  costUsd: null,
  agentMs: 0,
  wallMs: 0,
  waitingUserMs: 0,
  recoveries: 0,
  pullRequests: 0,
  reviewRounds: 0,
  byRole: [],
  byModel: [],
  endedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const team = (name: string, tasks: number): FactoryTeamStats => ({
  team: name,
  tasks,
  completed: tasks,
  cancelled: 0,
  medianTokens: 0,
  medianCostUsd: null,
  medianAgentMs: 0,
  medianWallMs: 0,
  meanRecoveries: 0,
  meanReviewRounds: 0,
  goodFit: 0,
  poorFit: 0,
});

describe("factoryTeamRows", () => {
  it("puts the busiest team first, custom teams last, and their own assignments under each", () => {
    const rows = factoryTeamRows({
      teams: [team("custom", 5), team("Solo", 1), team("Standard", 3)],
      assignments: [
        assignment("a", "Standard", { waitingUserMs: 1_000 }),
        assignment("b", "custom"),
        assignment("c", "Standard", { waitingUserMs: 3_000 }),
        assignment("d", "Solo"),
      ],
    });
    expect(rows.map((row) => row.label)).toEqual(["Standard", "Solo", "Custom"]);
    expect(rows[0]!.assignments.map((entry) => entry.assignmentId)).toEqual(["a", "c"]);
    expect(rows[0]!.medianWaitingMs).toBe(2_000);
  });
});

describe("factory stats formatting", () => {
  it("takes the mean of the middle two for an even count, like the server", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("sums input and output tokens by role across assignments", () => {
    const segments = factoryRoleTokenSegments([
      assignment("a", "Standard", {
        byRole: [
          { role: "lead", tokens: { input: 50, cachedInput: 40, output: 5 }, agentMs: 0 },
          { role: "implementer", tokens: { input: 10, cachedInput: 0, output: 1 }, agentMs: 0 },
        ],
      }),
      assignment("b", "Standard", {
        byRole: [{ role: "lead", tokens: { input: 20, cachedInput: 0, output: 5 }, agentMs: 0 }],
      }),
    ]);
    expect(Object.fromEntries(segments.map((segment) => [segment.label, segment.value]))).toEqual({
      Manager: 0,
      Lead: 80,
      Implementer: 11,
      Reviewer: 0,
      Verifier: 0,
    });
  });

  it("reports an unpriced cost and a UTC start day", () => {
    expect(formatFactoryCost(null)).toBe("Unpriced");
    expect(factoryStatsSinceDay(7, Date.parse("2026-10-22T01:00:00Z"))).toBe("2026-10-15");
    expect(factoryStatsSinceDay(null, 0)).toBeUndefined();
  });
});
