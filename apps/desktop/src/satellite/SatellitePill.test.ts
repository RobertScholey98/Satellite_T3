// @effect-diagnostics nodeBuiltinImport:off -- Native boundary tests use EventEmitter to exercise Electron lifecycle events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Electron from "electron";
import * as NodeFS from "node:fs";
import { installSatellitePill } from "./SatellitePill.ts";
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
    static getAllWindows = () => windows;
    bounds = { x: 100, y: 100, width: 320, height: 70 };
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
    hide = vi.fn();
    showInactive = vi.fn();
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    loadURL = vi.fn(async () => undefined);
    constructor(options: Electron.BrowserWindowConstructorOptions) {
      super();
      this.bounds = { ...this.bounds, ...options };
      windows.push(this);
    }
    isDestroyed = () => this.destroyed;
    getBounds = () => this.bounds;
    setBounds = (bounds: Electron.Rectangle) => {
      this.bounds = bounds;
    };
    destroy = () => {
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

describe("native Satellite pill", () => {
  let main: Electron.BrowserWindow;
  let pill: Electron.BrowserWindow;
  let reveal = vi.fn<() => void>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    main = new Electron.BrowserWindow({});
    reveal = vi.fn();
    installSatellitePill(main, { preloadPath: "/isolated/pill.cjs", revealMain: reveal });
    pill = Electron.BrowserWindow.getAllWindows().at(-1)!;
  });
  afterEach(() => {
    main.destroy();
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
  const publish = () =>
    Electron.ipcMain.emit(Channels.SATELLITE_PUBLISH, { sender: main.webContents }, state);

  it("keeps the main renderer alive on close and reveals the selected remote conversation", () => {
    publish();
    main.close();
    expect(main.hide).toHaveBeenCalledOnce();
    expect(main.isDestroyed()).toBe(false);
    Electron.ipcMain.emit(Channels.SATELLITE_PILL_OPEN, { sender: pill.webContents });
    expect(reveal).toHaveBeenCalledOnce();
    expect(main.webContents.send).toHaveBeenCalledWith(Channels.SATELLITE_NAVIGATE, {
      threadId: "thread-1",
      environmentId: "remote-1",
    });
  });
  it("fresh heartbeats retain working state, then a stalled renderer becomes unknown", () => {
    publish();
    vi.advanceTimersByTime(20_000);
    publish();
    vi.advanceTimersByTime(20_000);
    expect(pill.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_PILL_STATE, state);
    vi.advanceTimersByTime(10_000);
    expect(pill.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_PILL_STATE, {
      ...state,
      state: "unknown",
      detail: "Status unavailable — reconnecting",
    });
  });
  it("rejects publication and navigation from other windows", () => {
    Electron.ipcMain.emit(Channels.SATELLITE_PUBLISH, { sender: pill.webContents }, state);
    Electron.ipcMain.emit(Channels.SATELLITE_PILL_OPEN, { sender: main.webContents });
    expect(pill.webContents.send).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });
  it("a renderer crash clears working and attention immediately", () => {
    publish();
    main.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(pill.webContents.send).toHaveBeenLastCalledWith(Channels.SATELLITE_PILL_STATE, {
      ...state,
      state: "unknown",
      detail: "Status unavailable — reconnecting",
    });
  });
  it("explicit quit saves placement and permits native destruction", () => {
    Electron.app.emit("before-quit", {});
    expect(NodeFS.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("satellite-pill.json"),
      '{"x":100,"y":100}',
      "utf8",
    );
    main.close();
    expect(main.isDestroyed()).toBe(true);
    expect(pill.isDestroyed()).toBe(true);
  });
  it("clamps an offscreen pill when its display is removed", () => {
    pill.setBounds({ x: -1000, y: 2000, width: 320, height: 70 });
    Electron.screen.emit("display-removed", {});
    expect(pill.getBounds()).toEqual({ x: 0, y: 970, width: 320, height: 70 });
  });
});
