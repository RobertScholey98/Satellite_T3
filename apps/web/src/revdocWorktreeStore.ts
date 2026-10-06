import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

const MAX_THREADS = 200;

/**
 * The worktree each thread's Revdoc targets when the user picks one other
 * than the thread's own. Threads without an entry use the thread's worktree.
 */
interface RevdocWorktreeState {
  byThreadKey: Record<string, string>;
  setWorktree: (threadRef: ScopedThreadRef, worktreePath: string | null) => void;
}

export const useRevdocWorktreeStore = create<RevdocWorktreeState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      setWorktree: (threadRef, worktreePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(threadRef);
          const { [threadKey]: _previous, ...rest } = state.byThreadKey;
          if (worktreePath === null) return { byThreadKey: rest };
          return {
            byThreadKey: Object.fromEntries(
              [...Object.entries(rest), [threadKey, worktreePath]].slice(-MAX_THREADS),
            ),
          };
        }),
    }),
    {
      name: "t3code:revdoc-worktrees:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

export function useRevdocWorktree(threadRef: ScopedThreadRef | null): string | null {
  return useRevdocWorktreeStore((state) =>
    threadRef ? (state.byThreadKey[scopedThreadKey(threadRef)] ?? null) : null,
  );
}
