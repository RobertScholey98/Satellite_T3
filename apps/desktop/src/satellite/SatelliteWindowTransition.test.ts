import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Electron from "electron";
import type { WindowsDwmApi } from "../electron/WindowsDwm.ts";
import { createSatelliteWindowTransition } from "./SatelliteWindowTransition.ts";

const native = vi.hoisted(() => ({
  switches: new Set<string>(),
  displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
  windows: [] as {
    bounds: Electron.Rectangle;
    visible: boolean;
    destroyed: boolean;
    options: Electron.BaseWindowConstructorOptions;
  }[],
}));
vi.mock("electron", () => ({
  app: {
    commandLine: {
      hasSwitch: (name: string) => native.switches.has(name),
      appendSwitch: (name: string) => native.switches.add(name),
      removeSwitch: (name: string) => native.switches.delete(name),
    },
  },
  screen: { getAllDisplays: () => native.displays },
  BaseWindow: class {
    bounds: Electron.Rectangle;
    options: Electron.BaseWindowConstructorOptions;
    visible = false;
    destroyed = false;
    constructor(options: Electron.BaseWindowConstructorOptions) {
      this.options = options;
      this.bounds = {
        x: options.x!,
        y: options.y!,
        width: options.width!,
        height: options.height!,
      };
      native.windows.push(this);
    }
    getBounds = () => this.bounds;
    getNativeWindowHandle = () => Buffer.from([native.windows.indexOf(this) + 1, 0, 0, 0]);
    setIgnoreMouseEvents = vi.fn();
    showInactive = () => {
      this.visible = true;
    };
    hide = () => {
      this.visible = false;
    };
    isDestroyed = () => this.destroyed;
    destroy = () => {
      this.destroyed = true;
      this.visible = false;
    };
  },
}));

describe("native workspace transition", () => {
  let rectangles: Map<bigint, Electron.Rectangle>;
  let opacities: Map<bigint, number>;
  let dwm: WindowsDwmApi;
  let transition: ReturnType<typeof createSatelliteWindowTransition>;
  const workspace = { bounds: { x: 100, y: 50, width: 1000, height: 800 }, widgetBlend: 0 };
  const widget = { bounds: { x: 800, y: 0, width: 320, height: 70 }, widgetBlend: 1 };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    native.windows.length = 0;
    native.displays = [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    ];
    rectangles = new Map();
    opacities = new Map();
    let nextThumbnail = 0n;
    dwm = {
      disableTransitions: vi.fn(),
      registerThumbnail: vi.fn(() => ++nextThumbnail),
      updateThumbnail: vi.fn((id, bounds, opacity) => {
        rectangles.set(id, bounds);
        opacities.set(id, opacity);
      }),
      unregisterThumbnail: vi.fn((id) => {
        rectangles.delete(id);
        opacities.delete(id);
      }),
    };
    transition = createSatelliteWindowTransition(
      {
        getNativeWindowHandle: () => Buffer.from([99, 0, 0, 0]),
      } as Electron.BrowserWindow,
      dwm,
    );
  });
  afterEach(() => {
    transition.dispose();
    vi.useRealTimers();
  });

  it("draws both exact endpoints and stops repainting after the transition", () => {
    let completed = false;
    expect(
      transition.play({
        from: workspace,
        to: widget,
        onComplete: () => {
          completed = true;
        },
      }),
    ).toBe(true);
    expect(rectangles.get(1n)).toEqual(workspace.bounds);
    expect([...opacities.values()]).toEqual([255]);
    expect(native.windows[0]?.visible).toBe(true);
    vi.advanceTimersByTime(112);
    expect(rectangles.get(1n)).toEqual({ x: 717, y: 6, width: 400, height: 156 });
    expect([...opacities.values()]).toEqual([30]);
    vi.advanceTimersByTime(112);
    expect(rectangles.get(1n)).toEqual(widget.bounds);
    expect([...opacities.values()]).toEqual([0]);
    expect(completed).toBe(true);
    expect(native.windows[0]?.visible).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reverses from the current visual rectangle and never completes a cancelled target", () => {
    let completed = "none";
    transition.play({
      from: workspace,
      to: widget,
      onComplete: () => {
        completed = "widget";
      },
    });
    vi.advanceTimersByTime(112);
    const current = transition.cancel()!;
    expect(Math.round(current.bounds.x)).toBe(717);
    expect(Math.round(current.widgetBlend * 255)).toBe(225);
    transition.play({
      from: current,
      to: workspace,
      onComplete: () => {
        completed = "workspace";
      },
    });
    expect([...opacities.values()]).toEqual([30]);
    vi.advanceTimersByTime(112);
    expect(completed).toBe("none");
    vi.advanceTimersByTime(112);
    expect(completed).toBe("workspace");
    expect(rectangles.get(1n)).toEqual(workspace.bounds);
    expect([...opacities.values()]).toEqual([255]);
    expect(native.windows).toHaveLength(1);
  });
  it("maps global DIP coordinates independently on mixed-scale displays", () => {
    native.displays.push({
      id: 2,
      bounds: { x: 1920, y: 0, width: 1280, height: 720 },
      scaleFactor: 1.5,
    });
    transition.play({
      from: { bounds: { x: 1800, y: 100, width: 600, height: 400 }, widgetBlend: 0 },
      to: { bounds: { x: 2200, y: 0, width: 320, height: 70 }, widgetBlend: 1 },
      onComplete: () => {},
    });
    expect(rectangles.get(1n)).toEqual({ x: 1800, y: 100, width: 600, height: 400 });
    expect(rectangles.get(2n)).toEqual({ x: -180, y: 150, width: 900, height: 600 });
    vi.advanceTimersByTime(224);
    expect(rectangles.get(2n)).toEqual({ x: 420, y: 0, width: 480, height: 105 });
  });
  it("disposes native destinations and cancels callbacks when displays change or the owner closes", () => {
    let completed = false;
    transition.play({
      from: workspace,
      to: widget,
      onComplete: () => {
        completed = true;
      },
    });
    transition.dispose();
    vi.advanceTimersByTime(500);
    expect(native.windows[0]?.destroyed).toBe(true);
    expect(rectangles.size).toBe(0);
    expect(completed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("falls back without leaving a destination behind if native registration fails", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(dwm.registerThumbnail).mockImplementationOnce(() => {
      throw new Error("DWM unavailable");
    });
    expect(transition.play({ from: workspace, to: widget, onComplete: () => {} })).toBe(false);
    expect(native.windows[0]?.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.mocked(console.warn).mockRestore();
  });
  it("still removes destinations when native thumbnail release fails", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    transition.play({ from: workspace, to: widget, onComplete: () => {} });
    vi.mocked(dwm.unregisterThumbnail).mockImplementationOnce(() => {
      throw new Error("Source closed");
    });
    transition.dispose();
    expect(native.windows[0]?.destroyed).toBe(true);
    expect(native.windows[0]?.visible).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    warning.mockRestore();
  });
});
