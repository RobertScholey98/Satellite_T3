import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  RuntimeRequestId,
  CommandId,
  EnvironmentId,
  EventId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  type OrchestrationThreadActivity,
  type SatelliteAttentionSummary,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import {
  EMPTY_REQUEST_DRAFT,
  createPendingSubmission,
  pendingRequestKey,
  pendingThreadKey,
  prioritizePendingRequests,
  recordPendingCommandResult,
  usePendingRequestStore,
} from "./pendingRequestStore";
import {
  deriveSatelliteAttention,
  selectAttentionItem,
  type AttentionThread,
} from "./satelliteAttention";

const timestamp = "2026-10-05T10:00:00.000Z";
const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("thread-1");
const ref = {
  environmentId,
  threadId,
  kind: "question" as const,
  requestId: RuntimeRequestId.make("request-1"),
};
const key = pendingRequestKey(ref);
const summary: SatelliteAttentionSummary = {
  ref,
  title: "Choose a database",
  environmentName: "Local",
  label: "Storage",
  preview: "Which database?",
  createdAt: timestamp,
  available: true,
  muted: false,
};
const question = {
  responseCapability: "message" as const,
  requestId: ref.requestId,
  createdAt: timestamp,
  dismissible: true,
  questions: [
    {
      id: "db",
      header: "Storage",
      question: "Which database?",
      multiSelect: false,
      options: [{ label: "Postgres", value: "pg", description: "Transactional" }],
    },
  ],
};
const environments = [{ environmentId, label: "Local", available: true }];

function thread(overrides: Partial<AttentionThread> = {}): AttentionThread {
  return {
    environmentId,
    id: threadId,
    title: "Choose a database",
    interactionMode: "default",
    latestRun: null,
    pendingBackgroundTasks: [],
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: true,
    hasActionableProposedPlan: false,
    runtime: null,
    pendingRequests: [
      {
        kind: "question",
        requestId: ref.requestId,
        createdAt: timestamp,
        label: "Storage",
        preview: "Which database?",
      },
    ],
    ...overrides,
  };
}

function activity(
  kind: string,
  sequence: number,
  payload: Record<string, unknown> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`event-${sequence}`),
    kind,
    sequence,
    summary: kind,
    tone: "info",
    turnId: null,
    createdAt: timestamp,
    payload: { requestId: ref.requestId, ...payload },
  };
}
const requested = activity("user-input.requested", 1, {
  questions: question.questions,
  responseMode: "message",
});
function submission(activities = [requested], id = "command-1") {
  return {
    ...createPendingSubmission(
      { summary, question, response: { kind: "question", answers: { db: "pg" } } },
      activities,
    ),
    commandId: CommandId.make(id),
  };
}

beforeEach(() =>
  usePendingRequestStore.setState({ drafts: {}, selectedKey: null, threadSelections: {} }),
);

