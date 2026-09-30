// @vitest-environment jsdom
// @effect-diagnostics nodeBuiltinImport:off - Load the real stylesheet because unit tests stub CSS imports.
import * as NodeFS from "node:fs";
import type { SatelliteBridge, SatellitePillState, SatelliteShellState } from "@t3tools/contracts";
import { Dialog } from "@base-ui/react/dialog";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SatelliteDesktopShell } from "./SatelliteDesktopShell";

const shellCss = NodeFS.readFileSync(`${import.meta.dirname}/SatelliteDesktopShell.css`, "utf8");

const workspaceState: SatelliteShellState = {
  mode: "workspace",
  phase: "settled",
  transitionId: 1,
  pillBounds: { x: 180, y: 640, width: 320, height: 70 },
  workspaceSize: { width: 1100, height: 760 },
};

function dispatchPointer(
  target: EventTarget,
  type: string,
  { pointerId = 1, ...init }: MouseEventInit & { pointerId?: number } = {},
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  target.dispatchEvent(event);
}

describe("Satellite desktop shell", () => {
  let root: Root;
  let host: HTMLDivElement;
  let shellListener: (state: SatelliteShellState) => void;
  let pillListener: (state: SatellitePillState) => void;
  let bridge: SatelliteBridge;
  let shellStyles: HTMLStyleElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("innerWidth", 1100);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        media: "",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    host = document.createElement("div");
    host.id = "root";
    document.body.append(host);
    root = createRoot(host);
    shellStyles = document.createElement("style");
    shellStyles.textContent = `[data-test-backdrop] { visibility: visible; transition: all 200ms; }\n${shellCss}`;
    document.head.append(shellStyles);
    const captures = new WeakMap<Element, number>();
    Object.defineProperties(Element.prototype, {
      setPointerCapture: {
        configurable: true,
        value(this: Element, pointerId: number) {
          captures.set(this, pointerId);
        },
      },
      hasPointerCapture: {
        configurable: true,
        value(this: Element, pointerId: number) {
          return captures.get(this) === pointerId;
        },
      },
      releasePointerCapture: {
        configurable: true,
        value(this: Element) {
          captures.delete(this);
        },
      },
    });
    bridge = {
      getZoomFactor: vi.fn(() => 1),
      publish: vi.fn(),
      hideMain: vi.fn(),
      openMain: vi.fn(),
      showMenu: vi.fn(),
      movePill: vi.fn(),
      beginPillDrag: vi.fn(),
      updatePillDrag: vi.fn(),
      endPillDrag: vi.fn(),
      finishTransition: vi.fn(),
      setPinned: vi.fn(),
      onShellState: (listener) => {
        shellListener = listener;
        return () => undefined;
      },
      onPillState: (listener) => {
        pillListener = listener;
        return () => undefined;
      },
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    shellStyles.remove();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
    for (const method of ["setPointerCapture", "hasPointerCapture", "releasePointerCapture"]) {
      Reflect.deleteProperty(Element.prototype, method);
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps content and menu clicks when pointer movement stays below the drag threshold", async () => {
    await act(async () =>
      root.render(
        <SatelliteDesktopShell bridge={bridge}>
          <div />
        </SatelliteDesktopShell>,
      ),
    );
    for (const selector of ['[data-satellite="pill-title"]', '[data-satellite="pill-menu"] svg']) {
      const target = host.querySelector(selector)!;
      await act(async () => {
        dispatchPointer(target, "pointerdown", { screenX: 100, screenY: 200 });
        dispatchPointer(target, "pointermove", { screenX: 103, screenY: 204 });
        dispatchPointer(target, "pointerup", { screenX: 103, screenY: 204 });
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      });
    }
    expect(bridge.beginPillDrag).not.toHaveBeenCalled();
    expect(bridge.openMain).toHaveBeenCalledOnce();
    expect(bridge.showMenu).toHaveBeenCalledOnce();
  });

  it.each(["pill-title", "pill-menu", "pill-dot", "pill"])(
    "drags from %s without opening or showing the menu, then allows keyboard activation",
    async (part) => {
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      });
      vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
      await act(async () =>
        root.render(
          <SatelliteDesktopShell bridge={bridge}>
            <div />
          </SatelliteDesktopShell>,
        ),
      );
      const target = host.querySelector(`[data-satellite="${part}"]`)!;
      await act(async () => {
        dispatchPointer(target, "pointerdown", { screenX: 100, screenY: 200 });
        dispatchPointer(target, "pointermove", { screenX: 130, screenY: 200, pointerId: 2 });
      });
      expect(bridge.beginPillDrag).not.toHaveBeenCalled();
      await act(async () => {
        dispatchPointer(target, "pointermove", { screenX: 106, screenY: 200 });
        dispatchPointer(target, "pointermove", { screenX: 120, screenY: 210 });
        dispatchPointer(target, "pointermove", { screenX: 130, screenY: 220 });
      });
      expect(bridge.beginPillDrag).toHaveBeenCalledOnce();
      expect(bridge.updatePillDrag).not.toHaveBeenCalled();
      expect(frames.size).toBe(1);
      await act(async () => {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(0);
      });
      expect(bridge.updatePillDrag).toHaveBeenCalledOnce();
      await act(async () => {
        dispatchPointer(target, "pointermove", { screenX: 140, screenY: 230 });
        dispatchPointer(target, "pointerup", { screenX: 145, screenY: 235 });
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      });
      expect(frames.size).toBe(0);
      expect(bridge.endPillDrag).toHaveBeenCalledOnce();
      expect(bridge.openMain).not.toHaveBeenCalled();
      expect(bridge.showMenu).not.toHaveBeenCalled();
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-satellite="pill-content"]')!.click(),
      );
      expect(bridge.openMain).toHaveBeenCalledOnce();
    },
  );

  it.each(["pointercancel", "lostpointercapture", "expanding"])(
    "ends an active drag on %s and cancels its queued update",
    async (ending) => {
      const frame = vi.fn();
      vi.stubGlobal("requestAnimationFrame", frame.mockReturnValue(7));
      const cancelFrame = vi.fn();
      vi.stubGlobal("cancelAnimationFrame", cancelFrame);
      await act(async () =>
        root.render(
          <SatelliteDesktopShell bridge={bridge}>
            <div />
          </SatelliteDesktopShell>,
        ),
      );
      const target = host.querySelector('[data-satellite="pill-title"]')!;
      await act(async () => {
        dispatchPointer(target, "pointerdown", { screenX: 100, screenY: 200 });
        dispatchPointer(target, "pointermove", { screenX: 110, screenY: 200 });
        if (ending === "expanding") shellListener({ ...workspaceState, phase: "expanding" });
        else dispatchPointer(target, ending);
      });
      expect(bridge.endPillDrag).toHaveBeenCalledOnce();
      expect(cancelFrame).toHaveBeenCalledWith(7);
      await act(async () => {
        dispatchPointer(target, "pointerup");
        dispatchPointer(target, "lostpointercapture");
        frame.mock.calls[0]![0](0);
      });
      expect(bridge.endPillDrag).toHaveBeenCalledOnce();
      expect(bridge.updatePillDrag).not.toHaveBeenCalled();
    },
  );

  it("keeps dragging when a status update removes the attention indicator, then accepts another drag", async () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 7),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    await act(async () =>
      root.render(
        <SatelliteDesktopShell bridge={bridge}>
          <div />
        </SatelliteDesktopShell>,
      ),
    );
    const status: SatellitePillState = {
      threadId: "thread-1",
      environmentId: "local",
      title: "Conversation",
      detail: "Approval needed",
      state: "awaiting-input",
      attention: true,
    };
    await act(async () => pillListener(status));
    const attention = host.querySelector('[data-satellite="pill-attention"]')!;
    await act(async () =>
      dispatchPointer(attention, "pointerdown", { screenX: 100, screenY: 200 }),
    );
    const captured = [...host.querySelectorAll("*")].find((element) =>
      element.hasPointerCapture(1),
    )!;
    await act(async () => {
      dispatchPointer(captured, "pointermove", { screenX: 110, screenY: 200 });
      pillListener({ ...status, attention: false });
    });
    expect(attention.isConnected).toBe(false);
    // A disconnected capture target loses capture at document, outside the pill's
    // React handlers. Route release as the browser would after the status update.
    await act(async () => {
      if (!captured.isConnected) dispatchPointer(document, "lostpointercapture");
      dispatchPointer(captured.isConnected ? captured : document, "pointerup", {
        screenX: 130,
        screenY: 200,
      });
    });
    expect(bridge.endPillDrag).toHaveBeenCalledOnce();
    const title = host.querySelector('[data-satellite="pill-title"]')!;
    await act(async () => {
      dispatchPointer(title, "pointerdown", { screenX: 130, screenY: 200 });
      dispatchPointer(title, "pointermove", { screenX: 140, screenY: 200 });
      dispatchPointer(title, "pointerup", { screenX: 140, screenY: 200 });
    });
    expect(bridge.beginPillDrag).toHaveBeenCalledTimes(2);
    expect(bridge.endPillDrag).toHaveBeenCalledTimes(2);
  });

  it("preserves the workspace and its draft while status continues through a collapse and expansion", async () => {
    const mount = vi.fn();
    const unmount = vi.fn();
    function Workspace() {
      useEffect(() => {
        mount();
        return unmount;
      }, []);
      return <textarea aria-label="Message" defaultValue="Unsent draft" />;
    }
    await act(async () =>
      root.render(
        <SatelliteDesktopShell bridge={bridge}>
          <Workspace />
        </SatelliteDesktopShell>,
      ),
    );
    await act(async () => shellListener(workspaceState));
    const draft = host.querySelector("textarea")!;
    draft.value = "Keep this draft";
    await act(async () =>
      shellListener({ ...workspaceState, mode: "pill", phase: "collapsing", transitionId: 2 }),
    );
    expect(bridge.finishTransition).toHaveBeenCalledWith(2);
    await act(async () => {
      shellListener({ ...workspaceState, mode: "pill", phase: "settled", transitionId: 2 });
      pillListener({
        threadId: "thread-1",
        environmentId: "remote-1",
        title: "Remote conversation",
        detail: "Approval needed",
        state: "awaiting-input",
        attention: true,
      });
    });
    expect(host.textContent).toContain("Approval needed");
    await act(async () => shellListener({ ...workspaceState, transitionId: 3 }));
    expect(host.querySelector("textarea")).toBe(draft);
    expect(draft.value).toBe("Keep this draft");
    expect(mount).toHaveBeenCalledOnce();
    expect(unmount).not.toHaveBeenCalled();
  });

  it("keeps the pill accessible around a real modal and restores the modal's input after expansion", async () => {
    const renderDialog = (open: boolean) =>
      root.render(
        <SatelliteDesktopShell bridge={bridge}>
          <textarea aria-label="Workspace draft" />
          <Dialog.Root open={open}>
            <Dialog.Portal keepMounted>
              <Dialog.Backdrop data-test-backdrop="" />
              <Dialog.Popup>
                <Dialog.Title>Rename conversation</Dialog.Title>
                <Dialog.Description>Choose a title.</Dialog.Description>
                <input aria-label="Conversation title" defaultValue="My conversation" />
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        </SatelliteDesktopShell>,
      );
    await act(async () => renderDialog(false));
    await act(async () => shellListener(workspaceState));
    await act(async () => renderDialog(true));
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Conversation title"]',
    )!;
    input.focus();
    input.value = "Unsaved title";
    const backdrop = document.querySelector<HTMLElement>("[data-test-backdrop]")!;
    expect(getComputedStyle(backdrop).visibility).toBe("visible");
    await act(async () =>
      shellListener({ ...workspaceState, mode: "pill", phase: "collapsing", transitionId: 2 }),
    );
    // The backdrop must disappear at the start of motion. Its transition-all
    // must not keep inherited visibility alive over the shrinking surface.
    expect(getComputedStyle(backdrop).visibility).toBe("hidden");
    expect(getComputedStyle(backdrop).transition).toBe("none");
    await act(async () => shellListener({ ...workspaceState, mode: "pill", transitionId: 2 }));
    const pill = host.querySelector('[data-satellite="pill"]')!;
    expect(pill.closest('[aria-hidden="true"], [inert]')).toBeNull();
    await act(async () => shellListener({ ...workspaceState, transitionId: 3 }));
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Unsaved title");
    expect(input.closest('[aria-hidden="true"], [inert]')).toBeNull();
    // Closing a keepMounted modal while collapsed must not leave a stale hidden
    // workspace, or remove the closed popup's own hidden state on expansion.
    await act(async () =>
      shellListener({ ...workspaceState, mode: "pill", phase: "collapsing", transitionId: 4 }),
    );
    await act(async () => shellListener({ ...workspaceState, mode: "pill", transitionId: 4 }));
    await act(async () => renderDialog(false));
    await act(async () => shellListener({ ...workspaceState, transitionId: 5 }));
    const draft = host.querySelector("textarea")!;
    draft.focus();
    expect(document.activeElement).toBe(draft);
    expect(draft.closest('[aria-hidden="true"], [inert]')).toBeNull();
    expect(input.closest("[hidden]")).not.toBeNull();
  });

  it("blocks global workspace shortcuts across collapse cycles but preserves pill keys and native quit", async () => {
    const workspaceShortcut = vi.fn();
    function Workspace() {
      useEffect(() => {
        window.addEventListener("keydown", workspaceShortcut, true);
        return () => window.removeEventListener("keydown", workspaceShortcut, true);
      }, []);
      return <textarea aria-label="Workspace draft" />;
    }
    await act(async () =>
      root.render(
        <SatelliteDesktopShell bridge={bridge}>
          <Workspace />
        </SatelliteDesktopShell>,
      ),
    );
    await act(async () => shellListener(workspaceState));
    await act(async () =>
      shellListener({ ...workspaceState, mode: "pill", phase: "collapsing", transitionId: 2 }),
    );
    await act(async () => shellListener({ ...workspaceState, mode: "pill", transitionId: 2 }));
    for (const key of ["k", "u"]) {
      const event = new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(workspaceShortcut).not.toHaveBeenCalled();
    for (const key of ["Tab", "Enter", " "]) {
      const event = new KeyboardEvent("keydown", { key, cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(workspaceShortcut).not.toHaveBeenCalled();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, cancelable: true }),
    );
    expect(bridge.movePill).toHaveBeenCalledExactlyOnceWith("ArrowLeft");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", metaKey: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F4", altKey: true }));
    expect(workspaceShortcut).toHaveBeenCalledTimes(3);
    await act(async () => shellListener({ ...workspaceState, transitionId: 3 }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    expect(workspaceShortcut).toHaveBeenCalledTimes(4);
  });

  it("lets dialogs and handled Escape keys keep focus before collapsing the workspace", async () => {
    await act(async () =>
      root.render(
        <SatelliteDesktopShell bridge={bridge}>
          <div />
        </SatelliteDesktopShell>,
      ),
    );
    await act(async () => shellListener(workspaceState));
    const dialog = document.createElement("div");
    dialog.role = "dialog";
    document.body.append(dialog);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(bridge.hideMain).not.toHaveBeenCalled();
    dialog.remove();
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(bridge.hideMain).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(bridge.hideMain).toHaveBeenCalledOnce();
  });

  it("reverses an unfinished morph from its visible frame and only acknowledges the final transition", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const motions: Array<{ finish: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
    const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
      let finish: () => void = () => undefined;
      let fail: (error: Error) => void = () => undefined;
      const finished = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const cancel = vi.fn(() => fail(new Error("Animation cancelled")));
      motions.push({ finish, cancel });
      return { finished, cancel };
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    await act(async () =>
      root.render(
        <SatelliteDesktopShell bridge={bridge}>
          <div />
        </SatelliteDesktopShell>,
      ),
    );
    const expanding = { ...workspaceState, phase: "expanding" } as const;
    await act(async () => shellListener(expanding));
    await act(async () => shellListener({ ...expanding, pinned: true }));
    expect(animate).toHaveBeenCalledTimes(4);
    expect(animate.mock.calls.map((call) => call[1])).toEqual([
      { duration: 500, easing: "cubic-bezier(.2,.75,.2,1)", fill: "both" },
      { duration: 220, delay: 140, easing: "ease", fill: "both" },
      { duration: 350, delay: 100, easing: "ease", fill: "both" },
      { duration: 100, delay: 0, easing: "ease", fill: "both" },
    ]);

    const visibleFrame = {
      left: "90px",
      top: "80px",
      width: "850px",
      height: "520px",
      borderRadius: "22px",
      backgroundColor: "rgb(30, 30, 30)",
      borderColor: "rgb(50, 50, 50)",
    };
    const nativeComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const style = nativeComputedStyle(element);
      if (element.getAttribute("data-satellite") === "shell-surface") {
        const frame = {
          ...visibleFrame,
          borderTopLeftRadius: visibleFrame.borderRadius,
          borderTopColor: visibleFrame.borderColor,
        };
        return new Proxy(style, {
          get: (target, property) => Reflect.get(frame, property) ?? Reflect.get(target, property),
        });
      }
      if (element.getAttribute("data-satellite") === "workspace") {
        style.opacity = "0.4";
        style.transform = "matrix(1, 0, 0, 1, 0, 4)";
      }
      if (element.getAttribute("data-satellite") === "pill") style.opacity = "0.6";
      return style;
    });
    await act(async () =>
      shellListener({ ...workspaceState, mode: "pill", phase: "collapsing", transitionId: 2 }),
    );
    expect(motions.slice(0, 4).every((motion) => motion.cancel.mock.calls.length === 1)).toBe(true);
    expect(animate.mock.calls[4]?.[0]).toEqual([
      visibleFrame,
      {
        left: "180px",
        top: "640px",
        width: "320px",
        height: "70px",
        borderRadius: "35px",
        backgroundColor: "#181a1e",
        borderColor: "#363d47",
      },
    ]);
    expect(animate.mock.calls[5]?.[0]).toEqual([{ opacity: "0.4" }, { opacity: 0 }]);
    expect(animate.mock.calls[6]?.[0]).toEqual([
      { transform: "matrix(1, 0, 0, 1, 0, 4)" },
      { transform: "translateY(8px)" },
    ]);
    expect(animate.mock.calls[7]?.[0]).toEqual([{ opacity: "0.6" }, { opacity: 1 }]);
    expect(animate.mock.calls.slice(5).map((call) => call[1])).toEqual([
      { duration: 120, delay: 0, easing: "ease", fill: "both" },
      { duration: 180, delay: 0, easing: "ease", fill: "both" },
      { duration: 160, delay: 180, easing: "ease", fill: "both" },
    ]);
    expect(bridge.finishTransition).not.toHaveBeenCalled();
    await act(async () => motions.slice(4).forEach((motion) => motion.finish()));
    expect(bridge.finishTransition).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("keeps the pill at its native size and anchor when the workspace zoom changes", async () => {
    await act(async () =>
      root.render(
        <SatelliteDesktopShell bridge={bridge}>
          <div />
        </SatelliteDesktopShell>,
      ),
    );
    await act(async () => shellListener(workspaceState));
    const surface = host.querySelector<HTMLDivElement>('[data-satellite="shell-surface"]')!;
    const pill = host.querySelector<HTMLDivElement>('[data-satellite="pill"]')!;
    await act(async () => {
      vi.mocked(bridge.getZoomFactor).mockReturnValue(1.25);
      window.dispatchEvent(new Event("resize"));
    });
    // Workspace zoom changes CSS geometry while native edges remain fixed.
    expect(Number.parseFloat(surface.style.width) * 1.25).toBe(1100);
    expect(Number.parseFloat(surface.style.height) * 1.25).toBe(760);
    expect(pill.style.transform).toBe("scale(0.8)");
    await act(async () => {
      shellListener({ ...workspaceState, mode: "pill" });
    });
    expect(pill.style.transform).toBe("scale(0.8)");
    expect(Number.parseFloat(surface.style.left) * 1.25).toBe(180);
    expect(Number.parseFloat(surface.style.top) * 1.25).toBe(640);
    expect(Number.parseFloat(surface.style.width) * 1.25).toBe(320);
    expect(Number.parseFloat(surface.style.height) * 1.25).toBe(70);
    expect(Number.parseFloat(surface.style.borderRadius) * 1.25).toBe(35);
  });

  it("does not shrink the pill when native bounds and CSS viewport round differently", async () => {
    vi.stubGlobal("innerWidth", 1128);
    await act(async () =>
      root.render(
        <SatelliteDesktopShell bridge={bridge}>
          <div />
        </SatelliteDesktopShell>,
      ),
    );
    const nativeState = { ...workspaceState, workspaceSize: { width: 1129, height: 760 } };
    await act(async () => shellListener(nativeState));
    await act(async () => shellListener({ ...nativeState, mode: "pill" }));
    const surface = host.querySelector<HTMLDivElement>('[data-satellite="shell-surface"]')!;
    expect(Number.parseFloat(surface.style.width)).toBe(320);
    expect(Number.parseFloat(surface.style.height)).toBe(70);
    expect(Number.parseFloat(surface.style.left)).toBe(180);
  });
});
