import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRequestActivities } from "@t3tools/client-runtime/pending-requests";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type {
  OrchestrationThreadActivity,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import {
  deriveLatestContextWindowSnapshot,
  type ContextWindowSnapshot,
} from "../lib/contextWindow";
import {
  pendingThreadKey,
  prioritizePendingRequests,
  usePendingRequestStore,
} from "../pendingRequestStore";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { environmentThreadDetails } from "./threads";

/*
 * Per-thread view model: narrow selectors over the thread detail atoms for
 * the chat chrome around the timeline (composer, header). Every selector
 * keeps its previous value while a streaming delta leaves its slice alone,
 * so a memoized consumer renders only when the slice it shows changes.
 */

const EMPTY_USER_MESSAGES: ReadonlyArray<OrchestrationV2ConversationMessage> = Object.freeze([]);
const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = Object.freeze([]);
const EMPTY_PENDING_REQUESTS: PendingThreadRequests = Object.freeze({
  approvals: [],
  userInputs: [],
});

function threadRefFromKey(key: string): ScopedThreadRef {
  const ref = parseScopedThreadKey(key);
  if (ref === null) throw new Error(`Invalid thread key: ${key}`);
  return ref;
}

const userMessagesAtomFamily = Atom.family((key: string) => {
  const ref = threadRefFromKey(key);
  let previous = EMPTY_USER_MESSAGES;
  return Atom.make((get) => {
    const messages = get(environmentThreadDetails.threadAtom(ref))?.projection.messages ?? [];
    const next = messages.filter((message) => message.role === "user");
    if (!arrayElementsEqual(previous, next))
      previous = next.length === 0 ? EMPTY_USER_MESSAGES : next;
    return previous;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`thread-view-model:user-messages:${key}`));
});

const requestActivitiesAtomFamily = Atom.family((key: string) => {
  const ref = threadRefFromKey(key);
  let previousInputs: readonly [unknown, ReadonlyArray<unknown>] | null = null;
  let previous = EMPTY_ACTIVITIES;
  return Atom.make((get) => {
    const projection = get(environmentThreadDetails.threadAtom(ref))?.projection ?? null;
    if (projection === null || projection.runtimeRequests.length === 0) {
      previousInputs = null;
      previous = EMPTY_ACTIVITIES;
      return previous;
    }
    const requestItems = projection.turnItems.filter(
      (item) => item.type === "approval_request" || item.type === "user_input_request",
    );
    if (
      previousInputs === null ||
      previousInputs[0] !== projection.runtimeRequests ||
      !arrayElementsEqual(previousInputs[1], requestItems)
    ) {
      previousInputs = [projection.runtimeRequests, requestItems];
      previous = threadRequestActivities(projection);
    }
    return previous;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`thread-view-model:request-activities:${key}`));
});

function latestTokenUsage(
  turns: OrchestrationV2ThreadProjection["providerTurns"],
): OrchestrationV2ProviderTurnTokenUsage | null {
  // The newest turn with a report wins; stale turns keep the meter alive between turns.
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const usage = turns[index]?.tokenUsage;
    if (usage !== undefined) return usage;
  }
  return null;
}

function snapshotsEqual(left: ContextWindowSnapshot | null, right: ContextWindowSnapshot | null) {
  if (left === null || right === null) return left === right;
  const keys = Object.keys(left) as Array<keyof ContextWindowSnapshot>;
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

const contextWindowAtomFamily = Atom.family((key: string) => {
  const ref = threadRefFromKey(key);
  let previous: ContextWindowSnapshot | null = null;
  return Atom.make((get) => {
    const projection = get(environmentThreadDetails.threadAtom(ref))?.projection ?? null;
    const next = deriveLatestContextWindowSnapshot(
      get(environmentThreadDetails.visibleTurnItemsAtom(ref)),
      projection ? latestTokenUsage(projection.providerTurns) : null,
      projection?.providerThreads.find(
        (thread) => thread.id === projection.thread.activeProviderThreadId,
      ),
    );
    if (!snapshotsEqual(previous, next)) previous = next;
    return previous;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`thread-view-model:context-window:${key}`));
});

const EMPTY_USER_MESSAGES_ATOM = Atom.make(EMPTY_USER_MESSAGES);
const EMPTY_ACTIVITIES_ATOM = Atom.make(EMPTY_ACTIVITIES);
const EMPTY_PENDING_REQUESTS_ATOM = Atom.make<PendingThreadRequests | null>(null);
const EMPTY_CONTEXT_WINDOW_ATOM = Atom.make<ContextWindowSnapshot | null>(null);

/** The thread's sent prompts, in order, for the composer's ArrowUp recall. */
export function useThreadUserMessages(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationV2ConversationMessage> {
  return useAtomValue(
    ref === null ? EMPTY_USER_MESSAGES_ATOM : userMessagesAtomFamily(scopedThreadKey(ref)),
  );
}

/** Request activities the pending-request store reconciles and responses cite. */
export function useThreadRequestActivities(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationThreadActivity> {
  return useAtomValue(
    ref === null ? EMPTY_ACTIVITIES_ATOM : requestActivitiesAtomFamily(scopedThreadKey(ref)),
  );
}

export function useThreadContextWindow(ref: ScopedThreadRef | null): ContextWindowSnapshot | null {
  return useAtomValue(
    ref === null ? EMPTY_CONTEXT_WINDOW_ATOM : contextWindowAtomFamily(scopedThreadKey(ref)),
  );
}

/** Pending approvals and questions, ordered with the user's selected request first. */
export function useThreadPendingRequests(ref: ScopedThreadRef | null) {
  const pending =
    useAtomValue(
      ref === null
        ? EMPTY_PENDING_REQUESTS_ATOM
        : environmentThreadDetails.pendingRequestsAtom(ref),
    ) ?? EMPTY_PENDING_REQUESTS;
  const requests = useMemo(
    () => ({
      approvals: derivePendingApprovals(pending.approvals),
      userInputs: derivePendingUserInputs(pending.userInputs),
    }),
    [pending],
  );
  const selectedRequest = usePendingRequestStore((state) =>
    ref === null ? undefined : state.threadSelections[pendingThreadKey(ref)],
  );
  return useMemo(
    () => prioritizePendingRequests(requests, selectedRequest),
    [requests, selectedRequest],
  );
}
