// @vitest-environment jsdom
import {
  RuntimeRequestId,
  EnvironmentId,
  ThreadId,
  type SatelliteAttentionView,
  type SatellitePillBridge,
  type SatellitePillLayout,
  type SatellitePillState,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SatellitePillFace } from "./SatellitePillFace";
import { SatelliteActionPanel } from "./SatelliteActionWing";

function pointer(target: Element, type: string, x: number, y: number, pointerId = 1) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    screenX: x,
    screenY: y,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  target.dispatchEvent(event);
}

const compactLayout: SatellitePillLayout = {
  mode: "compact",
  width: 440,
  height: 568,
  pill: { x: 124, y: 512, width: 252, height: 56 },
  wing: { x: 376, y: 512, width: 64, height: 56 },
  panel: null,
};
const panelLayout: SatellitePillLayout = {
  mode: "panel",
  width: 440,
  height: 568,
  pill: { x: 124, y: 512, width: 252, height: 56 },
  wing: { x: 376, y: 512, width: 64, height: 56 },
  panel: { x: 0, y: 0, width: 440, height: 500 },
};
function attentionState(requestIds: string[]): SatellitePillState {
  return {
    threadId: null,
    environmentId: null,
    title: "Satellite",
    detail: "Requests",
    state: "awaiting-input",
    attention: true,
    actionWing: {
      items: requestIds.map((requestId) => ({
        ref: {
          kind: "question",
          environmentId: EnvironmentId.make("remote"),
          threadId: ThreadId.make("thread"),
          requestId: RuntimeRequestId.make(requestId),
        },
        title: "Build clients",
        environmentName: "Remote",
        label: "Clients",
        preview: "Which?",
        createdAt: "2026-10-05T10:00:00Z",
        available: true,
        muted: false,
      })),
      selected: null,
      incompleteEnvironments: [],
      workingCount: 0,
      completedCount: 0,
    },
  };
}

