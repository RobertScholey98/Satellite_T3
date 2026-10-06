// @effect-diagnostics nodeBuiltinImport:off -- Native boundary tests exercise Electron lifecycle events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Electron from "electron";
import * as NodeFS from "node:fs";
import { expandSatelliteWindow, installSatellitePill } from "./SatellitePill.ts";
import { loadWindowsPillDrag } from "./WindowsPillDrag.ts";
import { installWindowsDoubleControl } from "./WindowsDoubleControl.ts";
import * as Channels from "./channels.ts";

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
    normalBounds = this.bounds;
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      getZoomFactor: vi.fn(() => 1),
      setZoomFactor: vi.fn(),
      reload: vi.fn(),
    });
    hide = vi.fn(() => {
      this.visible = false;
    });
    showInactive = vi.fn(() => {
      this.visible = true;
    });
    show = vi.fn(() => {
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
    setSkipTaskbar = vi.fn();
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
      this.minimized = false;
      this.unmaximize();
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
      this.minimized = true;
      this.emit("minimize");
    });
    isMaximized = () => this.maximized;
    isMinimized = () => this.minimized;
    getNormalBounds = () => (this.maximized ? this.normalBounds : this.bounds);
    isEnabled = vi.fn(() => true);
    getChildWindows = vi.fn(() => []);
    constructor(_options: Electron.BrowserWindowConstructorOptions) {
      super();
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
  const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  return {
    BrowserWindow: FakeWindow,
    app: Object.assign(new EventEmitter(), { getPath: () => "/isolated", quit: vi.fn() }),
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
  const expand = () => expandSatelliteWindow(main);
  const collapse = () => send(main, Channels.SATELLITE_HIDE_MAIN);
  const createShell = () => {
    main = new Electron.BrowserWindow({});
    reveal = vi.fn(() => {
      expand();
    });
    installSatellitePill(main, {
      revealMain: reveal,
      pillUrl: "http://localhost/satellite-pill.html",
      pillPreloadPath: "/pill.cjs",
    });
    pill = Electron.BrowserWindow.getAllWindows().find((window) => window !== main)!;
  };
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(NodeFS.readFileSync).mockReturnValue('{"x":100,"y":100}');
    createShell();
    await Promise.resolve();
    send(main, Channels.SATELLITE_WORKSPACE_READY);
    send(pill, Channels.SATELLITE_PILL_READY);
    reveal.mockClear();
  });
  afterEach(() => {
    for (const window of Electron.BrowserWindow.getAllWindows()) window.destroy();
    vi.useRealTimers();
  });
  it("boots an expanded resizable workspace and keeps the pill hidden", () => {
    expect(pill.getBounds()).toEqual({ x: 100, y: 100, width: 320, height: 70 });
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
    expect(main.isVisible()).toBe(false);
    expect(pill.isVisible()).toBe(true);
  });
  it("switches surfaces without destroying the mounted workspace", () => {
    expand();
    expect(main.isVisible()).toBe(true);
    expect(pill.isVisible()).toBe(false);
    collapse();
    expect(main.isVisible()).toBe(false);
    expect(pill.isVisible()).toBe(true);
    expect(main.isDestroyed()).toBe(false);
    expand();
    expect(main.isVisible()).toBe(true);
    expect(Electron.BrowserWindow.getAllWindows()).toHaveLength(2);
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
    expect(pill.getBounds()).toMatchObject({ x: -100, y: -20, width: 320, height: 70 });
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
      expect(pill.getBounds()).toEqual({ x: 800, y: 0, width: 320, height: 70 });
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
    expect(pill.getBounds()).toEqual({ x: 816, y: 0, width: 320, height: 70 });
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
    expect(pill.getBounds()).toEqual({ x: 100, y: 100, width: 320, height: 70 });
    main.setBounds({ x: 960, y: 0, width: 960, height: 1040 });
    send(main, Channels.SATELLITE_SET_POSITIONS_LINKED, true);
    expect(main.getBounds()).toEqual({ x: 960, y: 0, width: 960, height: 1040 });
    expect(pill.getBounds()).toEqual({ x: 100, y: 100, width: 320, height: 70 });
    expect(main.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_SHELL_STATE, {
      mode: "workspace",
      pinned: true,
      positionsLinked: true,
    });
    collapse();
    expect(pill.getBounds()).toEqual({ x: 1600, y: 100, width: 320, height: 70 });
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
    expect(pill.getBounds()).toEqual({ x: 800, y: 0, width: 320, height: 70 });
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
    expect(main.getNormalBounds()).toEqual({ x: 51, y: 27, width: 1100, height: 780 });
  });
  it("relinks from the pill menu without moving the retained workspace on reveal", () => {
    send(main, Channels.SATELLITE_SET_POSITIONS_LINKED, false);
    main.setBounds({ x: 960, y: 0, width: 960, height: 1040 });
    collapse();
    pill.setPosition(800, 0);
    send(pill, Channels.SATELLITE_PILL_MENU);
    const link = vi
      .mocked(Electron.Menu.buildFromTemplate)
      .mock.lastCall![0].find((item) => item.label === "Link pill and window positions")!;
    link.click?.({ checked: true } as Electron.MenuItem, main, {} as Electron.KeyboardEvent);
    expect(pill.getBounds()).toEqual({ x: 800, y: 0, width: 320, height: 70 });
    expand();
    expect(main.getBounds()).toEqual({ x: 960, y: 0, width: 960, height: 1040 });
    collapse();
    expect(pill.getBounds()).toEqual({ x: 1600, y: 0, width: 320, height: 70 });
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
  it("repairs maximized restore bounds while keeping a collapsed workspace hidden", () => {
    send(main, Channels.SATELLITE_SET_POSITIONS_LINKED, false);
    main.setBounds({ x: -1280, y: 0, width: 640, height: 900 });
    main.maximize();
    collapse();
    vi.mocked(main.maximize).mockClear();
    Electron.screen.emit("display-removed");
    expect(main.isVisible()).toBe(false);
    expect(main.maximize).not.toHaveBeenCalled();
    expect(saved().workspace).toEqual({
      bounds: { x: 0, y: 0, width: 640, height: 900 },
      maximized: true,
    });
    expand();
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
    expect(main.getBounds()).toEqual({ x: 610, y: 0, width: 700, height: 500 });
    expect(main.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_SHELL_STATE, {
      mode: "workspace",
      pinned: false,
      positionsLinked: true,
    });
    collapse();
    expect(saved().workspace).toEqual({
      bounds: { x: 610, y: 0, width: 700, height: 500 },
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
  it("recovers the hidden workspace independently when its monitor disappears", () => {
    send(main, Channels.SATELLITE_SET_POSITIONS_LINKED, false);
    main.setBounds({ x: -1280, y: 0, width: 640, height: 900 });
    collapse();
    pill.setPosition(800, 0);
    Electron.screen.emit("display-removed");
    expect(main.isVisible()).toBe(false);
    expect(main.getBounds()).toEqual({ x: 0, y: 0, width: 640, height: 900 });
    expect(pill.getBounds()).toEqual({ x: 800, y: 0, width: 320, height: 70 });
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
    expect(pill.webContents.send).toHaveBeenLastCalledWith(
      Channels.SATELLITE_PILL_STATE,
      expect.objectContaining({ state: "unknown", theme }),
    );
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
    expect(pill.getBounds()).toEqual({ x: 0, y: 0, width: 320, height: 70 });
  });
  it("recovers a hidden workspace on a small work area with usable native minimums", () => {
    collapse();
    const primary = {
      id: 1,
      workArea: { x: 0, y: 0, width: 700, height: 500 },
    } as Electron.Display;
    const primarySpy = vi.spyOn(Electron.screen, "getPrimaryDisplay").mockReturnValue(primary);
    const displaysSpy = vi.spyOn(Electron.screen, "getAllDisplays").mockReturnValue([primary]);
    Electron.screen.emit("display-removed");
    expect(main.isVisible()).toBe(false);
    expand();
    expect(main.getBounds()).toMatchObject({ width: 700, height: 500 });
    expect(main.setMinimumSize).toHaveBeenLastCalledWith(480, 360);
    collapse();
    expect(saved().workspace.bounds).toEqual({ x: 0, y: 0, width: 700, height: 500 });
    primarySpy.mockRestore();
    displaysSpy.mockRestore();
  });
  it("keeps a recovering workspace hidden until its renderer is ready", () => {
    collapse();
    main.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(expandSatelliteWindow(main)).toBe(false);
    expect(main.isVisible()).toBe(false);
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
    expect(main.isVisible()).toBe(false);
    expect(pill.isVisible()).toBe(true);
  });
  it("waits for a reloaded pill document before hiding the last workspace surface", () => {
    expand();
    pill.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    collapse();
    expect(main.isVisible()).toBe(true);
    expect(pill.isVisible()).toBe(false);
    send(pill, Channels.SATELLITE_PILL_READY);
    expect(main.isVisible()).toBe(false);
    expect(pill.isVisible()).toBe(true);
  });
});
