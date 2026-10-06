// @vitest-environment jsdom
import type { SatelliteBridge, SatelliteShellState } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SatelliteDesktopShell } from "./SatelliteDesktopShell";

describe("retained Satellite workspace", () => {
  let root: Root;
  let host: HTMLDivElement;
  let listener: (state: SatelliteShellState) => void;
  let bridge: SatelliteBridge;
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Workspace() {
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return <input aria-label="Chat draft" defaultValue="Keep this draft" />;
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    bridge = {
      publish: vi.fn(),
      openMain: vi.fn(),
      onAttentionIntent: () => vi.fn(),
      hideMain: vi.fn(),
      setPinned: vi.fn(),
      setPositionsLinked: vi.fn(),
      onShellState: (next) => {
        listener = next;
        return vi.fn();
      },
    };
    act(() =>
      root.render(
        <SatelliteDesktopShell bridge={bridge}>
          <Workspace />
        </SatelliteDesktopShell>,
      ),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  it("preserves conversation controls, draft, and focus through hide and reveal", () => {
    act(() => listener({ mode: "workspace" }));
    const input = host.querySelector("input")!;
    input.focus();
    input.value = "Edited draft";
    act(() => listener({ mode: "pill" }));
    expect(host.querySelector('[data-satellite="workspace"]')?.hasAttribute("inert")).toBe(true);
    input.blur();
    act(() => listener({ mode: "pill", pinned: true }));
    act(() => listener({ mode: "workspace" }));
    expect(host.querySelector("input")).toBe(input);
    expect(input.value).toBe("Edited draft");
    expect(document.activeElement).toBe(input);
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
  });
  it("lets an open overlay own Escape before collapsing the workspace", () => {
    act(() => listener({ mode: "workspace" }));
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    document.body.append(overlay);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(bridge.hideMain).not.toHaveBeenCalled();
    overlay.remove();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(bridge.hideMain).toHaveBeenCalledOnce();
  });
  it("toggles pin in both directions and collapses through the controls", () => {
    act(() => listener({ mode: "workspace", pinned: false }));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Keep workspace open"]')!.click());
    expect(bridge.setPinned).toHaveBeenLastCalledWith(true);
    act(() => listener({ mode: "workspace", pinned: true }));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Unpin workspace"]')!.click());
    expect(bridge.setPinned).toHaveBeenLastCalledWith(false);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Collapse to pill"]')!.click());
    expect(bridge.hideMain).toHaveBeenCalledOnce();
  });
});
