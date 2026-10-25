import type {
  FactoryWorkspaceAssignment,
  ProjectId,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

import { isLiveAssignment } from "./factoryWorkspaceLogic";

/** Why a pull request cannot be merged from the card yet, or `ready` when it can. */
export type FactoryMergeRowStatus =
  | "ready"
  | "in-progress"
  | "needs-rebase"
  | "checks-failing"
  | "checks-running"
  | "checks-missing"
  | "mergeability-unknown";

export const FACTORY_MERGE_STATUS_LABEL: Record<Exclude<FactoryMergeRowStatus, "ready">, string> = {
  "in-progress": "In progress",
  "needs-rebase": "Needs rebase",
  "checks-failing": "Checks failing",
  "checks-running": "Checks running",
  "checks-missing": "No checks reported",
  "mergeability-unknown": "Mergeability unknown",
};

export interface FactoryMergeRow {
  readonly key: string;
  readonly assignmentId: string;
  readonly assignmentTitle: string;
  readonly projectId: ProjectId;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string | null;
  readonly url: string;
  /** When the host was last read for this pull request; a sync replaces it. */
  readonly syncedAt: string;
  readonly status: FactoryMergeRowStatus;
  /**
   * Protected paths the pull request changes that the user has not allowed; merging it overrides
   * the factory's hold.
   */
  readonly protectedPaths: ReadonlyArray<string>;
  /** Those of `protectedPaths` the team asked for that still wait on the user's answer. */
  readonly awaitingAnswer: ReadonlyArray<string>;
}

/** What the card reads from a lead's thread. */
export interface FactoryLeadThreadLinks {
  readonly projectId: ProjectId;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
}

const sameRepository = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function mergeStatus(
  assignment: FactoryWorkspaceAssignment,
  link: ThreadPullRequestLink,
): FactoryMergeRowStatus {
  const snapshot = link.snapshot!;
  // Until the lead claims the work, its pull requests are still changing.
  if (assignment.claimedAt == null || snapshot.isDraft) return "in-progress";
  if (snapshot.mergeability === "conflicting") return "needs-rebase";
  switch (snapshot.checksState ?? null) {
    case "failing":
      return "checks-failing";
    case "pending":
      return "checks-running";
    case null:
      return "checks-missing";
    case "passing":
      return snapshot.mergeability === "mergeable" ? "ready" : "mergeability-unknown";
  }
}

/**
 * Every lead thread an assignment has had, the current one first. Pull requests linked on a
 * replaced lead's thread still gate the claim, so the card offers them too.
 */
export function factoryAssignmentLeadThreadIds(
  assignment: FactoryWorkspaceAssignment,
): ReadonlyArray<ThreadId> {
  return [
    ...(assignment.leadThreadId === null ? [] : [assignment.leadThreadId]),
    ...(assignment.previousLeadThreadIds ?? []),
  ];
}

/**
 * The open pull requests on a manager's live lead threads. Ready ones come first, the longest
 * claimed first; the rest follow in assignment order, oldest first, then by number.
 */
export function resolveFactoryMergeRows(
  assignments: ReadonlyArray<FactoryWorkspaceAssignment>,
  managerId: string,
  leadThreads: ReadonlyMap<ThreadId, FactoryLeadThreadLinks>,
): ReadonlyArray<FactoryMergeRow> {
  const rows: Array<
    FactoryMergeRow & { readonly claimedAt: string | null; readonly order: number }
  > = [];
  for (const assignment of assignments) {
    if (assignment.managerId !== managerId || !isLiveAssignment(assignment)) continue;
    const leads = factoryAssignmentLeadThreadIds(assignment).flatMap(
      (threadId) => leadThreads.get(threadId) ?? [],
    );
    const lead = leads[0];
    if (!lead) continue;
    // A pull request linked on more than one lead thread is one row.
    const unique = new Map(
      leads
        .flatMap((entry) => visibleThreadPullRequests(entry.pullRequests))
        .map((link) => [`${link.host}/${link.repository}#${link.number}`.toLowerCase(), link]),
    );
    const links = [...unique.values()]
      .filter((link) => link.snapshot?.state === "open")
      .toSorted((left, right) => left.number - right.number);
    const asked = new Set(
      (assignment.protectedPathAsks ?? []).flatMap((ask) =>
        ask.state === "open" ? ask.paths : [],
      ),
    );
    for (const link of links) {
      const violation = assignment.controlViolations?.find(
        ({ pullRequest }) =>
          pullRequest.number === link.number &&
          sameRepository(pullRequest.repository, link.repository) &&
          sameRepository(pullRequest.host, link.host),
      );
      rows.push({
        key: `${assignment.id}:${link.host}/${link.repository}#${link.number}`,
        assignmentId: assignment.id,
        assignmentTitle: assignment.title,
        projectId: lead.projectId,
        host: link.host,
        repository: link.repository,
        number: link.number,
        title: link.snapshot?.title ?? null,
        url: link.url,
        syncedAt: link.snapshot!.syncedAt,
        status: mergeStatus(assignment, link),
        protectedPaths: violation?.paths ?? [],
        awaitingAnswer: (violation?.paths ?? []).filter((path) => asked.has(path)),
        claimedAt: assignment.claimedAt ?? null,
        order: rows.length,
      });
    }
  }
  const ready = rows
    .filter((row) => row.status === "ready")
    .toSorted(
      (left, right) =>
        (left.claimedAt ?? "").localeCompare(right.claimedAt ?? "") || left.order - right.order,
    );
  return [...ready, ...rows.filter((row) => row.status !== "ready")].map(
    ({ claimedAt: _claimedAt, order: _order, ...row }) => row,
  );
}

/** Protected paths the factory holds the pull request for, with no ask waiting on the user. */
export const factoryMergeHeldPaths = (row: FactoryMergeRow) =>
  row.protectedPaths.filter((path) => !row.awaitingAnswer.includes(path));

/** What merging over protected paths asks the user to confirm, or null when there are none. */
export function factoryMergeConfirmText(row: FactoryMergeRow): string | null {
  if (row.protectedPaths.length === 0) return null;
  const held = factoryMergeHeldPaths(row);
  return [
    `Merge #${row.number} over its protected paths?`,
    ...(row.awaitingAnswer.length === 0
      ? []
      : [`Waiting for your answer on the team's card: ${row.awaitingAnswer.join(", ")}.`]),
    ...(held.length === 0 ? [] : [`The factory is holding it for: ${held.join(", ")}.`]),
    "Merging overrides the hold.",
  ].join("\n");
}
