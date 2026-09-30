import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useCallback, useSyncExternalStore, type SetStateAction } from "react";

let lastIdea: ScopedThreadRef | null = null;
export const readLastIdea = () => lastIdea;
export const rememberIdea = (ref: ScopedThreadRef) => {
  lastIdea = ref;
};

const values = new Map<string, Map<string, unknown>>();
const listeners = new Map<string, Set<() => void>>();
const positions = new Map<string, Map<string, number>>();

export function useIdeaValue<T>(key: string, resource: string, initial: T) {
  const read = useCallback(() => {
    const workspace = values.get(key) ?? new Map<string, unknown>();
    if (!workspace.has(resource)) workspace.set(resource, initial);
    values.set(key, workspace);
    return workspace.get(resource) as T;
  }, [initial, key, resource]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const group = listeners.get(key) ?? new Set<() => void>();
      group.add(listener);
      listeners.set(key, group);
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(key);
      };
    },
    [key],
  );
  const value = useSyncExternalStore(subscribe, read);
  const set = useCallback(
    (next: SetStateAction<T>) => {
      const previous = read();
      const resolved = typeof next === "function" ? (next as (current: T) => T)(previous) : next;
      if (Object.is(previous, resolved)) return;
      values.get(key)!.set(resource, resolved);
      listeners.get(key)?.forEach((listener) => listener());
    },
    [key, read, resource],
  );
  return [value, set] as const;
}

export function readIdeaPosition(key: string, resource: string): number {
  return positions.get(key)?.get(resource) ?? 0;
}

export function saveIdeaPosition(key: string, resource: string, offset: number) {
  const workspace = positions.get(key) ?? new Map<string, number>();
  workspace.set(resource, offset);
  positions.set(key, workspace);
}

export function forgetIdeaWorkspace(key: string) {
  if (lastIdea && scopedThreadKey(lastIdea.environmentId, lastIdea.threadId) === key)
    lastIdea = null;
  values.delete(key);
  positions.delete(key);
}

export const knownIdeaWorkspaceKeys = () => [...values.keys()];
