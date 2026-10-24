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
  readonly status: FactoryMergeRowStatus;
  /** Protected paths the pull request changes; merging it overrides the factory's hold. */
  readonly protectedPaths: ReadonlyArray<string>;
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
    const lead =
      assignment.leadThreadId === null ? undefined : leadThreads.get(assignment.leadThreadId);
    if (!lead) continue;
    const links = visibleThreadPullRequests(lead.pullRequests)
      .filter((link) => link.snapshot?.state === "open")
      .toSorted((left, right) => left.number - right.number);
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
        status: mergeStatus(assignment, link),
        protectedPaths: violation?.paths ?? [],
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
