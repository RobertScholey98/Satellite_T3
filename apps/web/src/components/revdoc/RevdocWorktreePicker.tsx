import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { useMemo } from "react";
import { revdocEnvironment } from "~/state/revdoc";
import { useEnvironmentQuery } from "~/state/query";
import { useRevdocWorktree, useRevdocWorktreeStore } from "~/revdocWorktreeStore";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";

const THREAD_DEFAULT = "";
const basename = (path: string) => path.split(/[/\\]/).findLast(Boolean) ?? path;

/** Picks which worktree of the thread's repository Revdoc reviews and tests. */
export function RevdocWorktreePicker({
  threadRef,
  current,
}: {
  threadRef: ScopedThreadRef;
  /** The path Revdoc is currently reading, shown on the trigger. */
  current: string;
}) {
  const target = useMemo(
    () => ({ environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } }),
    [threadRef.environmentId, threadRef.threadId],
  );
  const listing = useEnvironmentQuery(revdocEnvironment.worktrees(target));
  const selected = useRevdocWorktree(threadRef);
  const defaultPath = listing.data?.defaultPath;
  const others = (listing.data?.worktrees ?? []).filter(
    (worktree) => worktree.path !== defaultPath,
  );
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="ghost" aria-label="Revdoc worktree" title={current} />}
      >
        <GitBranchIcon aria-hidden />
        <span className="truncate">{basename(current)}</span>
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <MenuGroupLabel>Review worktree</MenuGroupLabel>
          <MenuRadioGroup
            value={selected ?? THREAD_DEFAULT}
            onValueChange={(value: string) =>
              useRevdocWorktreeStore
                .getState()
                .setWorktree(threadRef, value === THREAD_DEFAULT ? null : value)
            }
          >
            <MenuRadioItem value={THREAD_DEFAULT} closeOnClick>
              <span className="block truncate">Thread default</span>
              {defaultPath && (
                <span className="block truncate text-xs text-muted-foreground">
                  {basename(defaultPath)}
                </span>
              )}
            </MenuRadioItem>
            {selected && !others.some((worktree) => worktree.path === selected) && (
              <MenuRadioItem value={selected} closeOnClick>
                <span className="block truncate">{basename(selected)}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {listing.isPending ? "Loading…" : "No longer available"}
                </span>
              </MenuRadioItem>
            )}
            {others.map((worktree) => (
              <MenuRadioItem key={worktree.path} value={worktree.path} closeOnClick>
                <span className="block truncate">{basename(worktree.path)}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {worktree.branch ?? "Detached HEAD"}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
