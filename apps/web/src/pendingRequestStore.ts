import type { PendingApproval, PendingUserInput } from "@t3tools/client-runtime/pending-requests";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  OrchestrationThreadActivity,
  ProviderApprovalDecision,
  SatelliteAttentionRef,
  SatelliteAttentionSummary,
  ScopedThreadRef,
  UserInputAttachments,
} from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import { create } from "zustand";
import type { PendingUserInputDraftAnswer } from "./pendingUserInput";
import { randomUUID } from "./lib/utils";

export type PendingResponse =
  | {
      kind: "question";
      answers: Record<string, unknown>;
      attachmentsByQuestionId?: UserInputAttachments;
    }
  | { kind: "approval"; decision: ProviderApprovalDecision }
  | { kind: "dismiss" };

export interface PendingSubmission {
  audience: "work" | "idea";
  commandId: CommandId;
  createdAt: string;
  response: PendingResponse;
  summary: SatelliteAttentionSummary;
  question?: PendingUserInput;
  approval?: PendingApproval;
  activityIds: ReadonlySet<string>;
  activitySequence: number;
}

export function createPendingSubmission(
  request: Omit<
    PendingSubmission,
    "commandId" | "createdAt" | "activityIds" | "activitySequence" | "audience"
  > & { audience?: "work" | "idea" },
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingSubmission {
  return {
    ...request,
    audience: request.audience ?? "work",
    commandId: CommandId.make(randomUUID()),
    createdAt: new Date().toISOString(),
    activityIds: new Set(activities.map((activity) => activity.id)),
    activitySequence: activities.reduce(
      (sequence, activity) => Math.max(sequence, activity.sequence ?? 0),
      0,
    ),
  };
}

export function recordPendingCommandResult(
  key: string,
  submission: PendingSubmission,
  result: AtomCommandResult<unknown, unknown>,
) {
  let rejection: string | undefined;
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    if (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error._tag === "OrchestrationDispatchCommandError" ||
        error._tag === "OrchestrationV2DispatchCommandError" ||
        error._tag === "EnvironmentAuthorizationError")
    ) {
      rejection =
        "message" in error && typeof error.message === "string"
          ? error.message
          : "The server rejected this response.";
    }
  }
  usePendingRequestStore
    .getState()
    .commandResult(key, submission.commandId, result._tag === "Success", rejection);
}

export type PendingDelivery =
  | { phase: "editing" }
  | {
      phase: "sending" | "awaiting-resolution" | "uncertain";
      submission: PendingSubmission;
      checkError?: string;
    }
  | { phase: "failed"; message: string }
  | { phase: "resolved" };

export interface PendingRequestDraft {
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  muted: boolean;
  delivery: PendingDelivery;
}

export function hasPendingQuestionAttachments(
  answers: Readonly<Record<string, PendingUserInputDraftAnswer>>,
): boolean {
  return Object.values(answers).some(
    (answer) => (answer.attachmentCount ?? 0) > 0 || answer.attachmentsBlocked === true,
  );
}

export function editPendingRequestAnswer(
  previous: PendingUserInputDraftAnswer | undefined,
  answer: PendingUserInputDraftAnswer,
): PendingUserInputDraftAnswer {
  return {
    ...(answer.customAnswer !== undefined ? { customAnswer: answer.customAnswer } : {}),
    ...(answer.selectedOptionValues
      ? { selectedOptionValues: [...answer.selectedOptionValues] }
      : {}),
    ...(previous?.attachmentCount !== undefined
      ? { attachmentCount: previous.attachmentCount }
      : {}),
    ...(previous?.attachmentsBlocked !== undefined
      ? { attachmentsBlocked: previous.attachmentsBlocked }
      : {}),
  };
}

export const EMPTY_REQUEST_DRAFT: PendingRequestDraft = {
  answers: {},
  questionIndex: 0,
  muted: false,
  delivery: { phase: "editing" },
};

export function pendingRequestKey(ref: SatelliteAttentionRef): string {
  return JSON.stringify([ref.environmentId, ref.threadId, ref.kind, ref.requestId]);
}

export function pendingThreadKey(ref: ScopedThreadRef): string {
  return JSON.stringify([ref.environmentId, ref.threadId]);
}

export function prioritizePendingRequests(
  requests: { approvals: PendingApproval[]; userInputs: PendingUserInput[] },
  selected: SatelliteAttentionRef | undefined,
) {
  const approvals =
    selected?.kind === "approval"
      ? [...requests.approvals].sort(
          (left, right) =>
            Number(right.requestId === selected.requestId) -
            Number(left.requestId === selected.requestId),
        )
      : requests.approvals;
  const userInputs =
    selected?.kind === "question"
      ? [...requests.userInputs].sort(
          (left, right) =>
            Number(right.requestId === selected.requestId) -
            Number(left.requestId === selected.requestId),
        )
      : requests.userInputs;
  return {
    approvals,
    userInputs,
    activeApproval:
      selected?.kind === "question" &&
      userInputs.some((request) => request.requestId === selected.requestId)
        ? null
        : (approvals[0] ?? null),
  };
}

export function isPendingDelivery(
  delivery: PendingDelivery,
): delivery is Extract<PendingDelivery, { submission: PendingSubmission }> {
  return "submission" in delivery;
}

