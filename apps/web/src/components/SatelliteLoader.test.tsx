// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SatelliteLoader } from "./SatelliteLoader";
import { satelliteLoaderLoopFrame, satelliteLoaderStill } from "./satellite-loader-motion";
import { WorkSyncIndicator } from "./work/WorkSyncIndicator";

let root: Root;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let hidden: boolean;
let media: {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};
let motionEvents: EventTarget;

async function frame(milliseconds: number) {
  await act(async () => {
    vi.advanceTimersByTime(milliseconds);
    const queued = [...frames.values()];
    frames.clear();
    for (const callback of queued) callback(performance.now());
  });
}

async function visibility(value: boolean) {
  hidden = value;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
}

async function reducedMotion(value: boolean) {
  media.matches = value;
  await act(async () => motionEvents.dispatchEvent(new Event("change")));
}

function pose() {
  return {
    path: host.querySelector("path")!.getAttribute("d"),
    transform: host.querySelector("rect")!.getAttribute("transform"),
    opacity: host.querySelector("g")!.getAttribute("opacity"),
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  motionEvents = new EventTarget();
  media = {
    matches: false,
    addEventListener: vi.fn((type: string, listener: EventListener) =>
      motionEvents.addEventListener(type, listener),
    ),
    removeEventListener: vi.fn((type: string, listener: EventListener) =>
      motionEvents.removeEventListener(type, listener),
    ),
  };
  vi.stubGlobal("matchMedia", () => media);
  frames = new Map();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (request: number) => frames.delete(request));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SatelliteLoader", () => {
  it("starts idle, preserves the current pose on finish, and completes once using the latest callback", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const render = (loading: boolean, onExitComplete = first) =>
      root.render(<SatelliteLoader loading={loading} onExitComplete={onExitComplete} />);
    await act(async () => render(false));
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(host.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");

    await act(async () => render(true));
    await frame(0);
    await frame(400);
    const current = pose();
    expect(current.path).toBe(satelliteLoaderLoopFrame(0.25).path);
    await act(async () => render(false));
    expect(pose()).toEqual(current);
    await frame(400);
    await act(async () => render(false, latest));
    await frame(449);
    expect(latest).not.toHaveBeenCalled();
    await frame(1);
    expect(latest).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(pose().opacity).toBe("0");
    expect(host.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await frame(2000);
    expect(latest).toHaveBeenCalledOnce();
  });

  it("cancels an unfinished exit when loading restarts, including under StrictMode", async () => {
    const completed = vi.fn();
    const render = (loading: boolean) =>
      root.render(
        <StrictMode>
          <SatelliteLoader loading={loading} onExitComplete={completed} />
        </StrictMode>,
      );
    await act(async () => render(true));
    expect(frames.size).toBe(1);
    await frame(0);
    await frame(300);
    await act(async () => render(false));
    await frame(250);
    await act(async () => render(true));
    expect(pose().path).toBe(satelliteLoaderLoopFrame(0).path);
    await frame(1000);
    expect(completed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => render(false));
    await frame(850);
    expect(completed).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("draws a static mark for reduced motion and fades without moving it", async () => {
    media.matches = true;
    const completed = vi.fn();
    await act(async () => root.render(<SatelliteLoader loading onExitComplete={completed} />));
    const still = pose();
    expect(still.path).toBe(satelliteLoaderStill.path);
    expect(frames.size).toBe(0);
    await frame(2000);
    expect(pose()).toEqual(still);
    await act(async () =>
      root.render(<SatelliteLoader loading={false} onExitComplete={completed} />),
    );
    await frame(100);
    expect(pose()).toMatchObject({ path: still.path, transform: still.transform });
    expect(Number(pose().opacity)).toBeLessThan(1);
    await frame(100);
    expect(completed).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("freezes and fades when reduced motion is enabled during the finish", async () => {
    const completed = vi.fn();
    await act(async () => root.render(<SatelliteLoader loading onExitComplete={completed} />));
    await frame(0);
    await frame(200);
    await act(async () =>
      root.render(<SatelliteLoader loading={false} onExitComplete={completed} />),
    );
    await frame(100);
    const current = pose();
    await reducedMotion(true);
    await frame(100);
    expect(pose()).toMatchObject({ path: current.path, transform: current.transform });
    await frame(100);
    expect(completed).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("pauses hidden loading without a phase jump and settles hidden finishes", async () => {
    const completed = vi.fn();
    await act(async () => root.render(<SatelliteLoader loading onExitComplete={completed} />));
    await frame(0);
    await frame(200);
    const current = pose();
    await visibility(true);
    expect(frames.size).toBe(0);
    await frame(2000);
    expect(pose()).toEqual(current);
    await visibility(false);
    await frame(0);
    expect(pose()).toEqual(current);
    await visibility(true);
    await act(async () =>
      root.render(<SatelliteLoader loading={false} onExitComplete={completed} />),
    );
    expect(frames.size).toBe(0);
    await frame(850);
    expect(completed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps paints at 60Hz while keeping elapsed loop timing", async () => {
    await act(async () => root.render(<SatelliteLoader loading />));
    await frame(0);
    const current = pose();
    await frame(8);
    expect(pose()).toEqual(current);
    await frame(8);
    expect(pose()).toEqual(current);
    await frame(1);
    expect(pose().path).toBe(satelliteLoaderLoopFrame(17 / 1600).path);
    expect(frames.size).toBe(1);
  });

  it("cleans up animation, timers, and visibility/preference listeners on unmount", async () => {
    const completed = vi.fn();
    const remove = vi.spyOn(document, "removeEventListener");
    await act(async () => root.render(<SatelliteLoader loading onExitComplete={completed} />));
    await act(async () =>
      root.render(<SatelliteLoader loading={false} onExitComplete={completed} />),
    );
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root.render(null));
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove.mock.calls.some(([type]) => type === "visibilitychange")).toBe(true);
    expect(media.removeEventListener).toHaveBeenCalledTimes(2);
    await frame(1000);
    await reducedMotion(true);
    await visibility(false);
    expect(completed).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
});

describe("WorkSyncIndicator", () => {
  it("labels real reads, stays mounted for the finish, and disappears when finished", async () => {
    await act(async () => root.render(<WorkSyncIndicator syncing={false} />));
    expect(host.textContent).toBe("");
    expect(frames.size).toBe(0);
    await act(async () => root.render(<WorkSyncIndicator syncing />));
    expect(host.textContent).toBe("Syncing");
    const mark = host.querySelector("svg");
    await act(async () => root.render(<WorkSyncIndicator syncing={false} />));
    expect(host.querySelector('span[aria-hidden="true"]')!.textContent).toBe("Syncing");
    expect(host.querySelector("svg")).toBe(mark);
    expect(host.querySelector('[role="status"]')!.getAttribute("aria-busy")).toBe("false");
    await frame(850);
    expect(host.textContent).toBe("");
    expect(host.querySelector("svg")).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("resumes syncing during a finish and cancels removal from the previous cycle", async () => {
    await act(async () => root.render(<WorkSyncIndicator syncing />));
    await act(async () => root.render(<WorkSyncIndicator syncing={false} />));
    await frame(100);
    await act(async () => root.render(<WorkSyncIndicator syncing />));
    await frame(1000);
    expect(host.textContent).toBe("Syncing");
    expect(host.querySelector("svg")).not.toBeNull();
    await act(async () => root.render(<WorkSyncIndicator syncing={false} />));
    await frame(850);
    expect(host.querySelector("svg")).toBeNull();
  });
});