describe("standalone Satellite pill gestures", () => {
  let host: HTMLDivElement;
  let root: Root;
  let bridge: SatellitePillBridge;
  let listener: (state: SatellitePillState) => void;
  let layoutListener: (layout: SatellitePillLayout) => void;
  let opacityListener: ((opacity: number) => void) | undefined;
  const capture = new WeakMap<Element, number>();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperties(Element.prototype, {
      getAnimations: {
        configurable: true,
        value: () => [],
      },
      setPointerCapture: {
        configurable: true,
        value(this: Element, id: number) {
          capture.set(this, id);
        },
      },
      hasPointerCapture: {
        configurable: true,
        value(this: Element, id: number) {
          return capture.get(this) === id;
        },
      },
      releasePointerCapture: {
        configurable: true,
        value(this: Element) {
          capture.delete(this);
        },
      },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    bridge = {
      onOpacityChange: (next) => {
        opacityListener = next;
        return () => {
          opacityListener = undefined;
        };
      },
      openMain: vi.fn(),
      movePill: vi.fn(),
      beginPillDrag: vi.fn(),
      dispatchIntent: vi.fn(),
      setLayout: vi.fn(),
      onLayout: (next) => {
        layoutListener = next;
        return vi.fn();
      },
      onPillState: (next) => {
        listener = next;
        return vi.fn();
      },
    };
    act(() => root.render(<SatellitePillFace bridge={bridge} />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("fades the existing controls and releases the opacity subscription on unmount", () => {
    const face = host.querySelector<HTMLElement>('[data-satellite="widget"]')!;
    const button = host.querySelector('[data-satellite="pill-content"]');
    act(() => opacityListener?.(0.35));
    expect(face.style.opacity).toBe("0.35");
    act(() => opacityListener?.(0.8));
    expect(face.style.opacity).toBe("0.8");
    expect(host.querySelector('[data-satellite="pill-content"]')).toBe(button);
    act(() => opacityListener?.(1));
    expect(face.style.opacity).toBe("1");
    act(() => root.render(null));
    expect(opacityListener).toBeUndefined();
  });
  const latestRequest = () => {
    const request = vi.mocked(bridge.setLayout).mock.lastCall![0];
    if (!request.requestId) throw new Error("Renderer layout request did not include an ID");
    return { ...request, requestId: request.requestId };
  };
  it.each([false, true])(
    "keeps large %s-muted counts readable and exposes the exact total",
    (muted) => {
      const state = attentionState(Array.from({ length: 105 }, (_, index) => `request-${index}`));
      act(() =>
        listener({
          ...state,
          actionWing: {
            ...state.actionWing!,
            items: state.actionWing!.items.map((item) => ({ ...item, muted })),
          },
        }),
      );
      act(() => layoutListener({ ...compactLayout, requestId: latestRequest().requestId }));
      const wing = host.querySelector<HTMLButtonElement>('[data-satellite="action-wing"]')!;
      expect(wing.querySelector("strong")?.textContent).toBe("99+");
      expect(wing.getAttribute("aria-label")).toBe(
        muted ? "Show 105 muted requests" : "105 requests need attention",
      );
      act(() => wing.click());
      expect(latestRequest().mode).toBe("panel");
      act(() => layoutListener({ ...panelLayout, requestId: latestRequest().requestId }));
      expect(wing.getAttribute("aria-expanded")).toBe("true");
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
        muted ? "Muted requests" : "Needs your attention",
      );
    },
  );
  it.each(["pill-content", "pill"])(
    "hands off one drag started on %s and suppresses all trailing mouse clicks until a new press",
    (control) => {
      const button = host.querySelector<HTMLButtonElement>(`[data-satellite="${control}"]`)!;
      act(() => pointer(button, "pointerdown", 100, 100));
      expect(capture.get(button)).toBe(1);
      act(() => pointer(button, "pointermove", 103, 102));
      expect(bridge.beginPillDrag).not.toHaveBeenCalled();
      act(() => pointer(button, "pointermove", 107, 100));
      expect(bridge.beginPillDrag).toHaveBeenCalledOnce();
      act(() => pointer(button, "lostpointercapture", 107, 100));
      act(() => pointer(button, "pointermove", 200, 100));
      expect(bridge.beginPillDrag).toHaveBeenCalledOnce();
      for (let i = 0; i < 2; i++)
        act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
      expect(bridge.openMain).not.toHaveBeenCalled();
      act(() => pointer(button, "pointerdown", 200, 100));
      act(() => pointer(button, "pointerup", 200, 100));
      act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
      if (control === "pill-content") expect(bridge.openMain).toHaveBeenCalledOnce();
      else expect(bridge.openMain).not.toHaveBeenCalled();
      expect(host.querySelector('[data-satellite="pill-menu"]')).toBeNull();
    },
  );
  it("keeps keyboard activation available after native capture and supports arrow movement", () => {
    const button = host.querySelector<HTMLButtonElement>('[data-satellite="pill-content"]')!;
    act(() => pointer(button, "pointerdown", 0, 0));
    act(() => pointer(button, "pointermove", 10, 0));
    act(() => button.click());
    expect(bridge.openMain).toHaveBeenCalledOnce();
    act(() =>
      button.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowLeft",
          altKey: true,
          cancelable: true,
        }),
      ),
    );
    expect(bridge.movePill).toHaveBeenCalledWith("ArrowLeft");
  });
  it("updates the live conversation status without replacing controls during a gesture", () => {
    const button = host.querySelector<HTMLButtonElement>('[data-satellite="pill-content"]')!;
    act(() => pointer(button, "pointerdown", 100, 100));
    act(() =>
      listener({
        threadId: "t1",
        environmentId: "remote",
        title: "Running tests",
        detail: "Needs approval",
        state: "awaiting-input",
        attention: true,
      }),
    );
    expect(host.querySelector('[data-satellite="pill-content"]')).toBe(button);
    expect(host.textContent).toContain("Running tests");
    act(() => pointer(button, "pointermove", 110, 100));
    expect(bridge.beginPillDrag).toHaveBeenCalledOnce();
  });

  it("does not echo delayed native layout receipts while reopening after blur or moving the panel", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const compact = compactLayout;
    const panel = panelLayout;
    act(() =>
      listener({
        threadId: null,
        environmentId: null,
        title: "Satellite",
        detail: "Unavailable",
        state: "unknown",
        attention: false,
        actionWing: {
          items: [],
          selected: null,
          incompleteEnvironments: ["Remote"],
          workingCount: 0,
          completedCount: 0,
        },
      }),
    );
    act(() => layoutListener({ ...compact, requestId: latestRequest().requestId }));
    const wing = host.querySelector<HTMLButtonElement>('[data-satellite="action-wing"]')!;
    act(() => wing.click());
    act(() => layoutListener({ ...panel, requestId: latestRequest().requestId }));
    const settled = latestRequest();
    act(() => layoutListener({ ...panel, requestId: settled.requestId }));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    vi.mocked(bridge.setLayout).mockClear();

    act(() => layoutListener({ ...compact, requestId: settled.requestId }));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    act(() => wing.click());
    const opening = latestRequest();
    act(() => layoutListener({ ...panel, requestId: settled.requestId }));
    act(() => layoutListener({ ...compact, requestId: settled.requestId }));
    act(() => layoutListener({ ...panel, requestId: opening.requestId }));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(vi.mocked(bridge.setLayout).mock.calls.map(([request]) => request.mode)).toEqual([
      "panel",
    ]);

    act(() =>
      layoutListener({
        ...panel,
        requestId: opening.requestId,
        pill: { ...panel.pill, x: 0 },
        wing: { ...compact.wing!, x: 252, y: 512 },
      }),
    );
    expect(host.querySelector<HTMLElement>('[data-satellite="pill"]')?.style.left).toBe("0px");
    expect(bridge.setLayout).toHaveBeenCalledTimes(1);
    act(() => layoutListener({ ...compact, requestId: opening.requestId }));
    expect(wing.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(bridge.setLayout).toHaveBeenCalledTimes(1);
  });

  it("keeps an opening click pending when another request arrives before its native receipt", () => {
    act(() => listener(attentionState(["first"])));
    act(() => layoutListener({ ...compactLayout, requestId: latestRequest().requestId }));
    vi.mocked(bridge.setLayout).mockClear();
    const wing = host.querySelector<HTMLButtonElement>('[data-satellite="action-wing"]')!;

    act(() => wing.click());
    const opening = latestRequest();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    act(() => listener(attentionState(["first", "second"])));
    expect(vi.mocked(bridge.setLayout).mock.calls.map(([request]) => request.mode)).toEqual([
      "panel",
    ]);
    expect(wing.getAttribute("aria-label")).toBe("2 requests need attention");
    act(() => layoutListener({ ...panelLayout, requestId: opening.requestId }));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("preserves a pending close through content measurement and new request arrival", () => {
    let height = 158;
    let resize = () => {};
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, 440, height),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    act(() => listener(attentionState(["first"])));
    act(() => layoutListener({ ...panelLayout, requestId: latestRequest().requestId }));
    act(() => layoutListener({ ...panelLayout, requestId: latestRequest().requestId }));
    vi.mocked(bridge.setLayout).mockClear();
    const wing = host.querySelector<HTMLButtonElement>('[data-satellite="action-wing"]')!;

    act(() => wing.click());
    height = 300;
    act(() => resize());
    expect(vi.mocked(bridge.setLayout).mock.calls.map(([request]) => request.mode)).toEqual([
      "compact",
    ]);
    const closing = latestRequest();
    act(() => listener(attentionState(["first", "second"])));
    expect(bridge.setLayout).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => layoutListener({ ...compactLayout, requestId: closing.requestId }));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(bridge.setLayout).toHaveBeenCalledTimes(1);
  });

  it("acknowledges only the latest rapid toggle and accepts native collapse afterward", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, 440, 498),
    );
    act(() => listener(attentionState(["first"])));
    act(() => layoutListener({ ...compactLayout, requestId: latestRequest().requestId }));
    vi.mocked(bridge.setLayout).mockClear();
    const wing = host.querySelector<HTMLButtonElement>('[data-satellite="action-wing"]')!;

    act(() => wing.click());
    const first = latestRequest();
    act(() => wing.click());
    const second = latestRequest();
    act(() => wing.click());
    const third = latestRequest();
    expect([first.mode, second.mode, third.mode]).toEqual(["panel", "compact", "panel"]);
    expect(first.requestId).toBeTruthy();
    expect(new Set([first.requestId, second.requestId, third.requestId]).size).toBe(3);
    act(() => layoutListener({ ...panelLayout, requestId: first.requestId }));
    act(() => layoutListener({ ...compactLayout, requestId: second.requestId }));
    act(() => listener(attentionState(["first", "second"])));
    expect(bridge.setLayout).toHaveBeenCalledTimes(3);
    expect(host.querySelector('[role="dialog"]')).toBeNull();

    act(() => layoutListener({ ...panelLayout, requestId: third.requestId }));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => layoutListener({ ...compactLayout, requestId: third.requestId }));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(bridge.setLayout).toHaveBeenCalledTimes(3);
    act(() => listener(attentionState(["first", "second", "third"])));
    expect(latestRequest().mode).toBe("preview");
  });

  it("does not erase newer typing when a delayed option selection reaches the pill", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const ref = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("thread"),
      kind: "question" as const,
      requestId: RuntimeRequestId.make("request"),
    };
    const view: SatelliteAttentionView = {
      items: [
        {
          ref,
          title: "Build clients",
          environmentName: "Remote",
          label: "Clients",
          preview: "Which?",
          createdAt: "2026-10-05T10:00:00Z",
          available: true,
          muted: false,
        },
      ],
      selected: {
        ref,
        status: "ready",
        delivery: "editing",
        questionIndex: 0,
        answers: { clients: { customAnswer: "Original draft" } },
        question: {
          requestId: ref.requestId,
          createdAt: "2026-10-05T10:00:00Z",
          dismissible: true,
          questions: [
            {
              id: "clients",
              header: "Clients",
              question: "Which?",
              multiSelect: true,
              options: [{ label: "Web", description: "Browser" }],
            },
          ],
        },
      },
      incompleteEnvironments: [],
      workingCount: 0,
      completedCount: 0,
    };
    const render = (next: SatelliteAttentionView) =>
      root.render(
        <SatelliteActionPanel
          view={next}
          layout={{
            mode: "panel",
            width: 440,
            height: 556,
            pill: { x: 0, y: 500, width: 252, height: 56 },
            wing: null,
            panel: { x: 0, y: 0, width: 440, height: 480 },
          }}
          dispatch={bridge.dispatchIntent}
          close={vi.fn()}
        />,
      );
    act(() => render(view));
    const input = host.querySelector("textarea")!;
    expect(input.value).toBe("Original draft");
    const option = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Web"),
    )!;
    act(() => option.click());
    expect(input.value).toBe("");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "Newer custom answer",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() =>
      render({
        ...view,
        selected: { ...view.selected!, answers: { clients: { selectedOptionValues: ["Web"] } } },
      }),
    );
    expect(input.value).toBe("Newer custom answer");
  });
});