describe("Satellite request ownership", () => {
  it("lists individual requests and keeps identical IDs in different environments separate", () => {
    const remote = EnvironmentId.make("remote");
    const view = deriveSatelliteAttention(
      [
        thread({
          pendingRequests: [
            {
              kind: "question",
              requestId: ref.requestId,
              createdAt: timestamp,
              label: "Storage",
              preview: "Which database?",
            },
            {
              kind: "approval",
              requestId: ref.requestId,
              createdAt: timestamp,
              label: "Command",
              preview: "Approval required",
            },
          ],
        }),
        thread({ environmentId: remote }),
      ],
      [...environments, { environmentId: remote, label: "Remote", available: true }],
      {},
    );
    expect(
      view.items.map((item) => [item.ref.environmentId, item.ref.kind, item.ref.requestId]),
    ).toEqual([
      ["local", "approval", "request-1"],
      ["local", "question", "request-1"],
      ["remote", "question", "request-1"],
    ]);
    expect(view.incompleteEnvironments).toEqual([]);
  });

  it("keeps saved answers and the selected second request through a thread handoff", () => {
    const second = { ...ref, requestId: RuntimeRequestId.make("request-2") };
    const secondKey = pendingRequestKey(second);
    const store = usePendingRequestStore.getState();
    store.updateDraft(secondKey, (draft) => ({
      ...draft,
      answers: { db: { customAnswer: "Keep SQLite for now" } },
      questionIndex: 1,
    }));
    store.openInThread(second);
    expect(usePendingRequestStore.getState().threadSelections[pendingThreadKey(ref)]).toEqual(
      second,
    );
    expect(usePendingRequestStore.getState().drafts[secondKey]).toEqual({
      answers: { db: { customAnswer: "Keep SQLite for now" } },
      questionIndex: 1,
      muted: false,
      delivery: { phase: "editing" },
    });
    const items = [summary, { ...summary, ref: second }];
    expect(
      selectAttentionItem(
        [...items, { ...summary, ref: { ...ref, requestId: RuntimeRequestId.make("arrival") } }],
        secondKey,
      )?.ref.requestId,
    ).toBe("request-2");
  });

  it("opens the selected question even when its thread also has an approval", () => {
    const second = { ...question, requestId: RuntimeRequestId.make("second-question") };
    const approval = {
      responseCapability: "live" as const,
      requestId: RuntimeRequestId.make("approval"),
      createdAt: timestamp,
      requestKind: "command" as const,
    };
    const selected = prioritizePendingRequests(
      { approvals: [approval], userInputs: [question, second] },
      { ...ref, requestId: second.requestId },
    );
    expect(selected.activeApproval).toBeNull();
    expect(selected.approvals).toEqual([approval]);
    expect(selected.userInputs.map((request) => request.requestId)).toEqual([
      "second-question",
      "request-1",
    ]);
    expect(
      prioritizePendingRequests(
        { approvals: [approval], userInputs: [question] },
        { ...ref, requestId: second.requestId },
      ).activeApproval,
    ).toEqual(approval);
  });

  it.each(["resolved", "cancelled"])(
    "retains accepted responses after the shell clears and releases %s requests",
    (status) => {
      const store = usePendingRequestStore.getState();
      const sent = submission();
      expect(store.beginSubmission(ref, sent)).toBe(true);
      expect(store.beginSubmission(ref, submission([], "second-command"))).toBe(false);
      store.commandResult(key, sent.commandId, true);
      expect(usePendingRequestStore.getState().drafts[key]?.delivery.phase).toBe(
        "awaiting-resolution",
      );
      const view = deriveSatelliteAttention(
        [thread({ pendingRequests: [], hasPendingUserInput: false })],
        environments,
        usePendingRequestStore.getState().drafts,
      );
      expect(view.items.map((item) => item.ref.requestId)).toEqual(["request-1"]);
      store.reconcile(ref, [requested, activity(`user-input.${status}`, 2)]);
      expect(
        deriveSatelliteAttention([thread()], environments, usePendingRequestStore.getState().drafts)
          .items,
      ).toEqual([]);
    },
  );

  it("restores editing after a newer provider failure without losing a draft or changing selection", () => {
    const store = usePendingRequestStore.getState();
    store.updateDraft(key, (draft) => ({
      ...draft,
      answers: { db: { selectedOptionValues: ["pg"] } },
    }));
    store.beginSubmission(ref, submission());
    const other = { ...ref, requestId: RuntimeRequestId.make("other") };
    store.select(other);
    const failed = activity("provider.user-input.respond.failed", 2, {
      detail: "Provider not ready",
    });
    store.reconcile(ref, [requested, failed]);
    expect(usePendingRequestStore.getState().drafts[key]).toMatchObject({
      answers: { db: { selectedOptionValues: ["pg"] } },
      delivery: { phase: "failed", message: "Provider not ready" },
    });
    expect(usePendingRequestStore.getState().selectedKey).toBe(pendingRequestKey(other));
    const retry = submission([requested, failed], "retry-command");
    expect(store.beginSubmission(ref, retry)).toBe(true);
    store.reconcile(ref, [requested, failed]);
    store.commandResult(key, CommandId.make("command-1"), false);
    expect(usePendingRequestStore.getState().drafts[key]?.delivery).toMatchObject({
      phase: "sending",
      submission: { commandId: "retry-command" },
    });
  });

  it("keeps uncertainty distinct from a known server rejection", () => {
    const store = usePendingRequestStore.getState();
    const sent = submission();
    store.beginSubmission(ref, sent);
    recordPendingCommandResult(
      key,
      sent,
      AsyncResult.failure(Cause.fail(new Error("Socket closed"))),
    );
    expect(usePendingRequestStore.getState().drafts[key]?.delivery).toMatchObject({
      phase: "uncertain",
      submission: { commandId: "command-1", response: { kind: "question", answers: { db: "pg" } } },
    });
    expect(store.beginSubmission(ref, submission([], "duplicate"))).toBe(false);
    recordPendingCommandResult(
      key,
      sent,
      AsyncResult.failure(
        Cause.fail({ _tag: "OrchestrationV2DispatchCommandError", message: "Invalid answer" }),
      ),
    );
    expect(usePendingRequestStore.getState().drafts[key]?.delivery).toEqual({
      phase: "failed",
      message: "Invalid answer",
    });
    expect(store.beginSubmission(ref, submission([], "corrected"))).toBe(true);
  });

  it("ignores a historical unsequenced failure loaded after a newer attempt", () => {
    const store = usePendingRequestStore.getState();
    const sent = { ...submission(), createdAt: "2026-10-05T12:00:00.000Z" };
    store.beginSubmission(ref, sent);
    const failure = {
      id: EventId.make("historical-failure"),
      kind: "provider.user-input.respond.failed",
      summary: "Failed",
      tone: "info" as const,
      turnId: null,
      createdAt: "2026-10-05T09:00:00.000Z",
      payload: { requestId: ref.requestId, detail: "Earlier attempt failed" },
    };
    store.reconcile(ref, [requested, failure]);
    expect(usePendingRequestStore.getState().drafts[key]?.delivery.phase).toBe("sending");
    store.reconcile(ref, [
      requested,
      failure,
      {
        ...failure,
        id: EventId.make("current-failure"),
        createdAt: sent.createdAt,
        payload: { requestId: ref.requestId, detail: "Current attempt failed" },
      },
    ]);
    expect(usePendingRequestStore.getState().drafts[key]?.delivery).toEqual({
      phase: "failed",
      message: "Current attempt failed",
    });
  });

  it("mutes only the pill and restores the same saved request", () => {
    const store = usePendingRequestStore.getState();
    store.updateDraft(key, (draft) => ({
      ...draft,
      muted: true,
      answers: { db: { customAnswer: "SQLite" } },
    }));
    const muted = deriveSatelliteAttention(
      [thread()],
      environments,
      usePendingRequestStore.getState().drafts,
    );
    expect(muted.items).toHaveLength(1);
    expect(selectAttentionItem(muted.items, key)).toBeNull();
    store.updateDraft(key, (draft) => ({ ...draft, muted: false }));
    expect(
      selectAttentionItem(
        deriveSatelliteAttention([thread()], environments, usePendingRequestStore.getState().drafts)
          .items,
        key,
      )?.ref,
    ).toEqual(ref);
    expect(usePendingRequestStore.getState().drafts[key]?.answers).toEqual({
      db: { customAnswer: "SQLite" },
    });
  });

  it("releases resolved drafts and thread selection while preserving pending evidence", () => {
    const store = usePendingRequestStore.getState();
    store.beginSubmission(ref, submission());
    store.openInThread(ref);
    store.forget(new Set([key]));
    expect(usePendingRequestStore.getState().drafts[key]?.delivery.phase).toBe("sending");
    store.reconcile(ref, [requested, activity("user-input.resolved", 2)]);
    store.forget(new Set([key]));
    expect(usePendingRequestStore.getState().drafts).toEqual({});
    expect(usePendingRequestStore.getState().threadSelections).toEqual({});
  });
});

