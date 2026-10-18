import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const REVDOC_WORKTREE_MEMORY_LIMIT = 200;

/**
 * Records the worktree a thread's Revdoc panel targets; null returns the thread to its own
 * worktree. The most recently picked threads are kept, up to the limit.
 */
export function rememberRevdocWorktree(
  byThreadKey: Readonly<Record<string, string>>,
  threadKey: string,
  worktreePath: string | null,
): Record<string, string> {
  const { [threadKey]: _previous, ...rest } = byThreadKey;
  if (worktreePath === null) return rest;
  const entries = [...Object.entries(rest), [threadKey, worktreePath] as const];
  return Object.fromEntries(entries.slice(-REVDOC_WORKTREE_MEMORY_LIMIT));
}

interface RevdocWorktreeStoreState {
  byThreadKey: Record<string, string>;
  setWorktree: (ref: ScopedThreadRef, worktreePath: string | null) => void;
}

export const useRevdocWorktreeStore = create<RevdocWorktreeStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      setWorktree: (ref, worktreePath) =>
        set((state) => ({
          byThreadKey: rememberRevdocWorktree(
            state.byThreadKey,
            scopedThreadKey(ref),
            worktreePath,
          ),
        })),
    }),
    {
      name: "satellite:revdoc-worktrees:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

export function useRevdocWorktree(ref: ScopedThreadRef | null): string | null {
  return useRevdocWorktreeStore((state) =>
    ref === null ? null : (state.byThreadKey[scopedThreadKey(ref)] ?? null),
  );
}

export function readRevdocWorktree(ref: ScopedThreadRef): string | null {
  return useRevdocWorktreeStore.getState().byThreadKey[scopedThreadKey(ref)] ?? null;
}
