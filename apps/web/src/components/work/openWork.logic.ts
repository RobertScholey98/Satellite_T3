import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, OpenWorktreeSummary, ProjectId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

type OwnerCandidate = Pick<
  EnvironmentThreadShell,
  "worktreePath" | "lineage" | "updatedAt" | "linkedPullRequest" | "branchPullRequest"
>;

/**
 * The thread that owns a worktree: among threads in that worktree, one that is not a subagent,
 * then the most recently updated. A delegated task in its own worktree is the only match there.
 */
export function resolveWorktreeOwner<T extends OwnerCandidate>(
  threads: ReadonlyArray<T>,
  worktreePath: string,
): T | null {
  const target = normalizeProjectPathForComparison(worktreePath);
  let owner: T | null = null;
  for (const thread of threads) {
    if (
      thread.worktreePath === null ||
      normalizeProjectPathForComparison(thread.worktreePath) !== target
    ) {
      continue;
    }
    if (owner === null || outranks(thread, owner)) owner = thread;
  }
  return owner;
}

function outranks(candidate: OwnerCandidate, current: OwnerCandidate) {
  const candidateIsSubagent = candidate.lineage.relationshipToParent === "subagent";
  const currentIsSubagent = current.lineage.relationshipToParent === "subagent";
  if (candidateIsSubagent !== currentIsSubagent) return currentIsSubagent;
  return Date.parse(candidate.updatedAt) > Date.parse(current.updatedAt);
}

type PullRequestSource = Pick<
  EnvironmentThreadShell,
  "projectId" | "pullRequests" | "linkedPullRequest" | "branchPullRequest"
>;

export interface OwnerPullRequest {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly host: string | null;
}

/**
 * The owner's pull request: the newest one linked to the thread, else its single linked pull
 * request, else the one open for its branch. The link dialog fills only the list.
 */
export function ownerPullRequest(owner: PullRequestSource | null): OwnerPullRequest | null {
  if (owner === null) return null;
  const newest = owner.pullRequests
    .filter((link) => link.source !== "stack-dismissed")
    .toSorted((left, right) => right.linkedAt.localeCompare(left.linkedAt))[0];
  if (newest) {
    return {
      projectId: owner.projectId,
      repository: newest.repository,
      number: newest.number,
      host: newest.host,
    };
  }
  const single = owner.linkedPullRequest ?? owner.branchPullRequest;
  return single
    ? {
        projectId: single.projectId,
        repository: single.repository,
        number: single.number,
        host: null,
      }
    : null;
}

export type WorktreeSelection =
  | { readonly kind: "selected"; readonly worktree: OpenWorktreeSummary }
  /** The requested worktree is not in the list, usually because it was removed. */
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "none" };

/**
 * An explicit request always wins, even when that worktree is gone. Without one, the remembered
 * worktree when it still exists, else the first listed.
 */
export function selectWorktree(
  worktrees: ReadonlyArray<OpenWorktreeSummary>,
  requested: string | undefined,
  remembered: string | undefined,
): WorktreeSelection {
  const find = (path: string) => {
    const target = normalizeProjectPathForComparison(path);
    return worktrees.find(
      (worktree) => normalizeProjectPathForComparison(worktree.path) === target,
    );
  };
  if (requested !== undefined) {
    const worktree = find(requested);
    return worktree ? { kind: "selected", worktree } : { kind: "missing", path: requested };
  }
  const worktree = (remembered === undefined ? undefined : find(remembered)) ?? worktrees[0];
  return worktree ? { kind: "selected", worktree } : { kind: "none" };
}

export interface OpenWorkTarget {
  readonly environmentId?: EnvironmentId;
  readonly worktreePath?: string;
}

const LAST_SELECTION_KEY = "satellite:open-work:last-selection:v1";

export function readLastOpenWorkSelection(): OpenWorkTarget {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LAST_SELECTION_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return {};
    const environmentId = "environmentId" in value ? value.environmentId : undefined;
    const worktreePath = "worktreePath" in value ? value.worktreePath : undefined;
    return {
      ...(typeof environmentId === "string" && environmentId
        ? { environmentId: environmentId as EnvironmentId }
        : {}),
      ...(typeof worktreePath === "string" && worktreePath ? { worktreePath } : {}),
    };
  } catch {
    return {};
  }
}

export function writeLastOpenWorkSelection(target: OpenWorkTarget) {
  try {
    localStorage.setItem(LAST_SELECTION_KEY, JSON.stringify(target));
  } catch {
    // Storage can be unavailable; the selection then lasts only for this visit.
  }
}
