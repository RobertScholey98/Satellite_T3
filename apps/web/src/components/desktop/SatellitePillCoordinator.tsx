import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  derivePendingRequests,
  threadRequestActivities,
} from "@t3tools/client-runtime/pending-requests";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import {
  type SatelliteAttentionEditor,
  type SatelliteAttentionIntent,
  type SatellitePillState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  togglePendingUserInputOptionSelection,
} from "../../pendingUserInput";
import {
  EMPTY_REQUEST_DRAFT,
  createPendingSubmission,
  editPendingRequestAnswer,
  hasPendingQuestionAttachments,
  isPendingDelivery,
  pendingRequestKey,
  pendingThreadKey,
  usePendingRequestStore,
} from "../../pendingRequestStore";
import { deriveSatelliteAttention, selectAttentionItem } from "../../satelliteAttention";
import { projectSatellitePill } from "../../satellitePill";
import {
  useThreadDetail,
  useThreadShell,
  useThreadShells,
  useThreadStatus,
} from "../../state/entities";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import { refreshThreadDetail } from "../../state/threads";
import {
  usePendingRequestResponse,
  usePendingRequestStatus,
} from "../../state/usePendingRequestResponse";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { readSatellitePillTheme, watchSatellitePillTheme } from "./satellitePillTheme";

function usePublishPill(projection: SatellitePillState) {
  const encoded = JSON.stringify(projection);
  useEffect(() => {
    const bridge = window.satelliteBridge;
    if (!bridge) return;
    const snapshot: SatellitePillState = JSON.parse(encoded);
    const publish = () =>
      bridge.publish({
        ...snapshot,
        theme: readSatellitePillTheme(),
        dark: document.documentElement.classList.contains("dark"),
      });
    publish();
    const stopWatchingTheme = watchSatellitePillTheme(publish);
    const heartbeat = window.setInterval(publish, 10_000);
    return () => {
      window.clearInterval(heartbeat);
      stopWatchingTheme();
    };
  }, [encoded]);
}

interface AttentionDetail {
  thread: EnvironmentThread | null;
  status: EnvironmentThreadStatus;
}

function AttentionThread({
  threadRef,
  onDetail,
}: {
  threadRef: ScopedThreadRef;
  onDetail: (key: string, detail: AttentionDetail | null) => void;
}) {
  const thread = useThreadDetail(threadRef);
  const status = useThreadStatus(threadRef);
  const key = pendingThreadKey(threadRef);
  useEffect(() => onDetail(key, { thread, status }), [key, onDetail, thread, status]);
  useEffect(() => () => onDetail(key, null), [key, onDetail]);
  return null;
}

function CurrentThread({
  threadRef,
  onProjection,
}: {
  threadRef: ScopedThreadRef;
  onProjection: (projection: SatellitePillState) => void;
}) {
  const thread = useThreadShell(threadRef);
  const detail = useThreadDetail(thread === null ? null : threadRef);
  const detailStatus = useThreadStatus(thread === null ? null : threadRef);
  const environment = useEnvironment(threadRef.environmentId);
  const shell = useAtomValue(environmentShell.stateValueAtom(threadRef.environmentId));
  const projection = projectSatellitePill({
    ref: threadRef,
    thread,
    connectionPhase: environment?.connection.phase ?? null,
    shellStatus: shell.status,
    projection: detailStatus === "live" ? detail?.projection : undefined,
  });
  const encoded = JSON.stringify(projection);
  useEffect(() => onProjection(JSON.parse(encoded)), [encoded, onProjection]);
  return null;
}

