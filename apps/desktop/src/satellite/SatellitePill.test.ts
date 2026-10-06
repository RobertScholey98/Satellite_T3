// @effect-diagnostics nodeBuiltinImport:off -- Native boundary tests exercise Electron lifecycle events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Electron from "electron";
import * as NodeFS from "node:fs";
import { expandSatelliteWindow, installSatellitePill } from "./SatellitePill.ts";
import { loadWindowsPillDrag } from "./WindowsPillDrag.ts";
import { installWindowsDoubleControl } from "./WindowsDoubleControl.ts";
import * as Channels from "./channels.ts";
import type { WindowsDwmApi } from "../electron/WindowsDwm.ts";

const visibility = vi.hoisted(() => ({
  switches: new Set<string>(),
  transitions: [] as {
    operation: "show-widget" | "hide-widget" | "minimize-workspace";
    animationsDisabled: boolean;
  }[],
}));

vi.mock("./WindowsPillDrag.ts", () => ({
  loadWindowsPillDrag: vi.fn(async () => vi.fn(() => true)),
}));
vi.mock("./WindowsDoubleControl.ts", () => ({
  installWindowsDoubleControl: vi.fn(async () => vi.fn()),
}));
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => '{"x":100,"y":100}'),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const windows: FakeWindow[] = [];
  class FakeWindow extends EventEmitter {
    static getAllWindows = () => windows.filter((window) => !window.destroyed);
    bounds = { x: 400, y: 200, width: 1100, height: 780 };
    destroyed = false;
    visible = false;
    focused = false;
    maximized = false;
    minimized = false;
    skipTaskbar = false;
    minimizedBounds = this.bounds;
    minimizedMaximized = false;
    normalBounds = this.bounds;
    opacity = 1;
    setOpacity = vi.fn((opacity: number) => {
      this.opacity = opacity;
    });
    getOpacity = () => this.opacity;
    ignoringMouseEvents = false;
    setIgnoreMouseEvents = vi.fn((ignore: boolean) => {
      this.ignoringMouseEvents = ignore;
    });
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      getZoomFactor: vi.fn(() => 1),
      setZoomFactor: vi.fn(),
      reload: vi.fn(),
    });
    hide = vi.fn(() => {
      this.visible = false;
      if (this.skipTaskbar)
        visibility.transitions.push({
          operation: "hide-widget",
          animationsDisabled: visibility.switches.has("wm-window-animations-disabled"),
        });
    });
    showInactive = vi.fn(() => {
      this.visible = true;
      visibility.transitions.push({
        operation: "show-widget",
        animationsDisabled: visibility.switches.has("wm-window-animations-disabled"),
      });
    });
    show = vi.fn(() => {
      if (this.minimized) this.restore();
      this.visible = true;
    });
    focus = vi.fn(() => {
      this.focused = true;
      this.emit("focus");
    });
    blur = vi.fn(() => {
      this.focused = false;
      this.emit("blur");
    });
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setSkipTaskbar = vi.fn((skip: boolean) => {
      this.skipTaskbar = skip;
    });
    setMinimumSize = vi.fn();
    setResizable = vi.fn();
    setShape = vi.fn();
    setMaximumSize = vi.fn();
    setSize = vi.fn((width: number, height: number) => {
      this.bounds = { ...this.bounds, width, height };
    });
    loadURL = vi.fn(async () => undefined);
    getNativeWindowHandle = () => Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);
    hooks = new Map<number, () => void>();
    hookWindowMessage = (message: number, callback: () => void) => {
      this.hooks.set(message, callback);
    };
    restore = vi.fn(() => {
      if (this.minimized) {
        this.minimized = false;
        this.visible = true;
        this.bounds = this.minimizedBounds;
        this.maximized = this.minimizedMaximized;
        this.emit("move");
        this.emit("resize");
        this.emit("restore");
      } else this.unmaximize();
    });
    maximize = vi.fn(() => {
      this.visible = true;
      if (!this.maximized) this.normalBounds = this.bounds;
      this.maximized = true;
      this.bounds = { x: 0, y: 0, width: 1920, height: 1040 };
      this.emit("maximize");
      this.emit("resize");
    });
    unmaximize = vi.fn(() => {
      if (!this.maximized) return;
      this.maximized = false;
      this.bounds = this.normalBounds;
      this.emit("unmaximize");
      this.emit("resize");
    });
    minimize = vi.fn(() => {
      if (this.minimized) return;
      visibility.transitions.push({
        operation: "minimize-workspace",
        animationsDisabled: visibility.switches.has("wm-window-animations-disabled"),
      });
      this.minimizedBounds = this.bounds;
      this.minimizedMaximized = this.maximized;
      this.minimized = true;
      this.maximized = false;
      this.bounds = { x: -32000, y: -32000, width: 160, height: 28 };
      this.blur();
      this.emit("move");
      this.emit("resize");
      this.emit("minimize");
    });
    isMaximized = () => this.maximized;
    isMinimized = () => this.minimized;
    getNormalBounds = () => (this.maximized ? this.normalBounds : this.bounds);
    isEnabled = vi.fn(() => true);
    getChildWindows = vi.fn(() => []);
    constructor(_options: Electron.BrowserWindowConstructorOptions) {
      super();
      this.skipTaskbar = _options.skipTaskbar ?? false;
      this.bounds = {
        ...this.bounds,
        ...(_options.x !== undefined ? { x: _options.x } : {}),
        ...(_options.y !== undefined ? { y: _options.y } : {}),
        ...(_options.width !== undefined ? { width: _options.width } : {}),
        ...(_options.height !== undefined ? { height: _options.height } : {}),
      };
      windows.push(this);
    }
    isDestroyed = () => this.destroyed;
    isVisible = () => this.visible;
    isFocused = () => this.focused;
    getBounds = () => this.bounds;
    setBounds = vi.fn((bounds: Electron.Rectangle) => {
      this.bounds = bounds;
      this.emit("move");
      this.emit("resize");
    });
    setPosition = vi.fn((x: number, y: number) => {
      this.bounds = { ...this.bounds, x, y };
      this.emit("move");
      this.emit("moved");
    });
    destroy = () => {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    };
    close = () => {
      let prevented = false;
      this.emit("close", {
        preventDefault: () => {
          prevented = true;
        },
      });
      if (!prevented) this.destroy();
    };
  }
  const primary = {
    id: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
  };
  return {
    BrowserWindow: FakeWindow,
    BaseWindow: FakeWindow,
    app: Object.assign(new EventEmitter(), {
      getPath: () => "/isolated",
      quit: vi.fn(),
      commandLine: {
        hasSwitch: (name: string) => visibility.switches.has(name),
        appendSwitch: (name: string) => visibility.switches.add(name),
        removeSwitch: (name: string) => visibility.switches.delete(name),
      },
    }),
    screen: Object.assign(new EventEmitter(), {
      getPrimaryDisplay: () => primary,
      getAllDisplays: () => [primary],
      getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    }),
    ipcMain: new EventEmitter(),
    nativeImage: { createFromBuffer: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
    Tray: class extends EventEmitter {
      setToolTip = vi.fn();
      setContextMenu = vi.fn();
      destroy = vi.fn();
    },
  };
});

