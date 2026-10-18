import type { ThreadShell } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

type WorktreeThread = Pick<ThreadShell, "id" | "worktreePath" | "lineage">;

/**
 * Subagent threads are hidden in the sidebar and belong to the thread that delegated them, as
 * in server worktree cleanup, so they do not keep that thread's worktree shared.
 */
function isSubagentOf(
  byId: ReadonlyMap<string, WorktreeThread>,
  thread: WorktreeThread,
  ownerId: ThreadShell["id"],
): boolean {
  const seen = new Set<string>();
  let current: WorktreeThread | undefined = thread;
  while (current && current.lineage.relationshipToParent === "subagent" && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.lineage.parentThreadId === ownerId) return true;
    current = current.lineage.parentThreadId ? byId.get(current.lineage.parentThreadId) : undefined;
  }
  return false;
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<WorktreeThread>,
  threadId: ThreadShell["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const byId = new Map(threads.map((thread) => [thread.id as string, thread]));
  const isShared = threads.some((thread) => {
    if (thread.id === threadId || isSubagentOf(byId, thread, threadId)) {
      return false;
    }
    return normalizeWorktreePath(thread.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
