import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";
import {
  createRevdocEnvironmentAtoms,
  createRevdocWorktreeChangesAtom,
  EMPTY_REVDOC_STATE,
  type RevdocState,
} from "@t3tools/client-runtime/revdoc";
import type { EnvironmentId, RevdocTarget, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "./query";
import { environmentThreadShells } from "./threads";

export const revdocEnvironment = createRevdocEnvironmentAtoms(connectionAtomRuntime);
const worktreeChanges = createRevdocWorktreeChangesAtom(
  environmentThreadShells.environmentThreadsAtom,
);
const NO_WORKTREE_CHANGES = Atom.make("");

/** The live Review for a thread's worktree. A revision gap restarts the subscription. */
export function useRevdocReview(
  environmentId: EnvironmentId | null,
  target: RevdocTarget | null,
): { readonly state: RevdocState; readonly error: string | null } {
  const query = useEnvironmentQuery(
    environmentId === null || target === null
      ? null
      : revdocEnvironment.review({ environmentId, input: target }),
  );
  const state = query.data ?? EMPTY_REVDOC_STATE;
  const { refresh } = query;
  useEffect(() => {
    if (state.gap) refresh();
  }, [state.gap, refresh]);
  // A deleted Review usually means its worktree went; refetch the list the picker reads.
  const worktrees = useEnvironmentQuery(
    environmentId === null || target === null
      ? null
      : revdocEnvironment.worktrees({ environmentId, input: { threadId: target.threadId } }),
  );
  const refreshWorktrees = worktrees.refresh;
  useEffect(() => {
    if (state.deleted) refreshWorktrees();
  }, [state.deleted, refreshWorktrees]);
  return { state, error: query.error };
}

export function useRevdocWorktrees(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const query = useEnvironmentQuery(
    environmentId === null || threadId === null
      ? null
      : revdocEnvironment.worktrees({ environmentId, input: { threadId } }),
  );
  const changes = useAtomValue(
    environmentId === null ? NO_WORKTREE_CHANGES : worktreeChanges(environmentId),
  );
  const seen = useRef(changes);
  const { refresh } = query;
  useEffect(() => {
    if (seen.current === changes) return;
    seen.current = changes;
    refresh();
  }, [changes, refresh]);
  return query.data;
}

/**
 * The worktree list the picker already loaded, for one-off reads such as a palette command.
 * Null until it has loaded, which keeps the stored pick.
 */
export function readRevdocWorktrees(environmentId: EnvironmentId, threadId: ThreadId) {
  return Option.getOrNull(
    AsyncResult.value(
      appAtomRegistry.get(revdocEnvironment.worktrees({ environmentId, input: { threadId } })),
    ),
  );
}
