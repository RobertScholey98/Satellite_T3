// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { RuntimeRequestId, EnvironmentId, EventId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import {
  createPendingSubmission,
  pendingRequestKey,
  usePendingRequestStore,
} from "../../pendingRequestStore";
import { PendingRequestDelivery } from "./PendingRequestDelivery";

const commands = vi.hoisted(() => ({
  answer: vi.fn(),
  approve: vi.fn(),
  dismiss: vi.fn(),
  status: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: "answer" | "approve" | "dismiss" | "status" }) =>
    commands[command.label],
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    respondToUserInput: { label: "answer" },
    respondToApproval: { label: "approve" },
    dismissUserInput: { label: "dismiss" },
    getRequestLifecycle: { label: "status" },
  },
  refreshThreadDetail: (...args: unknown[]) => commands.refresh(...args),
}));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  commands.answer.mockResolvedValue(AsyncResult.success(undefined));
  commands.status.mockResolvedValue(AsyncResult.success([]));
  usePendingRequestStore.setState({ drafts: {}, selectedKey: null, threadSelections: {} });
});
afterEach(() => vi.unstubAllGlobals());

it.each(["work", "idea"] as const)(
  "lets %s chat check and replay an uncertain response without changing its command or payload",
  async (audience) => {
    const ref = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("thread"),
      kind: "question" as const,
      requestId: RuntimeRequestId.make("request"),
    };
    const key = pendingRequestKey(ref);
    const submission = createPendingSubmission(
      {
        audience,
        summary: {
          ref,
          title: "Question",
          environmentName: "Remote",
          createdAt: "2026-10-05T12:00:00Z",
          label: "Question",
          preview: "Which?",
          available: true,
          muted: false,
        },
        response: { kind: "question", answers: { choice: "keep" } },
      },
      [],
    );
    const store = usePendingRequestStore.getState();
    store.beginSubmission(ref, submission);
    store.commandResult(key, submission.commandId, false);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(<PendingRequestDelivery requestKey={key} unavailable={false} />),
      );
      expect(host.textContent).toContain("Response delivery is unconfirmed");
      const check = [...host.querySelectorAll("button")].find(
        (button) => button.textContent === "Check status",
      )!;
      const retry = [...host.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry saved response",
      )!;
      await act(async () => check.click());
      expect(commands.status).toHaveBeenCalledWith({
        environmentId: "remote",
        input: {
          threadId: "thread",
          audience,
          kind: "question",
          requestId: "request",
          submittedAt: submission.createdAt,
        },
      });
      expect(commands.refresh).toHaveBeenCalledWith("remote", "thread", audience);
      expect(commands.answer).not.toHaveBeenCalled();
      expect(host.textContent).toContain("Response delivery is unconfirmed");
      commands.status.mockResolvedValueOnce(
        AsyncResult.failure(Cause.fail(new Error("This request is too large to check here."))),
      );
      await act(async () => check.click());
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        "This request is too large to check here.",
      );
      expect(usePendingRequestStore.getState().drafts[key]?.delivery).toMatchObject({
        phase: "uncertain",
        submission,
      });
      await act(async () => {
        retry.click();
        retry.click();
      });
      expect(commands.answer).toHaveBeenCalledTimes(1);
      expect(commands.answer.mock.calls[0]?.[0]).toEqual({
        environmentId: "remote",
        input: {
          threadId: "thread",
          requestId: "request",
          answers: { choice: "keep" },
          commandId: submission.commandId,
          createdAt: submission.createdAt,
        },
      });
      expect(host.textContent).toContain("Waiting for the agent to confirm");
      expect(host.textContent).not.toContain("Retry saved response");
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it("uses request lifecycle evidence when the resumed detail window has lost the terminal activity", async () => {
  const ref = {
    environmentId: EnvironmentId.make("remote"),
    threadId: ThreadId.make("long-thread"),
    kind: "approval" as const,
    requestId: RuntimeRequestId.make("old-approval"),
  };
  const key = pendingRequestKey(ref);
  const submission = createPendingSubmission(
    {
      response: { kind: "approval", decision: "accept" },
      summary: {
        ref,
        title: "Long-running task",
        environmentName: "Remote",
        createdAt: "2026-10-05T12:00:00Z",
        label: "Approval",
        preview: "Run command?",
        available: true,
        muted: false,
      },
    },
    [],
  );
  const store = usePendingRequestStore.getState();
  store.beginSubmission(ref, submission);
  store.commandResult(key, submission.commandId, true);
  store.reconcile(ref, []);
  commands.status.mockResolvedValue(
    AsyncResult.success([
      {
        id: EventId.make("old-terminal"),
        kind: "approval.resolved",
        tone: "info",
        summary: "Approved",
        createdAt: submission.createdAt,
        turnId: null,
        sequence: 22,
        payload: { requestId: "old-approval" },
      },
    ]),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<PendingRequestDelivery requestKey={key} unavailable={false} />),
    );
    expect(host.textContent).toContain("Waiting for the agent to confirm");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(usePendingRequestStore.getState().drafts[key]?.delivery).toEqual({ phase: "resolved" });
    expect(host.textContent).toBe("");
    expect(commands.approve).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