export function reconcilePendingDelivery(
  ref: SatelliteAttentionRef,
  delivery: PendingDelivery,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingDelivery {
  if (ref.kind !== "question" && ref.kind !== "approval") return delivery;
  const kind = ref.kind === "question" ? "user-input" : "approval";
  const related = activities.filter((activity) => {
    const payload = activity.payload;
    return (
      typeof payload === "object" &&
      payload !== null &&
      "requestId" in payload &&
      payload.requestId === ref.requestId
    );
  });
  if (
    related.some(
      (activity) => activity.kind === `${kind}.resolved` || activity.kind === `${kind}.cancelled`,
    )
  )
    return delivery.phase === "resolved" ? delivery : { phase: "resolved" };
  const pending = derivePendingRequests(related);
  const stillPending = (ref.kind === "question" ? pending.userInputs : pending.approvals).some(
    (request) => request.requestId === ref.requestId,
  );
  if (!stillPending && related.some((activity) => activity.kind === `${kind}.requested`))
    return delivery.phase === "resolved" ? delivery : { phase: "resolved" };
  if (!isPendingDelivery(delivery)) return delivery;
  const failure = related.findLast(
    (activity) =>
      activity.kind === `provider.${kind}.respond.failed` &&
      !delivery.submission.activityIds.has(activity.id) &&
      (activity.sequence === undefined
        ? activity.createdAt === delivery.submission.createdAt
        : activity.sequence > delivery.submission.activitySequence),
  );
  if (!failure) return delivery;
  const payload = failure.payload;
  const message =
    typeof payload === "object" &&
    payload !== null &&
    "detail" in payload &&
    typeof payload.detail === "string"
      ? payload.detail
      : "The agent could not receive this response. Try again.";
  return { phase: "failed", message };
}

interface PendingRequestStore {
  drafts: Record<string, PendingRequestDraft>;
  selectedKey: string | null;
  threadSelections: Record<string, SatelliteAttentionRef>;
  updateDraft: (key: string, update: (draft: PendingRequestDraft) => PendingRequestDraft) => void;
  select: (ref: SatelliteAttentionRef) => void;
  openInThread: (ref: SatelliteAttentionRef) => void;
  beginSubmission: (ref: SatelliteAttentionRef, submission: PendingSubmission) => boolean;
  commandResult: (key: string, commandId: CommandId, accepted: boolean, rejection?: string) => void;
  reconcile: (
    ref: SatelliteAttentionRef,
    activities: ReadonlyArray<OrchestrationThreadActivity>,
  ) => void;
  forget: (keys: ReadonlySet<string>) => void;
}

export const usePendingRequestStore = create<PendingRequestStore>((set, get) => ({
  drafts: {},
  selectedKey: null,
  threadSelections: {},
  updateDraft: (key, update) =>
    set((state) => {
      const previous = state.drafts[key] ?? EMPTY_REQUEST_DRAFT;
      const next = update(previous);
      return previous === next ? state : { drafts: { ...state.drafts, [key]: next } };
    }),
  select: (ref) => set({ selectedKey: pendingRequestKey(ref) }),
  openInThread: (ref) =>
    set((state) => ({
      selectedKey: pendingRequestKey(ref),
      threadSelections: { ...state.threadSelections, [pendingThreadKey(ref)]: ref },
    })),
  beginSubmission: (ref, submission) => {
    const key = pendingRequestKey(ref);
    const draft = get().drafts[key] ?? EMPTY_REQUEST_DRAFT;
    if (isPendingDelivery(draft.delivery) || draft.delivery.phase === "resolved") return false;
    get().updateDraft(key, (current) => ({
      ...current,
      delivery: { phase: "sending", submission },
    }));
    return true;
  },
  commandResult: (key, commandId, accepted, rejection) =>
    get().updateDraft(key, (draft) => {
      if (!isPendingDelivery(draft.delivery) || draft.delivery.submission.commandId !== commandId)
        return draft;
      return {
        ...draft,
        delivery: rejection
          ? { phase: "failed", message: rejection }
          : {
              phase: accepted ? "awaiting-resolution" : "uncertain",
              submission: draft.delivery.submission,
            },
      };
    }),
  reconcile: (ref, activities) =>
    get().updateDraft(pendingRequestKey(ref), (draft) => {
      const delivery = reconcilePendingDelivery(ref, draft.delivery, activities);
      return delivery === draft.delivery ? draft : { ...draft, delivery };
    }),
  forget: (keys) =>
    set((state) => {
      const removable = [...keys].filter(
        (key) => !isPendingDelivery(state.drafts[key]?.delivery ?? EMPTY_REQUEST_DRAFT.delivery),
      );
      if (!removable.length) return state;
      const drafts = { ...state.drafts };
      for (const key of removable) delete drafts[key];
      return {
        drafts,
        selectedKey:
          state.selectedKey && removable.includes(state.selectedKey) ? null : state.selectedKey,
        threadSelections: Object.fromEntries(
          Object.entries(state.threadSelections).filter(
            ([, ref]) => !removable.includes(pendingRequestKey(ref)),
          ),
        ),
      };
    }),
}));
