// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import {
  RuntimeRequestId,
  EnvironmentId,
  EventId,
  ThreadId,
  type SatelliteAttentionIntent,
  type SatellitePillState,
} from "@t3tools/contracts";
import {
  pendingRequestKey,
  usePendingRequestStore,
  type PendingSubmission,
} from "../../pendingRequestStore";
import { SatellitePillCoordinator } from "./SatellitePillCoordinator";
import { SatelliteActionPanel } from "./SatelliteActionWing";

const transport = vi.hoisted(() => ({
  send: vi.fn<(submission: PendingSubmission) => Promise<void>>(),
  status: vi.fn(),
  navigate: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [
    { environmentId: "local", label: "Local", available: true },
    { environmentId: "remote", label: "Remote", available: true },
  ],
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({}),
  useNavigate: () => transport.navigate,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  useEnvironment: () => null,
}));
vi.mock("../../state/shell", () => ({ environmentShell: { stateValueAtom: vi.fn() } }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { getRequestLifecycle: {} },
  refreshThreadDetail: (...args: unknown[]) => transport.refresh(...args),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => transport.status,
}));
vi.mock("../../state/usePendingRequestResponse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/usePendingRequestResponse")>()),
  usePendingRequestResponse: () => transport.send,
}));
vi.mock("../../state/entities", () => ({
  useThreadShells: () => shells,
  useThreadShell: () => null,
  useThreadStatus: () => "live",
  useThreadDetail: () => detail,
}));

const now = "2026-10-05T10:00:00.000Z";
const ref = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("shared-thread"),
  kind: "question" as const,
  requestId: RuntimeRequestId.make("shared-request"),
};
const remoteRef = { ...ref, environmentId: EnvironmentId.make("remote") };
const questions = [
  {
    id: "surfaces",
    header: "Surfaces",
    question: "Which clients?",
    multiSelect: true,
    allowCustomAnswer: true,
    options: [
      { label: "Web", value: "web-value", description: "Browser" },
      { label: "Desktop", value: "desktop-value", description: "Native" },
    ],
  },
];
const detail = {
  projection: {
    runtimeRequests: [
      {
        id: ref.requestId,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: DateTime.makeUnsafe(now),
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        type: "user_input_request",
        requestId: ref.requestId,
        questions,
        responseMode: "message",
      },
    ],
  },
};
const shells = [ref, remoteRef].map((entry) => ({
  id: entry.threadId,
  environmentId: entry.environmentId,
  title: "Build clients",
  archivedAt: null,
  settledOverride: "settled",
  settledAt: now,
  pendingRequests: [
    {
      kind: "question",
      requestId: entry.requestId,
      createdAt: now,
      label: "Surfaces",
      preview: "Which clients?",
    },
  ],
}));

