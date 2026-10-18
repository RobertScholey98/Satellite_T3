import { useEffect } from "react";
import {
  createRevdocEnvironmentAtoms,
  EMPTY_REVDOC_STATE,
  type RevdocState,
} from "@t3tools/client-runtime/revdoc";
import type { EnvironmentId, RevdocTarget, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const revdocEnvironment = createRevdocEnvironmentAtoms(connectionAtomRuntime);

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
  return { state, error: query.error };
}

export function useRevdocWorktrees(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const query = useEnvironmentQuery(
    environmentId === null || threadId === null
      ? null
      : revdocEnvironment.worktrees({ environmentId, input: { threadId } }),
  );
  return query.data;
}
