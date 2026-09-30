import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import type {
  EnvironmentId,
  IssueAttempt,
  IssueBoardView,
  OpenWorkDocument,
  OpenWorkTimelineResult,
  OpenWorktreeSummary,
} from "@t3tools/contracts";
import type { OpenWorkDiffSelection } from "./OpenWorkDiffPanel";

export type OpenWorkSnapshot = {
  worktrees: readonly OpenWorktreeSummary[];
  selectedId: string | null;
  timeline: OpenWorkTimelineResult | null;
  favorites: readonly OpenWorkDocument[];
  attempts: readonly IssueAttempt[];
  diff: OpenWorkDiffSelection | null;
  board?: { attemptId: string; view: IssueBoardView } | null;
  opened: {
    documentId: string;
    title: string;
    format: string;
    content: string;
    truncated: boolean;
    live: boolean;
    cwd: string;
  } | null;
};
const snapshots = new Map<EnvironmentId, OpenWorkSnapshot>();
const storageKey = "t3:open-work-selection:v1";
export function readOpenWorkSnapshot(
  environmentId: EnvironmentId | undefined,
  requestedPath?: string,
) {
  if (!environmentId) return undefined;
  const snapshot = snapshots.get(environmentId);
  if (!snapshot) return undefined;
  if (
    requestedPath &&
    (!snapshot.timeline ||
      normalizeProjectPathForComparison(snapshot.timeline.worktree.path) !==
        normalizeProjectPathForComparison(requestedPath))
  ) {
    return { ...snapshot, selectedId: null, timeline: null, diff: null, opened: null };
  }
  return snapshot;
}
export function saveOpenWorkSnapshot(environmentId: EnvironmentId, snapshot: OpenWorkSnapshot) {
  snapshots.delete(environmentId);
  snapshots.set(environmentId, {
    ...snapshot,
    opened: snapshot.opened && snapshot.opened.content.length <= 512_000 ? snapshot.opened : null,
  });
  while (snapshots.size > 6) snapshots.delete(snapshots.keys().next().value!);
}
export function readOpenWorkSelection():
  | { environmentId: EnvironmentId; worktreePath?: string }
  | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (
      !value ||
      typeof value !== "object" ||
      !("environmentId" in value) ||
      typeof value.environmentId !== "string" ||
      !value.environmentId ||
      value.environmentId.length > 1024
    )
      return undefined;
    const worktreePath =
      "worktreePath" in value &&
      typeof value.worktreePath === "string" &&
      value.worktreePath.length <= 8192
        ? value.worktreePath
        : undefined;
    return {
      environmentId: value.environmentId as EnvironmentId,
      ...(worktreePath ? { worktreePath } : {}),
    };
  } catch {
    return undefined;
  }
}
export function saveOpenWorkSelection(environmentId: EnvironmentId, worktreePath?: string) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ environmentId, worktreePath }));
  } catch {
    /* Storage may be unavailable. */
  }
}