describe("independent native Satellite surfaces", () => {
  let main: Electron.BrowserWindow;
  let pill: Electron.BrowserWindow;
  let reveal: ReturnType<typeof vi.fn<() => void>>;
  const send = (sender: Electron.BrowserWindow, channel: string, value?: unknown) =>
    Electron.ipcMain.emit(channel, { sender: sender.webContents }, value);
  const message = (window: Electron.BrowserWindow, id: number) =>
    (window as unknown as { hooks: Map<number, () => void> }).hooks.get(id)?.();
  const state = {
    threadId: "t1",
    environmentId: "remote",
    title: "Fix build",
    state: "working",
    detail: "Reading",
    attention: false,
  } as const;
  const saved = () => JSON.parse(vi.mocked(NodeFS.writeFileSync).mock.lastCall?.[1] as string);
  const publishedLayouts = () =>
    vi
      .mocked(pill.webContents.send)
      .mock.calls.filter(([channel]) => channel === Channels.SATELLITE_PILL_LAYOUT)
      .map(([, layout]) => layout);
  const expand = () => expandSatelliteWindow(main);
  const collapse = () => send(main, Channels.SATELLITE_HIDE_MAIN);
  const taskbarWindows = () =>
    Electron.BrowserWindow.getAllWindows().filter(
      (window) =>
        window.isVisible() && !(window as unknown as { skipTaskbar: boolean }).skipTaskbar,
    );
  const createShell = (dwm?: WindowsDwmApi) => {
    main = new Electron.BrowserWindow({});
    reveal = vi.fn(() => {
      expand();
    });
    installSatellitePill(main, {
      revealMain: reveal,
      pillUrl: "http://localhost/satellite-pill.html",
      pillPreloadPath: "/pill.cjs",
      ...(dwm ? { dwm } : {}),
    });
    pill = Electron.BrowserWindow.getAllWindows().find((window) => window !== main)!;
  };
  const enableAnimations = () => {
    main.destroy();
    const dwm = {
      disableTransitions: vi.fn(),
      registerThumbnail: vi.fn(() => 1n),
      updateThumbnail: vi.fn(),
      unregisterThumbnail: vi.fn(),
    };
    createShell(dwm);
    send(main, Channels.SATELLITE_WORKSPACE_READY);
    send(pill, Channels.SATELLITE_PILL_READY);
    return dwm;
  };
  const widgetIgnoresMouse = () =>
    (pill as unknown as { ignoringMouseEvents: boolean }).ignoringMouseEvents;
  const widgetContentOpacity = () =>
    vi
      .mocked(pill.webContents.send)
      .mock.calls.findLast(([channel]) => channel === Channels.SATELLITE_PILL_OPACITY)?.[1];
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    visibility.switches.clear();
    visibility.transitions.length = 0;
    vi.mocked(NodeFS.readFileSync).mockReturnValue('{"x":100,"y":100}');
    createShell();
    await Promise.resolve();
    send(main, Channels.SATELLITE_WORKSPACE_READY);
    send(pill, Channels.SATELLITE_PILL_READY);
    reveal.mockClear();
    visibility.transitions.length = 0;
  });
  afterEach(() => {
    for (const window of Electron.BrowserWindow.getAllWindows()) window.destroy();
    vi.useRealTimers();
  });
  it("boots an expanded resizable workspace and keeps the pill hidden", () => {
    expect(pill.getBounds()).toEqual({ x: 100, y: 100, width: 252, height: 56 });
    expect(pill.isVisible()).toBe(false);
    expect(main.isVisible()).toBe(true);
    expect(main.setResizable).toHaveBeenCalledWith(true);
    expect(main.setShape).not.toHaveBeenCalled();
    expect(pill.webContents.setZoomFactor).toHaveBeenCalledWith(1);
  });
  it("opens the pill and toggles pinning only in a focused workspace", () => {
    const shortcut = vi.mocked(installWindowsDoubleControl).mock.calls[0]![1];
    collapse();
    shortcut();
    expect(reveal).toHaveBeenCalledOnce();
    expect(main.isVisible()).toBe(true);
    expect(main.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_SHELL_STATE, {
      mode: "workspace",
      pinned: false,
      positionsLinked: true,
    });
    shortcut();
    expect(main.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_SHELL_STATE, {
      mode: "workspace",
      pinned: true,
      positionsLinked: true,
    });
    shortcut();
    expect(main.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_SHELL_STATE, {
      mode: "workspace",
      pinned: false,
      positionsLinked: true,
    });
    main.blur();
    vi.mocked(main.webContents.send).mockClear();
    shortcut();
    expect(main.webContents.send).not.toHaveBeenCalled();
  });

  it("disposes the keyboard listener on shutdown", async () => {
    const dispose = await vi.mocked(installWindowsDoubleControl).mock.results[0]!.value;
    Electron.app.emit("before-quit");
    expect(dispose).toHaveBeenCalledOnce();
    main.destroy();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("shows the loader at first paint before the workspace renderer is ready", () => {
    main.destroy();
    createShell();
    send(pill, Channels.SATELLITE_PILL_READY);
    expect(main.isVisible()).toBe(false);
    expect(pill.isVisible()).toBe(false);
    main.emit("ready-to-show");
    expect(main.isVisible()).toBe(true);
    expect(main.isFocused()).toBe(true);
    expect(pill.isVisible()).toBe(false);
    send(main, Channels.SATELLITE_WORKSPACE_READY);
    expect(main.isVisible()).toBe(true);
    expect(pill.isVisible()).toBe(false);
    collapse();
    expect(main.isMinimized()).toBe(true);
    expect(pill.isVisible()).toBe(true);
  });
  it("switches surfaces without destroying the mounted workspace", () => {
    expand();
    expect(main.isVisible()).toBe(true);
    expect(pill.isVisible()).toBe(false);
    collapse();
    expect(main.isMinimized()).toBe(true);
    expect(pill.isVisible()).toBe(true);
    expect(main.isDestroyed()).toBe(false);
    expand();
    expect(main.isVisible()).toBe(true);
    expect(Electron.BrowserWindow.getAllWindows()).toHaveLength(2);
  });
  it("keeps one taskbar entry through command collapse and native taskbar restore", () => {
    expect(taskbarWindows()).toEqual([main]);
    collapse();
    expect(main.isMinimized()).toBe(true);
    expect(pill.isVisible()).toBe(true);
    expect(taskbarWindows()).toEqual([main]);
    expect(main.restore).not.toHaveBeenCalled();
    main.restore();
    expect(main.isMinimized()).toBe(false);
    expect(main.isFocused()).toBe(true);
    expect(pill.isVisible()).toBe(false);
    expect(taskbarWindows()).toEqual([main]);
    expect(main.restore).toHaveBeenCalledTimes(1);
    expect(main.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_SHELL_STATE, {
      mode: "workspace",
      pinned: false,
      positionsLinked: true,
    });
  });
  it("restores the current content blend when the widget reloads during motion", () => {
    enableAnimations();
    collapse();
    vi.advanceTimersByTime(112);
    const opacity = widgetContentOpacity();
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
    pill.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    send(pill, Channels.SATELLITE_PILL_READY);
    expect(widgetContentOpacity()).toBe(opacity);
    expect(widgetIgnoresMouse()).toBe(true);
    vi.advanceTimersByTime(112);
    expect(widgetContentOpacity()).toBe(1);
    expect(widgetIgnoresMouse()).toBe(false);
  });
  it("anchors the fade to the compact pill when its action panel is open", () => {
    const dwm = enableAnimations();
    send(main, Channels.SATELLITE_SET_POSITIONS_LINKED, false);
    collapse();
    vi.advanceTimersByTime(224);
    const anchor = pill.getBounds();
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "panel", wing: true });
    expect(pill.getBounds().height).toBeGreaterThan(anchor.height);
    expand();
    expect(dwm.updateThumbnail).toHaveBeenLastCalledWith(expect.any(BigInt), anchor, 0);
    vi.advanceTimersByTime(224);
    collapse();
    vi.advanceTimersByTime(224);
    expect(dwm.updateThumbnail).toHaveBeenLastCalledWith(expect.any(BigInt), anchor, 0);
    expect(widgetContentOpacity()).toBe(1);
    expect(publishedLayouts().at(-1)).toMatchObject({ mode: "compact", wing: expect.any(Object) });
  });
  it("keeps native geometry retained while the visual opens and closes at the widget", () => {
    enableAnimations();
    const retained = main.getBounds();
    vi.mocked(main.setBounds).mockClear();
    collapse();
    expect(main.isMinimized()).toBe(true);
    expect(pill.isVisible()).toBe(true);
    expect(widgetContentOpacity()).toBe(0);
    expect(widgetIgnoresMouse()).toBe(true);
    expect(taskbarWindows()).toEqual([main]);
    vi.advanceTimersByTime(224);
    expect(pill.isVisible()).toBe(true);
    expect(pill.getOpacity()).toBe(1);
    expect(widgetIgnoresMouse()).toBe(false);
    expect(expand()).toBe(false);
    expect(main.getOpacity()).toBe(0);
    expect(widgetContentOpacity()).toBe(1);
    expect(widgetIgnoresMouse()).toBe(true);
    expect(main.getBounds()).toEqual(retained);
    expect(expand()).toBe(false);
    main.blur();
    vi.advanceTimersByTime(150);
    expect(main.isMinimized()).toBe(false);
    expect(main.getOpacity()).toBe(0);
    vi.advanceTimersByTime(74);
    expect(main.getOpacity()).toBe(1);
    expect(main.isFocused()).toBe(true);
    expect(pill.isVisible()).toBe(false);
    expect(pill.getOpacity()).toBe(1);
    expect(widgetIgnoresMouse()).toBe(false);
    expect(expand()).toBe(true);
    expect(main.setBounds).not.toHaveBeenCalled();
  });
  it("realizes the latest target through rapid close-open-close and taskbar reopen", () => {
    enableAnimations();
    collapse();
    vi.advanceTimersByTime(112);
    expect(expand()).toBe(false);
    vi.advanceTimersByTime(48);
    collapse();
    vi.advanceTimersByTime(224);
    expect(main.isMinimized()).toBe(true);
    expect(main.getOpacity()).toBe(1);
    expect(pill.isVisible()).toBe(true);
    main.restore();
    expect(main.isMinimized()).toBe(false);
    expect(main.getOpacity()).toBe(0);
    vi.advanceTimersByTime(224);
    expect(main.getOpacity()).toBe(1);
    expect(main.isFocused()).toBe(true);
    expect(pill.isVisible()).toBe(false);
    expect(taskbarWindows()).toEqual([main]);
  });
  it.each(["native-error", "renderer-crash", "display-change", "quit"])(
    "restores widget opacity and input after a crossfade ends through %s",
    (reason) => {
      const dwm = enableAnimations();
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      if (reason === "native-error")
        dwm.registerThumbnail.mockImplementationOnce(() => {
          throw new Error("DWM unavailable");
        });
      collapse();
      if (reason === "renderer-crash") main.webContents.emit("render-process-gone");
      if (reason === "display-change") Electron.screen.emit("display-removed");
      if (reason === "quit") Electron.app.emit("before-quit");
      expect(main.isMinimized()).toBe(true);
      expect(pill.isVisible()).toBe(true);
      expect(pill.getOpacity()).toBe(1);
      expect(widgetIgnoresMouse()).toBe(false);
      warning.mockRestore();
    },
  );
  it.each(["expand", "taskbar"])(
    "restores an interactive widget when %s reverses a crossfade while the renderer reloads",
    (action) => {
      enableAnimations();
      collapse();
      vi.advanceTimersByTime(48);
      main.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      if (action === "taskbar") main.restore();
      else expect(expand()).toBe(false);
      expect(main.isMinimized()).toBe(true);
      expect(pill.isVisible()).toBe(true);
      expect(pill.getOpacity()).toBe(1);
      expect(widgetIgnoresMouse()).toBe(false);
      send(main, Channels.SATELLITE_WORKSPACE_READY);
      vi.advanceTimersByTime(224);
      expect(main.isMinimized()).toBe(false);
      expect(main.getOpacity()).toBe(1);
      expect(pill.isVisible()).toBe(false);
      expect(pill.getOpacity()).toBe(1);
      expect(widgetIgnoresMouse()).toBe(false);
    },
  );
  it("settles an interrupted opening onto the available display without leaving a transparent workspace", () => {
    enableAnimations();
    collapse();
    vi.advanceTimersByTime(224);
    expand();
    vi.advanceTimersByTime(48);
    Electron.screen.emit("display-removed");
    expect(main.getOpacity()).toBe(1);
    expect(main.isMinimized()).toBe(false);
    expect(pill.isVisible()).toBe(false);
    expect(Electron.BrowserWindow.getAllWindows()).toHaveLength(2);
    vi.advanceTimersByTime(300);
    expect(main.isMinimized()).toBe(false);
    expect(main.getOpacity()).toBe(1);
  });
  it("keeps the widget usable if the renderer reloads or crashes during a transition", () => {
    enableAnimations();
    collapse();
    vi.advanceTimersByTime(224);
    expand();
    main.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    vi.advanceTimersByTime(224);
    expect(main.isMinimized()).toBe(true);
    expect(main.getOpacity()).toBe(1);
    expect(pill.isVisible()).toBe(true);
    send(main, Channels.SATELLITE_WORKSPACE_READY);
    vi.advanceTimersByTime(224);
    expect(main.isMinimized()).toBe(false);
    expect(main.getOpacity()).toBe(1);
    collapse();
    main.webContents.emit("render-process-gone");
    expect(pill.isVisible()).toBe(true);
    expect(main.isMinimized()).toBe(true);
    vi.advanceTimersByTime(300);
    expect(main.getOpacity()).toBe(1);
    expect(pill.isVisible()).toBe(true);
  });
  it("defers an interrupted opening until renderer readiness after a display change", () => {
    enableAnimations();
    collapse();
    vi.advanceTimersByTime(224);
    expand();
    main.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    Electron.screen.emit("display-removed");
    expect(main.isMinimized()).toBe(true);
    expect(main.getOpacity()).toBe(1);
    expect(pill.isVisible()).toBe(true);
    vi.advanceTimersByTime(300);
    expect(main.isMinimized()).toBe(true);
    send(main, Channels.SATELLITE_WORKSPACE_READY);
    vi.advanceTimersByTime(224);
    expect(main.isMinimized()).toBe(false);
    expect(main.getOpacity()).toBe(1);
    expect(main.isFocused()).toBe(true);
    expect(pill.isVisible()).toBe(false);
  });
  it.each(["close", "collapse", "late-widget-ready"])(
    "shows the widget without animating it while preserving main-window animation on %s",
    (action) => {
      if (action === "late-widget-ready") {
        pill.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      }
      if (action === "close") main.close();
      else collapse();
      if (action === "late-widget-ready") {
        expect(main.isMinimized()).toBe(false);
        send(pill, Channels.SATELLITE_PILL_READY);
      }
      expect(pill.isVisible()).toBe(true);
      expect(main.isMinimized()).toBe(true);
      expect(visibility.transitions).toEqual([
        { operation: "show-widget", animationsDisabled: true },
        { operation: "minimize-workspace", animationsDisabled: false },
      ]);
      expect(Electron.app.commandLine.hasSwitch("wm-window-animations-disabled")).toBe(false);
    },
  );
  it("scopes suppression to both widget transitions on repeated collapse and reopen", () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      visibility.transitions.length = 0;
      collapse();
      expect(pill.isVisible()).toBe(true);
      expect(main.isMinimized()).toBe(true);
      expand();
      expect(pill.isVisible()).toBe(false);
      expect(main.isMinimized()).toBe(false);
      expect(visibility.transitions).toEqual([
        { operation: "show-widget", animationsDisabled: true },
        { operation: "minimize-workspace", animationsDisabled: false },
        { operation: "hide-widget", animationsDisabled: true },
      ]);
      expect(Electron.app.commandLine.hasSwitch("wm-window-animations-disabled")).toBe(false);
    }
  });
  it("accepts native minimize without restoring and anchors from the last visible bounds", () => {
    main.setBounds({ x: 960, y: 0, width: 960, height: 1040 });
    main.minimize();
    expect(main.isMinimized()).toBe(true);
    expect(main.restore).not.toHaveBeenCalled();
    expect(pill.getBounds()).toEqual({ x: 1668, y: 100, width: 252, height: 56 });
    expect(saved().workspace).toEqual({
      bounds: { x: 960, y: 0, width: 960, height: 1040 },
      maximized: false,
    });
    vi.mocked(main.setBounds).mockClear();
    main.restore();
    expect(main.getBounds()).toEqual({ x: 960, y: 0, width: 960, height: 1040 });
    expect(main.setBounds).not.toHaveBeenCalled();
  });
  it("waits for renderer readiness when the taskbar restores a recovering workspace", () => {
    collapse();
    main.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    main.restore();
    expect(main.isMinimized()).toBe(true);
    expect(pill.isVisible()).toBe(true);
    expect(taskbarWindows()).toEqual([main]);
    main.restore();
    expect(main.isMinimized()).toBe(true);
    expect(pill.isVisible()).toBe(true);
    send(main, Channels.SATELLITE_WORKSPACE_READY);
    expect(main.isMinimized()).toBe(false);
    expect(main.isFocused()).toBe(true);
    expect(pill.isVisible()).toBe(false);
    expect(main.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_SHELL_STATE, {
      mode: "workspace",
      pinned: false,
      positionsLinked: true,
    });
  });
  it("defers reanchoring a moved linked widget until the taskbar restores the workspace", () => {
    main.setBounds({ x: 960, y: 0, width: 960, height: 1040 });
    collapse();
    vi.mocked(main.setBounds).mockClear();
    pill.setPosition(0, 0);
    expect(main.isMinimized()).toBe(true);
    expect(main.setBounds).not.toHaveBeenCalled();
    main.restore();
    expect(main.getBounds()).toEqual({ x: 0, y: 0, width: 960, height: 1040 });
    expect(main.isMinimized()).toBe(false);
    expect(pill.isVisible()).toBe(false);
    expect(saved().workspace.bounds).toEqual({ x: 0, y: 0, width: 960, height: 1040 });
  });
  it("persists actual native drag completion without moving or clamping on release", () => {
    const boundsBefore = vi.mocked(pill.setBounds).mock.calls.length;
    const before = vi.mocked(pill.setPosition).mock.calls.length;
    message(pill, 0x0231);
    pill.setPosition(-100, -20);
    message(pill, 0x0232);
    expect(saved()).toMatchObject({ x: -100, y: -20 });
    expect(vi.mocked(pill.setPosition).mock.calls.length).toBe(before + 1);
    expect(vi.mocked(pill.setBounds).mock.calls.length).toBe(boundsBefore);
    expect(pill.getBounds()).toMatchObject({ x: -100, y: -20, width: 252, height: 56 });
  });
  it("accepts only the pill sender for drag and only the main sender for publication", async () => {
    collapse();
    const start = await vi.mocked(loadWindowsPillDrag).mock.results[0]!.value;
    send(main, Channels.SATELLITE_PILL_DRAG_BEGIN);
    expect(start).not.toHaveBeenCalled();
    send(pill, Channels.SATELLITE_PILL_DRAG_BEGIN);
    expect(start).toHaveBeenCalledOnce();
    send(pill, Channels.SATELLITE_PUBLISH, state);
    expect(pill.webContents.send).not.toHaveBeenCalledWith(Channels.SATELLITE_PILL_STATE, state);
    send(main, Channels.SATELLITE_PUBLISH, state);
    expect(pill.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_PILL_STATE, state);
    send(main, Channels.SATELLITE_PILL_OPEN);
    expect(reveal).not.toHaveBeenCalled();
    send(pill, Channels.SATELLITE_PILL_OPEN);
    expect(reveal).toHaveBeenCalledOnce();
  });
  it("remembers keyboard snap geometry without requiring a mouse gesture", () => {
    expand();
    main.setBounds({ x: 960, y: 0, width: 960, height: 1040 });
    vi.advanceTimersByTime(250);
    expect(saved().workspace).toEqual({
      bounds: { x: 960, y: 0, width: 960, height: 1040 },
      maximized: false,
    });
    collapse();
    expand();
    message(main, 0x0231);
    main.emit("will-resize");
    main.setBounds({ x: 20, y: 20, width: 1200, height: 820 });
    message(main, 0x0232);
    expect(saved().workspace.bounds).toEqual({ x: 20, y: 20, width: 1200, height: 820 });
    collapse();
    expand();
    expect(main.getBounds()).toMatchObject({ width: 1200, height: 820 });
  });
  it("relays only valid pill attention intents to the retained workspace", () => {
    const ref = { environmentId: "remote", threadId: "t1", kind: "question", requestId: "q1" };
    const intent = {
      type: "answer",
      ref,
      questionId: "choice",
      answer: { customAnswer: "Keep it" },
    };
    vi.mocked(main.webContents.send).mockClear();
    send(main, Channels.SATELLITE_ATTENTION_INTENT, intent);
    send(pill, Channels.SATELLITE_ATTENTION_INTENT, {
      ...intent,
      ref: { ...ref, kind: "approval" },
    });
    send(pill, Channels.SATELLITE_ATTENTION_INTENT, { ...intent, answer: null });
    send(pill, Channels.SATELLITE_ATTENTION_INTENT, { ...intent, extra: "discard" });
    expect(vi.mocked(main.webContents.send).mock.calls).toEqual([
      [Channels.SATELLITE_ATTENTION_INTENT, intent],
    ]);
  });
  it("lets the workspace open itself only through its own guarded channel", () => {
    collapse();
    send(pill, Channels.SATELLITE_OPEN_MAIN);
    expect(main.isMinimized()).toBe(true);
    send(main, Channels.SATELLITE_OPEN_MAIN);
    expect(main.isVisible()).toBe(true);
    expect(pill.isVisible()).toBe(false);
  });
  it("publishes native panel geometry and excludes the transparent gaps from its shape", () => {
    collapse();
    send(main, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "panel", wing: true });
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "other", wing: true });
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, {
      mode: "panel",
      wing: "invalid",
    });
    expect(pill.getBounds()).toEqual({ x: 100, y: 100, width: 252, height: 56 });
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, {
      mode: "panel",
      wing: true,
    });
    expect(pill.getBounds()).toEqual({ x: 0, y: 100, width: 672, height: 568 });
    expect(pill.setShape).toHaveBeenLastCalledWith([
      { x: 100, y: 0, width: 252, height: 56 },
      { x: 352, y: 0, width: 64, height: 56 },
      { x: 0, y: 68, width: 440, height: 500 },
    ]);
    expect(pill.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_PILL_LAYOUT, {
      mode: "panel",
      width: 672,
      height: 568,
      pill: { x: 100, y: 0, width: 252, height: 56 },
      wing: { x: 352, y: 0, width: 64, height: 56 },
      panel: { x: 0, y: 68, width: 440, height: 500 },
    });
    expect(pill.isFocused()).toBe(true);
    expect(main.isMinimized()).toBe(true);
  });
  it("preserves the compact anchor and workspace size across repeated wing expansion", () => {
    collapse();
    for (let index = 0; index < 5; index++) {
      send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "preview", wing: true });
      send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "panel", wing: true });
      expand();
      expect(main.getBounds()).toMatchObject({ width: 1100, height: 780 });
      collapse();
    }
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "compact", wing: false });
    expect(pill.getBounds()).toEqual({ x: 100, y: 100, width: 252, height: 56 });
    expect(saved()).toMatchObject({
      x: 100,
      y: 100,
      workspace: { bounds: { width: 1100, height: 780 } },
    });
  });
  it("moves the compact anchor while the panel extends above it", () => {
    collapse();
    pill.setPosition(1644, 960);
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "panel", wing: true });
    expect(pill.getBounds()).toEqual({ x: 1480, y: 448, width: 440, height: 568 });
    send(pill, Channels.SATELLITE_PILL_MOVE, "ArrowLeft");
    expect(saved()).toMatchObject({ x: 1588, y: 960 });
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "compact", wing: false });
    expect(pill.getBounds()).toEqual({ x: 1588, y: 960, width: 252, height: 56 });
  });
  it("defers layout changes during native capture and persists the control anchor", () => {
    collapse();
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "panel", wing: true });
    message(pill, 0x0231);
    pill.setPosition(270, 300);
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "compact", wing: true });
    expect(pill.getBounds()).toEqual({ x: 270, y: 300, width: 672, height: 568 });
    message(pill, 0x0232);
    expect(pill.getBounds()).toEqual({ x: 246, y: 300, width: 696, height: 568 });
    expect(saved()).toMatchObject({ x: 370, y: 300 });
  });
  it.each(["capture"] as const)(
    "acknowledges only applied layout requests while %s coalesces pending changes",
    () => {
      collapse();
      send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, {
        requestId: "applied",
        mode: "panel",
        wing: true,
      });
      message(pill, 0x0231);
      vi.mocked(pill.webContents.send).mockClear();
      send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, {
        requestId: "superseded",
        mode: "preview",
        wing: true,
      });
      send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, {
        requestId: "latest",
        mode: "panel",
        wing: true,
      });
      expect(publishedLayouts()).toEqual([]);
      expect(pill.getBounds()).toMatchObject({ width: 672, height: 568 });
      send(pill, Channels.SATELLITE_PILL_READY);
      expect(publishedLayouts()).toEqual([
        expect.objectContaining({ requestId: "applied", mode: "panel", height: 568 }),
      ]);
      message(pill, 0x0232);
      expect(pill.getBounds()).toMatchObject({ width: 672, height: 568 });
      expect(publishedLayouts()).toEqual([
        expect.objectContaining({ requestId: "applied", mode: "panel", height: 568 }),
        expect.objectContaining({ requestId: "latest", mode: "panel", height: 568 }),
      ]);
    },
  );
  it("retains the applied request ID through movement, autonomous blur, and ready snapshots", () => {
    collapse();
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, {
      requestId: "opened-panel",
      mode: "panel",
      wing: true,
    });
    send(pill, Channels.SATELLITE_PILL_MOVE, "ArrowRight");
    expect(publishedLayouts().at(-1)).toMatchObject({ requestId: "opened-panel", mode: "panel" });
    pill.blur();
    vi.advanceTimersByTime(150);
    expect(publishedLayouts().at(-1)).toMatchObject({
      requestId: "opened-panel",
      mode: "compact",
      panel: null,
    });
    vi.mocked(pill.webContents.send).mockClear();
    send(pill, Channels.SATELLITE_PILL_READY);
    expect(publishedLayouts()).toEqual([
      expect.objectContaining({ requestId: "opened-panel", mode: "compact", panel: null }),
    ]);
  });
  it.each([
    { blocker: "capture", returnWhileBlocked: false },
    { blocker: "capture", returnWhileBlocked: true },
  ])(
    "acknowledges cancelled layout intent across workspace transitions with $blocker, returning while blocked: $returnWhileBlocked",
    ({ returnWhileBlocked }) => {
      collapse();
      send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, {
        requestId: "applied",
        mode: "panel",
        wing: true,
      });
      message(pill, 0x0231);
      vi.mocked(pill.webContents.send).mockClear();
      send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, {
        requestId: "opening",
        mode: "panel",
        wing: true,
      });
      expand();
      if (returnWhileBlocked) {
        send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, {
          requestId: "workspace-update",
          mode: "panel",
          wing: true,
        });
        collapse();
      }
      expect(publishedLayouts()).toEqual([]);
      message(pill, 0x0232);
      const compact = expect.objectContaining({
        requestId: returnWhileBlocked ? "workspace-update" : "opening",
        mode: "compact",
        panel: null,
      });
      expect(publishedLayouts()).toEqual([compact]);
      if (!returnWhileBlocked) collapse();
      expect(publishedLayouts().at(-1)).toEqual(compact);
      expect(pill.getBounds()).toMatchObject({ width: 672, height: 568 });
      expect(pill.isVisible()).toBe(true);
      send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, {
        requestId: "reopened",
        mode: "panel",
        wing: true,
      });
      expect(publishedLayouts().at(-1)).toMatchObject({ requestId: "reopened", mode: "panel" });
    },
  );
  it("collapses panel blur without opening or moving the workspace", () => {
    collapse();
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "panel", wing: true });
    pill.blur();
    vi.advanceTimersByTime(150);
    expect(pill.getBounds()).toEqual({ x: 0, y: 100, width: 672, height: 568 });
    expect(pill.webContents.send).toHaveBeenLastCalledWith(
      Channels.SATELLITE_PILL_LAYOUT,
      expect.objectContaining({ mode: "compact", panel: null }),
    );
    expect(main.isMinimized()).toBe(true);
  });
  it("keeps a panel open during native capture and preserves tray actions", () => {
    collapse();
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "panel", wing: true });
    message(pill, 0x0231);
    pill.blur();
    vi.advanceTimersByTime(150);
    expect(publishedLayouts().at(-1)).toMatchObject({ mode: "panel", height: 568 });
    message(pill, 0x0232);
    vi.advanceTimersByTime(150);
    expect(publishedLayouts().at(-1)).toMatchObject({ mode: "compact", panel: null });
    const entries = vi.mocked(Electron.Menu.buildFromTemplate).mock.calls[0]![0];
    expect(entries.map((entry) => entry.label).filter(Boolean)).toEqual([
      "Open workspace",
      "Collapse to widget",
      "Link widget and window positions",
      "Keep workspace open",
      "Quit SatelliteT3",
    ]);
    Reflect.apply(entries.find((entry) => entry.label === "Open workspace")!.click!, undefined, []);
    expect(main.isVisible()).toBe(true);
    Reflect.apply(
      entries.find((entry) => entry.label === "Collapse to widget")!.click!,
      undefined,
      [],
    );
    expect(pill.isVisible()).toBe(true);
  });
  it("reflows the panel after a native drag to the opposite display edge", () => {
    collapse();
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "panel", wing: true });
    message(pill, 0x0231);
    pill.setPosition(1546, 946);
    message(pill, 0x0232);
    expect(pill.getBounds()).toEqual({ x: 1480, y: 434, width: 440, height: 568 });
    expect(pill.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_PILL_LAYOUT, {
      mode: "panel",
      width: 440,
      height: 568,
      pill: { x: 124, y: 512, width: 252, height: 56 },
      wing: { x: 376, y: 512, width: 64, height: 56 },
      panel: { x: 0, y: 0, width: 440, height: 500 },
    });
    expect(saved()).toMatchObject({
      x: 1604,
      y: 946,
      workspace: { bounds: { width: 1100, height: 780 } },
    });
    send(pill, Channels.SATELLITE_PILL_LAYOUT_REQUEST, { mode: "compact", wing: false });
    expect(pill.getBounds()).toEqual({ x: 1604, y: 946, width: 252, height: 56 });
  });
  it("collapses on outside blur and close while respecting pin", () => {
    expand();
    main.blur();
    vi.advanceTimersByTime(150);
    expect(pill.isVisible()).toBe(true);
    expand();
    send(main, Channels.SATELLITE_SET_PINNED, true);
    main.blur();
    vi.advanceTimersByTime(150);
    expect(main.isVisible()).toBe(true);
    expect(main.isMinimized()).toBe(false);
    main.close();
    expect(main.isDestroyed()).toBe(false);
    expect(pill.isVisible()).toBe(true);
  });
  it("retains a right-hand workspace independently of the top-centre pill across cycles", () => {
    send(main, Channels.SATELLITE_SET_POSITIONS_LINKED, false);
    collapse();
    pill.setPosition(800, 0);
    expand();
    main.setBounds({ x: 960, y: 0, width: 960, height: 1040 });
    vi.mocked(main.setBounds).mockClear();
    for (let cycle = 0; cycle < 20; cycle++) {
      collapse();
      expect(pill.getBounds()).toEqual({ x: 800, y: 0, width: 252, height: 56 });
      expand();
      expect(main.getBounds()).toEqual({ x: 960, y: 0, width: 960, height: 1040 });
    }
    expect(main.setBounds).not.toHaveBeenCalled();
    collapse();
    send(pill, Channels.SATELLITE_PILL_MOVE, "ArrowRight");
    expand();
    expect(main.getBounds()).toEqual({ x: 960, y: 0, width: 960, height: 1040 });
    main.setPosition(900, 0);
    collapse();
    expect(pill.getBounds()).toEqual({ x: 816, y: 0, width: 252, height: 56 });
  });
  it("keeps linked native snap placement until the pill is deliberately moved", () => {
    main.setBounds({ x: 960, y: 0, width: 960, height: 1040 });
    vi.mocked(main.setBounds).mockClear();
    for (let cycle = 0; cycle < 20; cycle++) {
      collapse();
      expand();
    }
    expect(main.getBounds()).toEqual({ x: 960, y: 0, width: 960, height: 1040 });
    expect(main.setBounds).not.toHaveBeenCalled();
    collapse();
    pill.setPosition(0, 0);
    expand();
    expect(main.getBounds()).toEqual({ x: 0, y: 0, width: 960, height: 1040 });
  });
  it("toggles linking without moving visible surfaces or changing pinning", () => {
    send(main, Channels.SATELLITE_SET_PINNED, true);
    const initial = main.getBounds();
    send(main, Channels.SATELLITE_SET_POSITIONS_LINKED, false);
    expect(main.getBounds()).toEqual(initial);
    expect(pill.getBounds()).toEqual({ x: 100, y: 100, width: 252, height: 56 });
    main.setBounds({ x: 960, y: 0, width: 960, height: 1040 });
    send(main, Channels.SATELLITE_SET_POSITIONS_LINKED, true);
    expect(main.getBounds()).toEqual({ x: 960, y: 0, width: 960, height: 1040 });
    expect(pill.getBounds()).toEqual({ x: 100, y: 100, width: 252, height: 56 });
    expect(main.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_SHELL_STATE, {
      mode: "workspace",
      pinned: true,
      positionsLinked: true,
    });
    collapse();
    expect(pill.getBounds()).toEqual({ x: 1668, y: 100, width: 252, height: 56 });
  });
  it("restores independent positions and maximize state after restarting", () => {
    send(main, Channels.SATELLITE_SET_POSITIONS_LINKED, false);
    collapse();
    pill.setPosition(800, 0);
    expand();
    main.setBounds({ x: 960, y: 0, width: 960, height: 1040 });
    main.maximize();
    Electron.app.emit("before-quit");
    const preference = saved();
    expect(preference).toEqual({
      x: 800,
      y: 0,
      positionsLinked: false,
      workspace: { bounds: { x: 960, y: 0, width: 960, height: 1040 }, maximized: true },
    });
    main.destroy();
    vi.mocked(NodeFS.readFileSync).mockReturnValue(JSON.stringify(preference));
    createShell();
    send(main, Channels.SATELLITE_WORKSPACE_READY);
    send(pill, Channels.SATELLITE_PILL_READY);
    expect(main.isMaximized()).toBe(true);
    expect(main.getNormalBounds()).toEqual({ x: 960, y: 0, width: 960, height: 1040 });
    collapse();
    expect(pill.getBounds()).toEqual({ x: 800, y: 0, width: 252, height: 56 });
    expand();
    expect(main.isMaximized()).toBe(true);
    main.unmaximize();
    expect(main.getBounds()).toEqual({ x: 960, y: 0, width: 960, height: 1040 });
  });
  it("retains maximization through ordinary collapse and intercepted minimize", () => {
    main.maximize();
    vi.mocked(main.unmaximize).mockClear();
    collapse();
    expand();
    expect(main.isMaximized()).toBe(true);
    expect(main.unmaximize).not.toHaveBeenCalled();
    main.minimize();
    expect(pill.isVisible()).toBe(true);
    expand();
    expect(main.isMaximized()).toBe(true);
    expect(main.getNormalBounds()).toEqual({ x: 49, y: 26, width: 1100, height: 780 });
  });
  it("relinks from the tray menu without moving the retained workspace on reveal", () => {
    send(main, Channels.SATELLITE_SET_POSITIONS_LINKED, false);
    main.setBounds({ x: 960, y: 0, width: 960, height: 1040 });
    collapse();
    pill.setPosition(800, 0);
    const link = vi
      .mocked(Electron.Menu.buildFromTemplate)
      .mock.lastCall![0].find((item) => item.label === "Link widget and window positions")!;
    link.click?.({ checked: true } as Electron.MenuItem, main, {} as Electron.KeyboardEvent);
    expect(pill.getBounds()).toEqual({ x: 800, y: 0, width: 252, height: 56 });
    expand();
    expect(main.getBounds()).toEqual({ x: 960, y: 0, width: 960, height: 1040 });
    collapse();
    expect(pill.getBounds()).toEqual({ x: 1668, y: 0, width: 252, height: 56 });
  });
  it("does not reveal a restored maximized workspace before first paint", () => {
    main.destroy();
    vi.mocked(NodeFS.readFileSync).mockReturnValue(
      JSON.stringify({
        x: 800,
        y: 0,
        positionsLinked: false,
        workspace: { bounds: { x: 960, y: 0, width: 960, height: 1040 }, maximized: true },
      }),
    );
    createShell();
    expect(main.isVisible()).toBe(false);
    main.emit("ready-to-show");
    expect(main.isVisible()).toBe(true);
    expect(main.isMaximized()).toBe(true);
    expect(main.getNormalBounds()).toEqual({ x: 960, y: 0, width: 960, height: 1040 });
  });
  it("repairs maximized restore bounds while keeping a collapsed workspace minimized", () => {
    send(main, Channels.SATELLITE_SET_POSITIONS_LINKED, false);
    main.setBounds({ x: -1280, y: 0, width: 640, height: 900 });
    main.maximize();
    collapse();
    vi.mocked(main.maximize).mockClear();
    Electron.screen.emit("display-removed");
    expect(main.isMinimized()).toBe(true);
    expect(main.maximize).not.toHaveBeenCalled();
    expect(saved().workspace).toEqual({
      bounds: { x: 0, y: 0, width: 640, height: 900 },
      maximized: true,
    });
    main.restore();
    expect(main.isMaximized()).toBe(true);
    expect(main.getNormalBounds()).toEqual({ x: 0, y: 0, width: 640, height: 900 });
  });
  it("migrates old size-only preferences to linked placement", () => {
    main.destroy();
    vi.mocked(NodeFS.readFileSync).mockReturnValue(
      JSON.stringify({
        x: 800,
        y: 0,
        workspaceWidth: 700,
        workspaceHeight: 500,
      }),
    );
    createShell();
    send(main, Channels.SATELLITE_WORKSPACE_READY);
    expect(main.getBounds()).toEqual({ x: 585, y: 0, width: 700, height: 500 });
    expect(main.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_SHELL_STATE, {
      mode: "workspace",
      pinned: false,
      positionsLinked: true,
    });
    collapse();
    expect(saved().workspace).toEqual({
      bounds: { x: 585, y: 0, width: 700, height: 500 },
      maximized: false,
    });
  });
  it("does not collapse during a native move or persist every intermediate resize", () => {
    message(main, 0x0231);
    main.blur();
    vi.mocked(NodeFS.writeFileSync).mockClear();
    main.setBounds({ x: 800, y: 0, width: 800, height: 900 });
    main.setBounds({ x: 960, y: 0, width: 960, height: 1040 });
    vi.advanceTimersByTime(500);
    expect(main.isVisible()).toBe(true);
    expect(NodeFS.writeFileSync).not.toHaveBeenCalled();
    message(main, 0x0232);
    expect(saved().workspace.bounds).toEqual({ x: 960, y: 0, width: 960, height: 1040 });
    expect(main.isVisible()).toBe(true);
  });
  it("recovers the minimized workspace independently when its monitor disappears", () => {
    send(main, Channels.SATELLITE_SET_POSITIONS_LINKED, false);
    main.setBounds({ x: -1280, y: 0, width: 640, height: 900 });
    collapse();
    pill.setPosition(800, 0);
    Electron.screen.emit("display-removed");
    expect(main.isMinimized()).toBe(true);
    expect(saved().workspace.bounds).toEqual({ x: 0, y: 0, width: 640, height: 900 });
    expect(pill.getBounds()).toEqual({ x: 800, y: 0, width: 252, height: 56 });
    expand();
    expect(main.getBounds()).toEqual({ x: 0, y: 0, width: 640, height: 900 });
    vi.mocked(main.setBounds).mockClear();
    Electron.screen.emit("display-added");
    expect(main.setBounds).not.toHaveBeenCalled();
    expect(saved().workspace.bounds).toEqual({ x: 0, y: 0, width: 640, height: 900 });
  });
  it("marks stale and crashed workspace status unavailable", () => {
    const theme = {
      "--background": "#163024",
      "--foreground": "#fafafa",
      "--muted-foreground": "#aaaaaa",
      "--border": "#335544",
      "--primary": "#558866",
      "--ring": "#669977",
      "--warning": "#f0d060",
      "--success": "#60c060",
      "--destructive": "#d06060",
      "--font-sans": "Segoe UI",
    };
    send(main, Channels.SATELLITE_PUBLISH, { ...state, theme });
    expect(pill.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_PILL_STATE, {
      ...state,
      theme,
    });
    vi.advanceTimersByTime(30_000);
    expect(pill.webContents.send).toHaveBeenLastCalledWith(
      Channels.SATELLITE_PILL_STATE,
      expect.objectContaining({ state: "unknown", theme }),
    );
    expand();
    main.webContents.emit("render-process-gone");
    expect(pill.isVisible()).toBe(true);
    pill.webContents.emit("render-process-gone");
    expect(pill.webContents.reload).toHaveBeenCalledOnce();
    send(pill, Channels.SATELLITE_PILL_READY);
    expect(
      vi
        .mocked(pill.webContents.send)
        .mock.calls.findLast(([channel]) => channel === Channels.SATELLITE_PILL_STATE),
    ).toEqual([
      Channels.SATELLITE_PILL_STATE,
      expect.objectContaining({ state: "unknown", theme }),
    ]);
  });
  it("clamps keyboard movement and recovers after scale-only notifications", () => {
    collapse();
    pill.setPosition(-50, -50);
    send(pill, Channels.SATELLITE_PILL_MOVE, "ArrowLeft");
    expect(pill.getBounds()).toMatchObject({ x: 0, y: 0 });
    pill.setPosition(-50, -50);
    Electron.screen.emit("display-metrics-changed", {}, {}, ["scaleFactor"]);
    expect(pill.getBounds().x).toBe(0);
    Electron.screen.emit("display-removed");
    expect(pill.getBounds()).toMatchObject({ x: 0, y: 0 });
  });
  it("destroys the auxiliary surface and unregisters IPC with its lifecycle owner", () => {
    const count = Electron.ipcMain.listenerCount(Channels.SATELLITE_PUBLISH);
    main.destroy();
    expect(pill.isDestroyed()).toBe(true);
    expect(Electron.ipcMain.listenerCount(Channels.SATELLITE_PUBLISH)).toBe(count - 1);
  });
  it("replays a topology change deferred during native capture", () => {
    message(pill, 0x0231);
    pill.setPosition(-80, -20);
    Electron.screen.emit("display-removed");
    expect(pill.getBounds().x).toBe(-80);
    message(pill, 0x0232);
    expect(pill.getBounds()).toEqual({ x: 0, y: 0, width: 252, height: 56 });
  });
  it("recovers a minimized workspace on a small work area with usable native minimums", () => {
    collapse();
    const primary = {
      id: 1,
      workArea: { x: 0, y: 0, width: 700, height: 500 },
    } as Electron.Display;
    const primarySpy = vi.spyOn(Electron.screen, "getPrimaryDisplay").mockReturnValue(primary);
    const displaysSpy = vi.spyOn(Electron.screen, "getAllDisplays").mockReturnValue([primary]);
    Electron.screen.emit("display-removed");
    expect(main.isMinimized()).toBe(true);
    expand();
    expect(main.getBounds()).toMatchObject({ width: 700, height: 500 });
    expect(main.setMinimumSize).toHaveBeenLastCalledWith(480, 360);
    collapse();
    expect(saved().workspace.bounds).toEqual({ x: 0, y: 0, width: 700, height: 500 });
    primarySpy.mockRestore();
    displaysSpy.mockRestore();
  });
  it("keeps a recovering workspace minimized until its renderer is ready", () => {
    collapse();
    main.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(expandSatelliteWindow(main)).toBe(false);
    expect(main.isMinimized()).toBe(true);
    expect(pill.isVisible()).toBe(true);
    send(main, Channels.SATELLITE_WORKSPACE_READY);
    expect(main.isVisible()).toBe(true);
    expect(pill.isVisible()).toBe(false);
    expect(reveal).toHaveBeenCalledOnce();
    expect(expandSatelliteWindow(main)).toBe(true);
  });
  it("keeps both surfaces ready through same-document and subframe navigation", () => {
    for (const window of [main, pill]) {
      window.webContents.emit("did-start-loading");
      window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
      window.webContents.emit("did-start-navigation", {
        isMainFrame: false,
        isSameDocument: false,
      });
    }
    expect(expandSatelliteWindow(main)).toBe(true);
    expect(main.isVisible()).toBe(true);
    expect(pill.isVisible()).toBe(false);
    collapse();
    expect(main.isMinimized()).toBe(true);
    expect(pill.isVisible()).toBe(true);
  });
  it("waits for a reloaded widget document before minimizing the workspace", () => {
    expand();
    pill.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    collapse();
    expect(main.isVisible()).toBe(true);
    expect(pill.isVisible()).toBe(false);
    send(pill, Channels.SATELLITE_PILL_READY);
    expect(main.isMinimized()).toBe(true);
    expect(pill.isVisible()).toBe(true);
  });
});