describe("retained Satellite request coordinator", () => {
  let root: Root;
  let host: HTMLDivElement;
  let receive: (intent: SatelliteAttentionIntent) => void;
  let published: SatellitePillState;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
    vi.clearAllMocks();
    transport.status.mockResolvedValue(AsyncResult.success([]));
    usePendingRequestStore.setState({ drafts: {}, selectedKey: null, threadSelections: {} });
    window.satelliteBridge = {
      publish: (state) => {
        published = state;
      },
      hideMain: vi.fn(),
      setPinned: vi.fn(),
      setPositionsLinked: vi.fn(),
      openMain: vi.fn(),
      onShellState: () => () => {},
      onAttentionIntent: (listener) => {
        receive = listener;
        return () => {};
      },
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<SatellitePillCoordinator />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete window.satelliteBridge;
    vi.unstubAllGlobals();
  });

  it("reduces rapid choices before a roundtrip and submits the complete answer once to the owning environment", async () => {
    await act(async () => receive({ type: "select", ref: remoteRef }));
    await act(async () => {
      receive({
        type: "toggle-option",
        ref: remoteRef,
        questionId: "surfaces",
        optionValue: "web-value",
      });
      receive({
        type: "toggle-option",
        ref: remoteRef,
        questionId: "surfaces",
        optionValue: "desktop-value",
      });
      receive({ type: "advance", ref: remoteRef });
      receive({ type: "advance", ref: remoteRef });
    });
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.send.mock.calls[0]?.[0]).toMatchObject({
      summary: {
        ref: {
          environmentId: "remote",
          threadId: "shared-thread",
          kind: "question",
          requestId: "shared-request",
        },
      },
      response: { kind: "question", answers: { surfaces: ["web-value", "desktop-value"] } },
    });
    expect(usePendingRequestStore.getState().drafts[pendingRequestKey(ref)]).toBeUndefined();
  });

  it("keeps attachment metadata when editing from the pill and refuses to silently drop attachments", async () => {
    act(() =>
      usePendingRequestStore.getState().updateDraft(pendingRequestKey(ref), (draft) => ({
        ...draft,
        answers: { surfaces: { customAnswer: "See attached", attachmentCount: 1 } },
      })),
    );
    await act(async () => {
      receive({
        type: "answer",
        ref,
        questionId: "surfaces",
        answer: { customAnswer: "See the updated attachment", attachmentCount: 0 },
      });
      receive({ type: "submit", ref });
    });
    expect(published.actionWing?.selected?.answers).toEqual({
      surfaces: { customAnswer: "See the updated attachment", attachmentCount: 1 },
    });
    expect(transport.send).not.toHaveBeenCalled();
    await act(async () => receive({ type: "open-thread", ref }));
    expect(transport.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "local", threadId: "shared-thread" },
    });
    expect(
      usePendingRequestStore.getState().drafts[pendingRequestKey(ref)]?.answers.surfaces
        ?.customAnswer,
    ).toBe("See the updated attachment");
  });

  it("checks authoritative status without pretending that a receipt completed delivery", async () => {
    await act(async () => {
      receive({ type: "toggle-option", ref, questionId: "surfaces", optionValue: "web-value" });
      receive({ type: "advance", ref });
    });
    const submitted = transport.send.mock.calls[0]![0];
    act(() =>
      usePendingRequestStore
        .getState()
        .commandResult(pendingRequestKey(ref), submitted.commandId, false),
    );
    await act(async () => receive({ type: "check-status", ref }));
    expect(transport.status.mock.calls[0]?.[0]).toEqual({
      environmentId: "local",
      input: {
        threadId: "shared-thread",
        audience: "work",
        kind: "question",
        requestId: "shared-request",
        submittedAt: submitted.createdAt,
      },
    });
    expect(usePendingRequestStore.getState().drafts[pendingRequestKey(ref)]?.delivery.phase).toBe(
      "uncertain",
    );
    expect(transport.send).toHaveBeenCalledTimes(1);
    await act(async () => receive({ type: "retry-delivery", ref }));
    expect(transport.send.mock.calls[1]?.[0]).toBe(submitted);
  });

  it("shows a failed status lookup in the wing without unlocking or replacing its saved response", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    await act(async () => {
      receive({ type: "toggle-option", ref, questionId: "surfaces", optionValue: "web-value" });
      receive({ type: "advance", ref });
    });
    const submitted = transport.send.mock.calls[0]![0];
    act(() =>
      usePendingRequestStore
        .getState()
        .commandResult(pendingRequestKey(ref), submitted.commandId, false),
    );
    transport.status.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Could not check this request. Try again."))),
    );
    await act(async () => receive({ type: "check-status", ref }));
    expect(published.actionWing?.selected?.delivery).toBe("uncertain");
    expect(published.actionWing?.selected?.message).toBe(
      "Could not check this request. Try again.",
    );
    const current = usePendingRequestStore.getState().drafts[pendingRequestKey(ref)]?.delivery;
    expect(current && "submission" in current ? current.submission : null).toBe(submitted);
    const panelHost = document.createElement("div");
    document.body.append(panelHost);
    const panelRoot = createRoot(panelHost);
    try {
      await act(async () =>
        panelRoot.render(
          <SatelliteActionPanel
            view={published.actionWing!}
            layout={{
              mode: "panel",
              width: 440,
              height: 570,
              pill: { x: 0, y: 500, width: 320, height: 70 },
              wing: null,
              panel: { x: 0, y: 0, width: 440, height: 480 },
            }}
            dispatch={receive}
            close={vi.fn()}
          />,
        ),
      );
      expect(panelHost.querySelector('[role="alert"]')?.textContent).toBe(
        "Could not check this request. Try again.",
      );
      expect(panelHost.querySelector("textarea")?.disabled).toBe(true);
      expect(transport.send).toHaveBeenCalledTimes(1);
    } finally {
      act(() => panelRoot.unmount());
      panelHost.remove();
    }
  });
});
