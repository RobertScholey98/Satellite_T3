import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";

import type { TimelineEntry } from "~/session-logic";
import { useFactoryManagers } from "./factoryState";
import { collapseFactoryPriming } from "./factoryWorkspaceLogic";
import { useIsFactoryManagerThread } from "./factoryWorkspaceState";

/**
 * Shown on a cold load while a manager's thread waits for the managers feed, so its priming never
 * flashes as a raw message before it is known.
 */
const PRIMING_LOADING: ReadonlyArray<TimelineEntry> = [
  {
    id: "factory-priming:loading",
    kind: "factory-priming",
    createdAt: "",
    prompt: null,
    reply: null,
    continued: false,
  },
];

// The timeline recomputes its rows whenever this array changes identity, and does so during
// render: a fresh fold per render would loop. One result is kept per entries array.
const folds = new WeakMap<
  ReadonlyArray<TimelineEntry>,
  { readonly primingMessageId: MessageId; readonly entries: ReadonlyArray<TimelineEntry> }
>();

function foldPriming(
  entries: ReadonlyArray<TimelineEntry>,
  primingMessageId: MessageId,
): ReadonlyArray<TimelineEntry> {
  const cached = folds.get(entries);
  if (cached?.primingMessageId === primingMessageId) return cached.entries;
  const folded = collapseFactoryPriming(entries, primingMessageId);
  folds.set(entries, { primingMessageId, entries: folded });
  return folded;
}

/**
 * The timeline entries of a thread, with a primed manager thread's first exchange folded into one
 * row. Only a manager's current thread reads the managers feed; every other thread passes through.
 */
export function useFactoryPrimedTimelineEntries(
  entries: ReadonlyArray<TimelineEntry>,
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<TimelineEntry> {
  const managerThread = useIsFactoryManagerThread(
    threadRef === null ? null : scopedThreadKey(threadRef),
  );
  const managers = useFactoryManagers(
    managerThread && threadRef !== null ? threadRef.environmentId : null,
  );
  if (!managerThread || threadRef === null) return entries;
  if (managers === undefined) return PRIMING_LOADING;
  const manager = managers.find((entry) => entry.threadId === threadRef.threadId);
  // Onboarding left a previous thread behind, so this one opened with the server's priming.
  const primingMessageId =
    manager?.onboardingThreadId == null ? null : (manager.primingMessageId ?? null);
  return primingMessageId === null ? entries : foldPriming(entries, primingMessageId);
}
