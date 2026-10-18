import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRevdocWorktree, useRevdocWorktreeStore } from "~/revdocWorktreeStore";
import { useRevdocWorktrees } from "~/state/revdoc";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const THREAD_DEFAULT = "thread-default";

const worktreeName = (path: string) => path.slice(path.replace(/[\\/]+$/, "").search(/[^\\/]*$/));

/** Points the Revdoc panel at another worktree of the same repository, remembered per thread. */
export function RevdocWorktreePicker({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const picked = useRevdocWorktree(threadRef);
  const worktrees = useRevdocWorktrees(threadRef.environmentId, threadRef.threadId);
  const choices = (worktrees?.worktrees ?? []).filter(
    (worktree) => worktree.path !== worktrees?.defaultPath,
  );
  const label = (path: string, branch: string | null) =>
    branch ? `${branch} (${worktreeName(path)})` : worktreeName(path);
  const items: Record<string, string> = {
    [THREAD_DEFAULT]: "Thread default",
    ...Object.fromEntries(
      choices.map((worktree) => [worktree.path, label(worktree.path, worktree.branch)]),
    ),
  };
  const value = picked !== null && picked in items ? picked : THREAD_DEFAULT;
  return (
    <Select
      value={value}
      items={items}
      onValueChange={(next) =>
        useRevdocWorktreeStore
          .getState()
          .setWorktree(threadRef, next === THREAD_DEFAULT || next === null ? null : String(next))
      }
    >
      <SelectTrigger size="xs" aria-label="Worktree to review">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {Object.entries(items).map(([path, text]) => (
          <SelectItem key={path} value={path}>
            {text}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