export function SatellitePillCoordinator() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const threadRef = resolveThreadRouteRef(params);
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const availability = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          environments.map((environment) => ({
            environmentId: environment.environmentId,
            label: environment.label,
            available:
              environment.connection.phase === "connected" &&
              get(environmentShell.stateValueAtom(environment.environmentId)).status === "live",
          })),
        ),
      [environments],
    ),
  );
  const drafts = usePendingRequestStore((state) => state.drafts);
  const selectedKey = usePendingRequestStore((state) => state.selectedKey);
  const attention = useMemo(
    () => deriveSatelliteAttention(threads, availability, drafts),
    [threads, availability, drafts],
  );
  const selected = selectAttentionItem(attention.items, selectedKey);
  const previousSummaries = useRef(new Map<string, ScopedThreadRef>());
  useEffect(() => {
    const current = new Map<string, ScopedThreadRef>();
    for (const thread of threads)
      for (const request of thread.pendingRequests ?? []) {
        const ref = {
          environmentId: thread.environmentId,
          threadId: thread.id,
          kind: request.kind,
          requestId: request.requestId,
        };
        current.set(pendingRequestKey(ref), ref);
      }
    const removable = new Set<string>();
    for (const [key, ref] of previousSummaries.current) {
      if (
        !current.has(key) &&
        availability.some(
          (environment) => environment.environmentId === ref.environmentId && environment.available,
        )
      )
        removable.add(key);
    }
    for (const [key, draft] of Object.entries(drafts))
      if (draft.delivery.phase === "resolved" && !current.has(key)) removable.add(key);
    previousSummaries.current = current;
    usePendingRequestStore.getState().forget(removable);
  }, [threads, availability, drafts]);
  const [details, setDetails] = useState<Record<string, AttentionDetail>>({});
  const onDetail = useCallback(
    (key: string, detail: AttentionDetail | null) =>
      setDetails((current) => {
        if (!detail) {
          const next = { ...current };
          delete next[key];
          return next;
        }
        const previous = current[key];
        return previous?.thread === detail.thread && previous?.status === detail.status
          ? current
          : { ...current, [key]: detail };
      }),
    [],
  );
  const [projection, setProjection] = useState(() =>
    projectSatellitePill({ ref: null, thread: null, connectionPhase: null, shellStatus: null }),
  );
  const sendSubmission = usePendingRequestResponse();
  const checkStatus = usePendingRequestStatus();
  const observed = new Map<string, ScopedThreadRef>();
  if (selected && (selected.ref.kind === "question" || selected.ref.kind === "approval"))
    observed.set(pendingThreadKey(selected.ref), selected.ref);
  for (const draft of Object.values(drafts))
    if (isPendingDelivery(draft.delivery) && draft.delivery.submission.audience === "work") {
      const ref = draft.delivery.submission.summary.ref;
      observed.set(pendingThreadKey(ref), ref);
    }
  useEffect(() => {
    if (selected && selectedKey !== pendingRequestKey(selected.ref))
      usePendingRequestStore.getState().select(selected.ref);
  }, [selected, selectedKey]);
  useEffect(() => {
    for (const item of attention.items) {
      const detail = details[pendingThreadKey(item.ref)];
      if (detail?.status === "live" && detail.thread)
        usePendingRequestStore
          .getState()
          .reconcile(item.ref, threadRequestActivities(detail.thread.projection));
    }
  }, [attention.items, details]);

  let editor: SatelliteAttentionEditor | null = null;
  if (selected) {
    const draft = drafts[pendingRequestKey(selected.ref)] ?? EMPTY_REQUEST_DRAFT;
    const detail = details[pendingThreadKey(selected.ref)];
    const pending = derivePendingRequests(
      detail?.thread ? threadRequestActivities(detail.thread.projection) : [],
    );
    const submission = isPendingDelivery(draft.delivery) ? draft.delivery.submission : undefined;
    const question =
      pending.userInputs.find((request) => request.requestId === selected.ref.requestId) ??
      submission?.question;
    const approval =
      pending.approvals.find((request) => request.requestId === selected.ref.requestId) ??
      submission?.approval;
    const notice = selected.ref.kind === "error" || selected.ref.kind === "review";
    editor = {
      ref: selected.ref,
      status: !selected.available
        ? "unavailable"
        : notice || (detail?.status === "live" && (question || approval))
          ? "ready"
          : detail?.status === "live"
            ? "resolved"
            : "loading",
      delivery: draft.delivery.phase === "resolved" ? "editing" : draft.delivery.phase,
      ...(draft.delivery.phase === "failed"
        ? { message: draft.delivery.message }
        : isPendingDelivery(draft.delivery) && draft.delivery.checkError
          ? { message: draft.delivery.checkError }
          : {}),
      answers: draft.answers,
      questionIndex: draft.questionIndex,
      ...(question ? { question } : {}),
      ...(approval ? { approval } : {}),
    };
  }
  const handleIntent = async (intent: SatelliteAttentionIntent) => {
    const store = usePendingRequestStore.getState();
    const key = pendingRequestKey(intent.ref);
    const summary = attention.items.find((item) => pendingRequestKey(item.ref) === key);
    if (!summary) return;
    if (intent.type === "select") {
      store.select(intent.ref);
      return;
    }
    if (intent.type === "mute" || intent.type === "restore") {
      store.updateDraft(key, (draft) => ({ ...draft, muted: intent.type === "mute" }));
      if (intent.type === "restore") store.select(intent.ref);
      return;
    }
    if (intent.type === "open-thread") {
      store.openInThread(intent.ref);
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: intent.ref.environmentId, threadId: intent.ref.threadId },
      });
      window.satelliteBridge?.openMain();
      return;
    }
    if (intent.type === "check-status") {
      if (!summary.available) return;
      const delivery = store.drafts[key]?.delivery;
      if (delivery && isPendingDelivery(delivery)) await checkStatus(delivery.submission);
      else refreshThreadDetail(intent.ref.environmentId, intent.ref.threadId);
      return;
    }
    if (!summary.available) return;
    const draft = store.drafts[key] ?? EMPTY_REQUEST_DRAFT;
    if (intent.type === "retry-delivery") {
      if (draft.delivery.phase !== "uncertain") return;
      const submission = draft.delivery.submission;
      store.updateDraft(key, (current) => ({
        ...current,
        delivery: { phase: "sending", submission },
      }));
      await sendSubmission(submission);
      return;
    }
    if (isPendingDelivery(draft.delivery) || draft.delivery.phase === "resolved") return;
    const detail = details[pendingThreadKey(intent.ref)];
    if (detail?.status !== "live" || !detail.thread) return;
    const pending = derivePendingRequests(threadRequestActivities(detail.thread.projection));
    const question = pending.userInputs.find(
      (request) => request.requestId === intent.ref.requestId,
    );
    const approval = pending.approvals.find(
      (request) => request.requestId === intent.ref.requestId,
    );
    if (intent.type === "answer") {
      const field = question?.questions.find((entry) => entry.id === intent.questionId);
      if (!field || (field.allowCustomAnswer === false && intent.answer.customAnswer?.trim()))
        return;
      store.updateDraft(key, (current) => ({
        ...current,
        answers: {
          ...current.answers,
          [intent.questionId]: editPendingRequestAnswer(
            current.answers[intent.questionId],
            intent.answer,
          ),
        },
      }));
      return;
    }
    if (intent.type === "question-index") {
      if (question)
        store.updateDraft(key, (current) => ({
          ...current,
          questionIndex: Math.min(intent.index, question.questions.length - 1),
        }));
      return;
    }
    if (intent.type === "toggle-option") {
      const field = question?.questions.find((entry) => entry.id === intent.questionId);
      if (
        !field ||
        !field.options.some((option) => (option.value ?? option.label) === intent.optionValue)
      )
        return;
      store.updateDraft(key, (current) => ({
        ...current,
        answers: {
          ...current.answers,
          [intent.questionId]: editPendingRequestAnswer(
            current.answers[intent.questionId],
            togglePendingUserInputOptionSelection(
              field,
              current.answers[intent.questionId],
              intent.optionValue,
            ),
          ),
        },
      }));
      return;
    }
    if (intent.type === "advance") {
      if (!question || hasPendingQuestionAttachments(draft.answers)) return;
      const progress = derivePendingUserInputProgress(
        question.questions,
        draft.answers,
        draft.questionIndex,
      );
      if (!progress.canAdvance) return;
      if (!progress.isLastQuestion) {
        store.updateDraft(key, (current) => ({
          ...current,
          questionIndex: progress.questionIndex + 1,
        }));
        return;
      }
    }
    const answers =
      question && !hasPendingQuestionAttachments(draft.answers)
        ? buildPendingUserInputAnswers(question.questions, draft.answers)
        : null;
    const response =
      intent.type === "approve" &&
      approval &&
      approval.responseCapability === "live" &&
      (approval.options?.some((option) => option.decision === intent.decision) ?? true)
        ? { kind: "approval" as const, decision: intent.decision }
        : (intent.type === "submit" || intent.type === "advance") &&
            question &&
            answers &&
            question.responseCapability !== "not_resumable"
          ? { kind: "question" as const, answers }
          : intent.type === "dismiss" &&
              question?.dismissible &&
              question.responseCapability !== "not_resumable"
            ? { kind: "dismiss" as const }
            : null;
    if (!response) return;
    const submission = createPendingSubmission(
      { response, summary, ...(question ? { question } : {}), ...(approval ? { approval } : {}) },
      threadRequestActivities(detail.thread.projection),
    );
    if (store.beginSubmission(intent.ref, submission)) await sendSubmission(submission);
  };
  const handleIntentRef = useRef(handleIntent);
  useEffect(() => {
    handleIntentRef.current = handleIntent;
  });
  useEffect(
    () =>
      window.satelliteBridge?.onAttentionIntent((intent) => {
        void handleIntentRef.current(intent);
      }),
    [],
  );
  const idle = projectSatellitePill({
    ref: null,
    thread: null,
    connectionPhase: null,
    shellStatus: null,
  });
  usePublishPill({
    ...(threadRef ? projection : idle),
    actionWing: { ...attention, selected: editor },
  });
  return (
    <>
      {threadRef ? <CurrentThread threadRef={threadRef} onProjection={setProjection} /> : null}
      {[...observed.entries()].map(([key, ref]) => (
        <AttentionThread key={key} threadRef={ref} onDetail={onDetail} />
      ))}
    </>
  );
}