describe("Satellite activity and coverage", () => {
  it("keeps unsupported summaries distinct from a known empty queue and disables offline requests", () => {
    const { pendingRequests: _pending, ...old } = thread();
    expect(deriveSatelliteAttention([old], environments, {}).incompleteEnvironments).toEqual([
      "Local",
    ]);
    expect(
      deriveSatelliteAttention([thread({ pendingRequests: [] })], environments, {})
        .incompleteEnvironments,
    ).toEqual([]);
    const view = deriveSatelliteAttention([thread()], [{ ...environments[0]!, available: false }], {
      [key]: EMPTY_REQUEST_DRAFT,
    });
    expect(view.items[0]?.available).toBe(false);
    expect(view.incompleteEnvironments).toEqual(["Local"]);
  });

  it("counts active work without historical completions or stale turn states", () => {
    const turn = {
      runId: RunId.make("run-1"),
      status: "completed" as const,
      requestedAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
      assistantMessageId: null,
    };
    const runtime = {
      status: "running" as const,
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      activeRunId: turn.runId,
      lastError: null,
      updatedAt: timestamp,
    };
    const make = (id: string, overrides: Partial<AttentionThread>) =>
      thread({
        id: ThreadId.make(id),
        pendingRequests: [],
        hasPendingUserInput: false,
        ...overrides,
      });
    const view = deriveSatelliteAttention(
      [
        make("settled", { latestRun: turn, settledAt: timestamp }),
        make("finished", { latestRun: turn }),
        make("restarted", { latestRun: { ...turn, status: "failed" }, runtime }),
        make("stopped", {
          latestRun: { ...turn, status: "running" },
          runtime: { ...runtime, status: "cancelled" },
        }),
        make("monitor", { pendingBackgroundTasks: [{ taskId: "monitor", kind: "monitor" }] }),
        make("old-plan", { hasActionableProposedPlan: true, latestRun: turn }),
        make("review", {
          hasActionableProposedPlan: true,
          latestRun: turn,
          interactionMode: "plan",
        }),
      ],
      environments,
      {},
    );
    expect(view.workingCount).toBe(2);
    expect(view.completedCount).toBe(2);
    expect(view.items.map((item) => [item.ref.threadId, item.ref.kind])).toEqual([
      ["review", "review"],
    ]);
  });
});
