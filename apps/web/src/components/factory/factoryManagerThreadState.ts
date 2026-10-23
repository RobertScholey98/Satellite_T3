import type { ScopedThreadRef } from "@t3tools/contracts";

import type { TimelineEntry } from "~/session-logic";
import { useFactoryManagers } from "./factoryState";
import { useFactoryWorkspaceFeed } from "./factoryWorkspaceState";
import { collapseFactoryPriming } from "./factoryWorkspaceLogic";

/**
 * The timeline entries of a thread, with a primed manager thread's first exchange folded into one
 * row. Only a manager's thread subscribes to the managers feed; every other thread passes through.
 */
export function useFactoryPrimedTimelineEntries(
  entries: ReadonlyArray<TimelineEntry>,
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<TimelineEntry> {
  const feed = useFactoryWorkspaceFeed(threadRef?.environmentId ?? null);
  const managerThread =
    threadRef !== null &&
    feed?.managers.some((manager) => manager.threadId === threadRef.threadId) === true;
  const managers = useFactoryManagers(managerThread ? threadRef.environmentId : null);
  // Onboarding left a previous thread behind, so this one opened with the server's priming.
  const primed =
    managerThread &&
    managers?.some(
      (manager) => manager.threadId === threadRef.threadId && manager.onboardingThreadId !== null,
    ) === true;
  return primed ? collapseFactoryPriming(entries) : entries;
}
