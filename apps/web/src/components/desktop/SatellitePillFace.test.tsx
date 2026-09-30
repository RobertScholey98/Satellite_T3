// @vitest-environment jsdom
import type { SatellitePillBridge, SatellitePillState } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SatellitePillFace } from "./SatellitePillFace";

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
describe("standalone Satellite pill gestures", () => {
  let host: HTMLDivElement;
  let root: Root;
  let bridge: SatellitePillBridge;
  let listener: (state: SatellitePillState) => void;
  const capture = new WeakMap<Element, number>();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperties(Element.prototype, {
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
      openMain: vi.fn(),
      showMenu: vi.fn(),
      movePill: vi.fn(),
      beginPillDrag: vi.fn(),
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
    vi.unstubAllGlobals();
  });
  it.each(["pill-content", "pill-menu"])(
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
      expect(bridge.showMenu).not.toHaveBeenCalled();
      act(() => pointer(button, "pointerdown", 200, 100));
      act(() => pointer(button, "pointerup", 200, 100));
      act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
      expect(control === "pill-content" ? bridge.openMain : bridge.showMenu).toHaveBeenCalledOnce();
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
});
