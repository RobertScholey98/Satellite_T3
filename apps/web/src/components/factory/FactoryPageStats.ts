import type {
  FactoryAssignmentStats,
  FactoryRole,
  FactoryStatsResult,
  FactoryTeamStats,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

import type { ShareSegment } from "../usage/UsageShareBar";
import { FACTORY_ROLE_LABELS } from "./FactoryPageConfig";

/** The server's team key for assignments staffed without a preset. */
const CUSTOM_TEAM = "custom";

export interface FactoryTeamRow extends FactoryTeamStats {
  readonly label: string;
  /** Not in the server rollup: the median of the team's assignments' time waiting on you. */
  readonly medianWaitingMs: number;
  readonly assignments: ReadonlyArray<FactoryAssignmentStats>;
}

/** The middle value, or the mean of the middle two, as the server computes its medians. */
export function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * One row per team, busiest first; teams staffed without a preset group under Custom, last. Team
 * names are often lowercase file ids, so each label starts with a capital like "Custom" does.
 */
export function factoryTeamRows(result: FactoryStatsResult): ReadonlyArray<FactoryTeamRow> {
  return result.teams
    .map((team) => {
      const assignments = result.assignments.filter((assignment) => assignment.team === team.team);
      return {
        ...team,
        label:
          team.team === CUSTOM_TEAM
            ? "Custom"
            : `${team.team[0]?.toUpperCase() ?? ""}${team.team.slice(1)}`,
        medianWaitingMs: median(assignments.map((assignment) => assignment.waitingUserMs)),
        assignments,
      };
    })
    .toSorted(
      (left, right) =>
        Number(left.team === CUSTOM_TEAM) - Number(right.team === CUSTOM_TEAM) ||
        right.tasks - left.tasks ||
        left.label.localeCompare(right.label),
    );
}

const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;

const ROLE_COLORS: Record<FactoryRole, string> = {
  manager: ink(20),
  lead: ink(100),
  implementer: ink(72),
  reviewer: ink(48),
  verifier: ink(30),
  worker: ink(72),
};

const totalTokens = (tokens: FactoryAssignmentStats["tokens"]) => tokens.input + tokens.output;

/** A team's tokens by role, summed over the assignments shown. */
export function factoryRoleTokenSegments(
  assignments: ReadonlyArray<FactoryAssignmentStats>,
): ReadonlyArray<ShareSegment> {
  const byRole = new Map<FactoryRole, number>();
  for (const assignment of assignments) {
    for (const entry of assignment.byRole) {
      byRole.set(entry.role, (byRole.get(entry.role) ?? 0) + totalTokens(entry.tokens));
    }
  }
  return (Object.keys(ROLE_COLORS) as FactoryRole[]).map((role) => ({
    label: FACTORY_ROLE_LABELS[role],
    value: byRole.get(role) ?? 0,
    color: ROLE_COLORS[role],
  }));
}

export function formatFactoryDuration(ms: number): string {
  return ms <= 0 ? "0s" : formatDuration(ms);
}

export function formatFactoryCost(costUsd: number | null): string {
  return costUsd === null ? "Unpriced" : formatUsd(costUsd);
}

export function formatFactoryTokens(tokens: number): string {
  return formatTokens(tokens);
}

export function formatFactoryMean(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function factoryAssignmentTokens(assignment: FactoryAssignmentStats): number {
  return totalTokens(assignment.tokens);
}

/** `YYYY-MM-DD` (UTC) `days` before `now`, or undefined for all time. */
export function factoryStatsSinceDay(days: number | null, now: number): string | undefined {
  if (days === null) return undefined;
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A manager's live assignments against its cap. Work only starts under the cap, but a cap lowered
 * under running work leaves the count above it, which "6 of 2 running" would garble. Short enough
 * for the narrow details row, which shows it too.
 */
export function factoryManagerRunningLabel(running: number, cap: number | undefined): string {
  if (cap === undefined) return `${running} running`;
  return running > cap ? `${running} running, cap ${cap}` : `${running} of ${cap} running`;
}
