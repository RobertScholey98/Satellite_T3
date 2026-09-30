// @effect-diagnostics nodeBuiltinImport:off -- Native boundary tests exercise Electron lifecycle events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Electron from "electron";
import * as NodeFS from "node:fs";
import type { SatelliteShellState } from "@t3tools/contracts";
import { expandSatelliteWindow, installSatellitePill } from "./SatellitePill.ts";
import * as Channels from "./channels.ts";

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
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      getZoomFactor: vi.fn(() => 1),
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
    restore = vi.fn();
    isEnabled = vi.fn(() => true);
    getChildWindows = vi.fn(() => []);
    constructor(_options: Electron.BrowserWindowConstructorOptions) {
      super();
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

describe("native Satellite shell", () => {
  let main: Electron.BrowserWindow;
  let reveal = vi.fn<() => void>();
  const send = (channel: string, value?: unknown) =>
    Electron.ipcMain.emit(channel, { sender: main.webContents }, value);
  const cursorAt = (x: number, y: number) =>
    vi.mocked(Electron.screen.getCursorScreenPoint).mockReturnValue({ x, y });
  const shell = () =>
    vi
      .mocked(main.webContents.send)
      .mock.calls.findLast(
        ([channel]) => channel === Channels.SATELLITE_SHELL_STATE,
      )?.[1] as SatelliteShellState;
  const settle = () => send(Channels.SATELLITE_TRANSITION_FINISHED, shell().transitionId);
  const pill = () => ({
    ...shell().pillBounds,
    x: main.getBounds().x + shell().pillBounds.x,
    y: main.getBounds().y + shell().pillBounds.y,
  });
  const expectPillShape = () => {
    expect(main.setShape).toHaveBeenLastCalledWith([shell().pillBounds]);
    expect(pill().width).toBe(320);
    expect(pill().height).toBe(70);
  };
  const expand = () => {
    send(Channels.SATELLITE_PILL_OPEN);
    settle();
  };
  const collapse = () => {
    send(Channels.SATELLITE_HIDE_MAIN);
    settle();
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    cursorAt(0, 0);
    main = new Electron.BrowserWindow({});
    reveal = vi.fn(() => {
      expandSatelliteWindow(main);
      main.show();
      main.focus();
    });
    installSatellitePill(main, { revealMain: reveal });
    send(Channels.SATELLITE_PILL_READY);
  });
  afterEach(() => {
    for (const window of Electron.BrowserWindow.getAllWindows()) window.destroy();
    vi.useRealTimers();
  });
  const state = {
    threadId: "thread-1",
    environmentId: "remote-1",
    title: "Fix build",
    state: "working",
    detail: "Reading files",
    attention: false,
  } as const;

  it("starts as one visible taskbar-free pill using the workspace renderer", () => {
    expect(Electron.BrowserWindow.getAllWindows()).toEqual([main]);
    expect(main.isVisible()).toBe(true);
    expect(main.isFocused()).toBe(false);
    expect(main.getBounds()).toEqual({ x: 51, y: 27, width: 1100, height: 780 });
    expect(pill()).toEqual({ x: 100, y: 100, width: 320, height: 70 });
    expectPillShape();
    expect(main.setSkipTaskbar).toHaveBeenCalledWith(true);
    expect(shell()).toMatchObject({ mode: "pill", phase: "settled" });
  });
  it("expands and collapses by shaping one stable canvas without resizing the viewport", () => {
    const initial = main.getBounds();
    const initialPill = pill();
    vi.mocked(main.setBounds).mockClear();
    send(Channels.SATELLITE_PUBLISH, state);
    send(Channels.SATELLITE_PILL_OPEN);
    expect(shell()).toMatchObject({ mode: "workspace", phase: "expanding" });
    const workspace = main.getBounds();
    expect(workspace.width).toBe(1100);
    expect(workspace.height).toBe(780);
    expect(workspace).toEqual(initial);
    expect(pill()).toEqual(initialPill);
    expect(main.setShape).toHaveBeenLastCalledWith([{ x: 0, y: 0, width: 1100, height: 780 }]);
    settle();
    main.close();
    expect(shell().phase).toBe("collapsing");
    expect(main.getBounds()).toEqual(workspace);
    settle();
    expect(main.getBounds()).toEqual(initial);
    expect(pill()).toEqual(initialPill);
    expectPillShape();
    expect(main.setBounds).not.toHaveBeenCalled();
    expect(main.setResizable).toHaveBeenCalledTimes(1);
    expect(main.setResizable).toHaveBeenCalledWith(false);
    expect(main.isDestroyed()).toBe(false);
    expect(main.isVisible()).toBe(true);
    expect(main.hide).not.toHaveBeenCalled();
    expect(Electron.BrowserWindow.getAllWindows()).toEqual([main]);
    expect(main.webContents.send).toHaveBeenCalledWith(Channels.SATELLITE_PILL_STATE, state);
  });
  it("supports desktop reveal paths and renderer-requested collapse", () => {
    expandSatelliteWindow(main);
    settle();
    expect(shell().mode).toBe("workspace");
    collapse();
    expectPillShape();
  });
  it("collapses on blur unless pinned, focused again, or showing a native dialog", () => {
    expand();
    main.blur();
    vi.advanceTimersByTime(150);
    expect(shell().phase).toBe("collapsing");
    settle();
    expand();
    send(Channels.SATELLITE_SET_PINNED, true);
    main.blur();
    vi.advanceTimersByTime(150);
    expect(shell().mode).toBe("workspace");
    send(Channels.SATELLITE_SET_PINNED, false);
    main.blur();
    main.focus();
    vi.advanceTimersByTime(150);
    expect(shell().mode).toBe("workspace");
    vi.mocked(main.isEnabled).mockReturnValue(false);
    main.blur();
    vi.advanceTimersByTime(150);
    expect(shell().mode).toBe("workspace");
  });
  it("minimize collapses instead of leaving an inaccessible minimized window", () => {
    expand();
    main.emit("minimize");
    settle();
    expect(main.restore).toHaveBeenCalledOnce();
    expect(shell().mode).toBe("pill");
  });
  it("ignores stale animation completions when a transition reverses", () => {
    send(Channels.SATELLITE_PILL_OPEN);
    const opening = shell().transitionId;
    send(Channels.SATELLITE_HIDE_MAIN);
    send(Channels.SATELLITE_TRANSITION_FINISHED, opening);
    expect(shell().phase).toBe("collapsing");
    settle();
    expectPillShape();
  });
  it("recovers a missing renderer completion and can reopen afterward", () => {
    expand();
    send(Channels.SATELLITE_HIDE_MAIN);
    vi.advanceTimersByTime(650);
    expect(shell().phase).toBe("collapsing");
    vi.advanceTimersByTime(850);
    expect(shell().phase).toBe("settled");
    expectPillShape();
    expand();
    expect(main.getBounds().width).toBe(1100);
  });
  it("uses the actual rounded native canvas without changing size during a morph or move", () => {
    main.destroy();
    main = new Electron.BrowserWindow({});
    const setBounds = vi.mocked(main.setBounds).getMockImplementation()!;
    vi.mocked(main.setBounds).mockImplementation((bounds) => {
      const requested = { ...main.getBounds(), ...bounds };
      setBounds({
        ...requested,
        x: requested.x + 1,
        width: requested.width + 1,
        height: requested.height + 1,
      });
    });
    installSatellitePill(main, { revealMain: reveal });
    send(Channels.SATELLITE_PILL_READY);
    const canvas = main.getBounds();
    expect(shell().workspaceSize).toEqual({ width: 1101, height: 781 });
    expect(pill()).toEqual({ x: 100, y: 100, width: 320, height: 70 });
    vi.mocked(main.setBounds).mockClear();
    expand();
    collapse();
    expect(main.getBounds()).toEqual(canvas);
    expect(shell().workspaceSize).toEqual({ width: 1101, height: 781 });
    expect(main.setBounds).not.toHaveBeenCalled();
    expect(pill()).toEqual({ x: 100, y: 100, width: 320, height: 70 });
    send(Channels.SATELLITE_PILL_MOVE, "ArrowRight");
    expect(shell().workspaceSize).toEqual({ width: 1101, height: 781 });
    expect(pill()).toEqual({ x: 116, y: 100, width: 320, height: 70 });
    expectPillShape();
    expand();
    collapse();
    expect(NodeFS.writeFileSync).toHaveBeenLastCalledWith(
      expect.any(String),
      '{"x":116,"y":100,"workspaceWidth":1100,"workspaceHeight":780}',
      "utf8",
    );
  });
  it("moves only the settled pill and retains its new anchor", () => {
    send(Channels.SATELLITE_PILL_MOVE, "ArrowRight");
    expect(pill().x).toBe(116);
    expand();
    const workspace = main.getBounds();
    send(Channels.SATELLITE_PILL_MOVE, "ArrowRight");
    expect(main.getBounds()).toEqual(workspace);
    collapse();
    expect(pill().x).toBe(116);
    expectPillShape();
  });
  it("preserves the visible pill location when re-anchoring after a native drag", () => {
    const canvas = main.getBounds();
    main.setBounds({ ...canvas, x: canvas.x + 300, y: canvas.y + 200 });
    expect(pill()).toEqual({ x: 400, y: 300, width: 320, height: 70 });
    main.emit("moved");
    expect(pill()).toEqual({ x: 400, y: 300, width: 320, height: 70 });
    expectPillShape();
    const anchoredCanvas = main.getBounds();
    expect(anchoredCanvas.x).toBeGreaterThanOrEqual(0);
    expect(anchoredCanvas.x + anchoredCanvas.width).toBeLessThanOrEqual(1920);
    expect(anchoredCanvas.y + anchoredCanvas.height).toBeLessThanOrEqual(1040);
    expand();
    collapse();
    expect(main.getBounds()).toEqual(anchoredCanvas);
    expect(pill()).toEqual({ x: 400, y: 300, width: 320, height: 70 });
  });
  it("drags the stable canvas in native DIPs without zoom scaling or intermediate re-anchoring", () => {
    const canvas = main.getBounds();
    const localPill = shell().pillBounds;
    vi.mocked(main.webContents.getZoomFactor).mockReturnValue(2);
    vi.mocked(main.setBounds).mockClear();
    vi.mocked(main.setShape).mockClear();
    vi.mocked(main.webContents.send).mockClear();
    cursorAt(140, 200);
    send(Channels.SATELLITE_PILL_DRAG_BEGIN);
    cursorAt(430, 380);
    send(Channels.SATELLITE_PILL_DRAG_UPDATE);
    expect(main.getBounds()).toEqual({ ...canvas, x: canvas.x + 290, y: canvas.y + 180 });
    cursorAt(600, 420);
    send(Channels.SATELLITE_PILL_DRAG_UPDATE);
    expect(main.getBounds()).toEqual({ ...canvas, x: canvas.x + 460, y: canvas.y + 220 });
    vi.advanceTimersByTime(500);
    expect(NodeFS.writeFileSync).not.toHaveBeenCalled();
    expect(main.setBounds).not.toHaveBeenCalled();
    expect(main.setShape).not.toHaveBeenCalled();
    expect(main.webContents.send).not.toHaveBeenCalled();
    expect(main.webContents.getZoomFactor).not.toHaveBeenCalled();
    send(Channels.SATELLITE_PILL_DRAG_END);
    expect(pill()).toEqual({ x: 560, y: 320, width: 320, height: 70 });
    expect(shell().pillBounds).not.toEqual(localPill);
    expectPillShape();
    expect(NodeFS.writeFileSync).toHaveBeenCalledOnce();
    main.emit("move");
    main.emit("moved");
    vi.advanceTimersByTime(500);
    expect(NodeFS.writeFileSync).toHaveBeenCalledOnce();
  });
  it("applies the final cursor position, clamps the pill, and starts the next drag from its new anchor", () => {
    cursorAt(150, 150);
    send(Channels.SATELLITE_PILL_DRAG_BEGIN);
    cursorAt(600, 400);
    send(Channels.SATELLITE_PILL_DRAG_UPDATE);
    expect(pill()).toEqual({ x: 550, y: 350, width: 320, height: 70 });
    cursorAt(-700, 5000);
    send(Channels.SATELLITE_PILL_DRAG_END);
    expect(pill()).toEqual({ x: 0, y: 970, width: 320, height: 70 });
    expect(main.getBounds()).toEqual({ x: 0, y: 260, width: 1100, height: 780 });
    expect(NodeFS.writeFileSync).toHaveBeenCalledOnce();
    expect(NodeFS.writeFileSync).toHaveBeenLastCalledWith(
      expect.any(String),
      '{"x":0,"y":970,"workspaceWidth":1100,"workspaceHeight":780}',
      "utf8",
    );
    send(Channels.SATELLITE_PILL_DRAG_BEGIN);
    cursorAt(-650, 4975);
    send(Channels.SATELLITE_PILL_DRAG_UPDATE);
    send(Channels.SATELLITE_PILL_DRAG_END);
    expect(pill()).toEqual({ x: 50, y: 945, width: 320, height: 70 });
    const anchored = main.getBounds();
    expand();
    collapse();
    expect(main.getBounds()).toEqual(anchored);
    expect(pill()).toEqual({ x: 50, y: 945, width: 320, height: 70 });
  });
  it("ignores stale drag messages and prevents other renderers from starting or ending a drag", () => {
    const other = new Electron.BrowserWindow({});
    const outside = (channel: string) =>
      Electron.ipcMain.emit(channel, { sender: other.webContents });
    cursorAt(100, 100);
    outside(Channels.SATELLITE_PILL_DRAG_BEGIN);
    cursorAt(200, 200);
    send(Channels.SATELLITE_PILL_DRAG_UPDATE);
    send(Channels.SATELLITE_PILL_DRAG_END);
    expect(main.setPosition).not.toHaveBeenCalled();
    send(Channels.SATELLITE_PILL_DRAG_BEGIN);
    cursorAt(300, 250);
    outside(Channels.SATELLITE_PILL_DRAG_UPDATE);
    outside(Channels.SATELLITE_PILL_DRAG_END);
    expect(main.setPosition).not.toHaveBeenCalled();
    send(Channels.SATELLITE_PILL_DRAG_BEGIN);
    send(Channels.SATELLITE_PILL_MOVE, "ArrowRight");
    send(Channels.SATELLITE_PILL_DRAG_UPDATE);
    expect(pill()).toEqual({ x: 200, y: 150, width: 320, height: 70 });
    send(Channels.SATELLITE_PILL_DRAG_END);
    cursorAt(600, 600);
    send(Channels.SATELLITE_PILL_DRAG_UPDATE);
    send(Channels.SATELLITE_PILL_DRAG_END);
    expect(pill()).toEqual({ x: 200, y: 150, width: 320, height: 70 });
    expect(NodeFS.writeFileSync).toHaveBeenCalledOnce();
    expect(reveal).not.toHaveBeenCalled();
  });
  it.each(["expanding", "workspace", "collapsing"] as const)(
    "rejects drag sessions while %s",
    (phase) => {
      send(Channels.SATELLITE_PILL_OPEN);
      if (phase !== "expanding") settle();
      if (phase === "collapsing") send(Channels.SATELLITE_HIDE_MAIN);
      const bounds = main.getBounds();
      cursorAt(100, 100);
      send(Channels.SATELLITE_PILL_DRAG_BEGIN);
      cursorAt(300, 300);
      send(Channels.SATELLITE_PILL_DRAG_UPDATE);
      send(Channels.SATELLITE_PILL_DRAG_END);
      expect(main.setPosition).not.toHaveBeenCalled();
      expect(main.getBounds()).toEqual(bounds);
    },
  );
  it.each(["blur", "reload", "crash", "close", "display change", "expand"] as const)(
    "ends an active drag on %s and ignores late movement",
    (event) => {
      cursorAt(100, 100);
      send(Channels.SATELLITE_PILL_DRAG_BEGIN);
      cursorAt(350, 220);
      send(Channels.SATELLITE_PILL_DRAG_UPDATE);
      // Cancellation must use the last delivered position, not a pointer that
      // has already moved into another application.
      cursorAt(5000, 5000);
      switch (event) {
        case "blur":
          main.blur();
          break;
        case "reload":
          main.webContents.emit("did-start-loading");
          break;
        case "crash":
          main.webContents.emit("render-process-gone", {}, { reason: "crashed" });
          break;
        case "close":
          main.close();
          break;
        case "display change":
          Electron.screen.emit("display-metrics-changed", {});
          break;
        case "expand":
          expand();
          break;
      }
      const bounds = main.getBounds();
      send(Channels.SATELLITE_PILL_DRAG_UPDATE);
      send(Channels.SATELLITE_PILL_DRAG_END);
      expect(main.getBounds()).toEqual(bounds);
      expect(pill()).toEqual({ x: 350, y: 220, width: 320, height: 70 });
      collapse();
      send(Channels.SATELLITE_PILL_DRAG_BEGIN);
      cursorAt(5040, 5030);
      send(Channels.SATELLITE_PILL_DRAG_END);
      expect(pill()).toEqual({ x: 390, y: 250, width: 320, height: 70 });
    },
  );
  it("remembers workspace movement and size without saving compact workspace dimensions", () => {
    expand();
    main.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    collapse();
    expect(pill()).toEqual({ x: 0, y: 0, width: 320, height: 70 });
    expectPillShape();
    expect(main.getBounds()).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
    expand();
    expect(main.getBounds()).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
    expect(NodeFS.writeFileSync).toHaveBeenLastCalledWith(
      expect.any(String),
      '{"x":0,"y":0,"workspaceWidth":1200,"workspaceHeight":800}',
      "utf8",
    );
  });
  it("fresh heartbeats retain working state, then a stalled renderer becomes unknown", () => {
    send(Channels.SATELLITE_PUBLISH, state);
    vi.advanceTimersByTime(20_000);
    send(Channels.SATELLITE_PUBLISH, state);
    vi.advanceTimersByTime(20_000);
    expect(main.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_PILL_STATE, state);
    vi.advanceTimersByTime(10_000);
    expect(main.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_PILL_STATE, {
      ...state,
      state: "unknown",
      detail: "Status unavailable — reconnecting",
    });
  });
  it("rejects window-control messages from other renderers", () => {
    const other = new Electron.BrowserWindow({});
    for (const [channel, value] of [
      [Channels.SATELLITE_PUBLISH, state],
      [Channels.SATELLITE_PILL_OPEN, undefined],
      [Channels.SATELLITE_SET_PINNED, true],
      [Channels.SATELLITE_PILL_MOVE, "ArrowRight"],
    ] as const)
      Electron.ipcMain.emit(channel, { sender: other.webContents }, value);
    expect(reveal).not.toHaveBeenCalled();
    expect(shell()).toMatchObject({ mode: "pill", pinned: false });
    expect(pill().x).toBe(100);
  });
  it("recovers a crash into the pill and clears stale attention", () => {
    send(Channels.SATELLITE_PUBLISH, state);
    expand();
    main.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(shell()).toMatchObject({ mode: "pill", phase: "settled" });
    expect(main.webContents.send).toHaveBeenCalledWith(Channels.SATELLITE_PILL_STATE, {
      ...state,
      state: "unknown",
      detail: "Status unavailable — reconnecting",
    });
  });
  it("explicit quit saves placement, destroys the window, and removes IPC listeners", () => {
    Electron.app.emit("before-quit", {});
    expect(NodeFS.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("satellite-pill.json"),
      '{"x":100,"y":100,"workspaceWidth":1100,"workspaceHeight":780}',
      "utf8",
    );
    main.close();
    expect(main.isDestroyed()).toBe(true);
    expect(Electron.ipcMain.listenerCount(Channels.SATELLITE_PILL_OPEN)).toBe(0);
    expect(Electron.ipcMain.listenerCount(Channels.SATELLITE_PILL_DRAG_BEGIN)).toBe(0);
    expect(Electron.ipcMain.listenerCount(Channels.SATELLITE_PILL_DRAG_UPDATE)).toBe(0);
    expect(Electron.ipcMain.listenerCount(Channels.SATELLITE_PILL_DRAG_END)).toBe(0);
  });
  it("recovers the shell on display removal even during a transition", () => {
    main.setBounds({ ...main.getBounds(), x: -1000, y: 2000 });
    send(Channels.SATELLITE_PILL_OPEN);
    Electron.screen.emit("display-removed", {});
    expect(shell().phase).toBe("settled");
    const bounds = main.getBounds();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1040);
    collapse();
    expect(pill()).toEqual({ x: 0, y: 970, width: 320, height: 70 });
    expectPillShape();
  });
});
