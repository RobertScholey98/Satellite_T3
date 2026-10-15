import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRequestActivities } from "@t3tools/client-runtime/pending-requests";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import { isLatestRunSettled, type ThreadRunSummary } from "@t3tools/client-runtime/state/models";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type {
  OrchestrationThreadActivity,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";

import {
  deriveLatestContextWindowSnapshot,
  type ContextWindowSnapshot,
} from "../lib/contextWindow";
import {
  pendingThreadKey,
  prioritizePendingRequests,
  usePendingRequestStore,
} from "../pendingRequestStore";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type ActivePlanState,
  type TimelineEntry,
} from "../session-logic";
import type {
  ComposerTaskStep,
  ComposerTasksProgress,
} from "../components/chat/ComposerTasksBadge";
import type { ChatMessage } from "../types";
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

/**
 * The user messages of the visible timeline: a fork's inherited prompts and
 * sends the server has not acknowledged yet are in, question answers folded
 * into their request are out.
 */
export function selectPromptHistoryMessages(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<ChatMessage> {
  return entries.flatMap((entry) =>
    entry.kind === "message" &&
    entry.message.role === "user" &&
    // An answer paged in without its question still renders as a message.
    !entry.message.id.startsWith("async-answer:")
      ? [entry.message]
      : [],
  );
}

function samePrompts(left: ReadonlyArray<ChatMessage>, right: ReadonlyArray<ChatMessage>) {
  return (
    left.length === right.length &&
    left.every(
      (message, index) => message.id === right[index]?.id && message.text === right[index]?.text,
    )
  );
}

/**
 * The composer's ArrowUp recall history. The timeline is rebuilt on every
 * streamed token, so this keeps one identity until a prompt is added,
 * removed or edited.
 */
export function usePromptHistoryMessages(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<ChatMessage> {
  const next = selectPromptHistoryMessages(entries);
  const [current, setCurrent] = useState(next);
  if (samePrompts(current, next)) return current;
  setCurrent(next);
  return next;
}

function sameContent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) =>
      sameContent((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}

/** Keeps the previous value while a new one carries the same plain data. */
function useSameContent<T>(next: T): T {
  const [current, setCurrent] = useState(next);
  if (sameContent(current, next)) return current;
  setCurrent(next);
  return next;
}

/**
 * The composer's task strip for the running turn's own plan. A streamed token
 * rebuilds the plan and run objects without changing what the strip shows,
 * so the result keeps its identity until a step changes.
 */
export function useComposerTasks(
  activePlan: ActivePlanState | null,
  activityRun: Pick<ThreadRunSummary, "runId" | "status"> | null,
): {
  readonly progress: ComposerTasksProgress | null;
  readonly steps: ReadonlyArray<ComposerTaskStep> | null;
} {
  // deriveActivePlanState falls back to older runs' plans, which must not
  // label fresh work.
  const ownPlan =
    !isLatestRunSettled(activityRun) &&
    activePlan !== null &&
    activePlan.runId === (activityRun?.runId ?? null) &&
    activePlan.steps.length > 0
      ? activePlan
      : null;
  const progress = useSameContent(
    ownPlan === null
      ? null
      : {
          step:
            ownPlan.steps.find((candidate) => candidate.status === "inProgress")?.step ??
            ownPlan.steps.find((candidate) => candidate.status === "pending")?.step ??
            ownPlan.steps.at(-1)!.step,
          completedSteps: ownPlan.steps.filter((step) => step.status === "completed").length,
          totalSteps: ownPlan.steps.length,
        },
  );
  const steps = useSameContent(ownPlan?.steps ?? null);
  return { progress, steps };
}

/** User messages as the server holds them, including queued sends the timeline does not show yet. */
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
