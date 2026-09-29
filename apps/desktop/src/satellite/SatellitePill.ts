// @effect-diagnostics nodeBuiltinImport:off -- Native Electron boundary owns a small position file beside desktop preferences.
// @effect-diagnostics globalTimers:off -- Electron event listeners own and dispose these debounce and renderer-health timers.
// @effect-diagnostics globalConsole:off -- Native window load and preference errors are reported at the Electron boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import { SatellitePillState } from "@t3tools/contracts";
import * as Channels from "./channels.ts";
import { clampPillBounds, handleMainClose, unavailablePillState } from "./pillModel.ts";
import { pillDataUrl } from "./pillHtml.ts";

const Position = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
const isPosition = Schema.is(Position);
const isPillState = Schema.is(SatellitePillState);
const isMoveDirection = Schema.is(
  Schema.Literals(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]),
);
const STALE_AFTER_MS = 30_000;
const pillWindows = new WeakSet<Electron.BrowserWindow>();

/** Native companions must not receive the workspace's titlebar theme or menu actions. */
export function isSatellitePillWindow(window: Electron.BrowserWindow): boolean {
  return pillWindows.has(window);
}

/** The only cached state is the renderer's current view; no agent or workflow runs here. */
export function installSatellitePill(
  main: Electron.BrowserWindow,
  options: {
    readonly preloadPath: string;
    readonly revealMain: () => void;
    readonly icon?: string;
  },
): void {
  const positionPath = NodePath.join(Electron.app.getPath("userData"), "satellite-pill.json");
  let position: { x: number; y: number } | null = null;
  try {
    const saved: unknown = JSON.parse(NodeFS.readFileSync(positionPath, "utf8"));
    if (isPosition(saved)) position = saved;
  } catch {
    // A missing or damaged position file falls back to the primary display.
  }
  const workAreas = () => {
    const primary = Electron.screen.getPrimaryDisplay();
    return [
      primary,
      ...Electron.screen.getAllDisplays().filter((display) => display.id !== primary.id),
    ].map((display) => display.workArea);
  };
  const pill = new Electron.BrowserWindow({
    ...clampPillBounds(position, workAreas()),
    title: "SatelliteT3",
    frame: false,
    thickFrame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  pillWindows.add(pill);
  pill.setAlwaysOnTop(true, "floating");
  pill.setVisibleOnAllWorkspaces(true);
  let snapshot = unavailablePillState();
  let quitting = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  const sendState = () => {
    if (!pill.isDestroyed()) pill.webContents.send(Channels.SATELLITE_PILL_STATE, snapshot);
  };
  const markUnknown = () => {
    clearTimeout(staleTimer);
    snapshot = unavailablePillState(snapshot);
    sendState();
  };
  const savePosition = () => {
    clearTimeout(saveTimer);
    if (pill.isDestroyed()) return;
    const { x, y } = pill.getBounds();
    try {
      NodeFS.mkdirSync(NodePath.dirname(positionPath), { recursive: true });
      NodeFS.writeFileSync(positionPath, JSON.stringify({ x, y }), "utf8");
    } catch (error) {
      console.warn("SatelliteT3 could not save pill position", error);
    }
  };
  const clampPosition = () => {
    if (pill.isDestroyed()) return;
    const current = pill.getBounds();
    const clamped = clampPillBounds(current, workAreas());
    if (current.x !== clamped.x || current.y !== clamped.y) pill.setBounds(clamped);
    savePosition();
  };
  const openMain = () => {
    if (main.isDestroyed()) return;
    main.webContents.send(Channels.SATELLITE_NAVIGATE, {
      threadId: snapshot.threadId,
      environmentId: snapshot.environmentId,
    });
    options.revealMain();
  };
  const menu = () =>
    Electron.Menu.buildFromTemplate([
      { label: "Open conversation", click: openMain },
      { label: "Show pill", click: () => pill.showInactive() },
      { label: "Hide workspace", click: () => main.hide() },
      { type: "separator" },
      { label: "Quit SatelliteT3", click: () => Electron.app.quit() },
    ]);
  const trayIcon = options.icon
    ? Electron.nativeImage.createFromPath(options.icon)
    : Electron.nativeImage.createFromBuffer(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      );
  const tray = new Electron.Tray(trayIcon);
  tray.setToolTip("SatelliteT3 — open conversation");
  tray.setContextMenu(menu());
  tray.on("click", openMain);
  const publish = (event: Electron.IpcMainEvent, value: unknown) => {
    if (event.sender !== main.webContents || !isPillState(value)) return;
    snapshot = { ...value, title: value.title.slice(0, 240), detail: value.detail.slice(0, 500) };
    clearTimeout(staleTimer);
    staleTimer = setTimeout(markUnknown, STALE_AFTER_MS);
    sendState();
  };
  const hideMain = (event: Electron.IpcMainEvent) => {
    if (event.sender === main.webContents) main.hide();
  };
  const pillReady = (event: Electron.IpcMainEvent) => {
    if (event.sender === pill.webContents) sendState();
  };
  const pillOpen = (event: Electron.IpcMainEvent) => {
    if (event.sender === pill.webContents) openMain();
  };
  const pillMenu = (event: Electron.IpcMainEvent) => {
    if (event.sender === pill.webContents) menu().popup({ window: pill });
  };
  const pillMove = (event: Electron.IpcMainEvent, direction: unknown) => {
    if (event.sender !== pill.webContents || !isMoveDirection(direction)) return;
    const bounds = pill.getBounds();
    const x = bounds.x + (direction === "ArrowLeft" ? -16 : direction === "ArrowRight" ? 16 : 0);
    const y = bounds.y + (direction === "ArrowUp" ? -16 : direction === "ArrowDown" ? 16 : 0);
    pill.setBounds(clampPillBounds({ x, y }, workAreas()));
    savePosition();
  };
  const beforeQuit = () => {
    quitting = true;
    savePosition();
  };
  Electron.app.on("before-quit", beforeQuit);
  Electron.screen.on("display-added", clampPosition);
  Electron.screen.on("display-removed", clampPosition);
  Electron.screen.on("display-metrics-changed", clampPosition);
  Electron.ipcMain.on(Channels.SATELLITE_PUBLISH, publish);
  Electron.ipcMain.on(Channels.SATELLITE_HIDE_MAIN, hideMain);
  Electron.ipcMain.on(Channels.SATELLITE_PILL_READY, pillReady);
  Electron.ipcMain.on(Channels.SATELLITE_PILL_OPEN, pillOpen);
  Electron.ipcMain.on(Channels.SATELLITE_PILL_MENU, pillMenu);
  Electron.ipcMain.on(Channels.SATELLITE_PILL_MOVE, pillMove);
  main.on("close", (event) => handleMainClose(event, quitting, () => main.hide()));
  main.webContents.on("render-process-gone", markUnknown);
  main.webContents.on("did-start-loading", markUnknown);
  pill.on("close", (event) => handleMainClose(event, quitting, () => pill.hide()));
  pill.on("move", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, 300);
  });
  pill.on("moved", clampPosition);
  pill.once("ready-to-show", () => pill.showInactive());
  main.once("closed", () => {
    savePosition();
    clearTimeout(saveTimer);
    clearTimeout(staleTimer);
    Electron.app.removeListener("before-quit", beforeQuit);
    Electron.screen.removeListener("display-added", clampPosition);
    Electron.screen.removeListener("display-removed", clampPosition);
    Electron.screen.removeListener("display-metrics-changed", clampPosition);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PUBLISH, publish);
    Electron.ipcMain.removeListener(Channels.SATELLITE_HIDE_MAIN, hideMain);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PILL_READY, pillReady);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PILL_OPEN, pillOpen);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PILL_MENU, pillMenu);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PILL_MOVE, pillMove);
    tray.destroy();
    if (!pill.isDestroyed()) pill.destroy();
  });
  void pill.loadURL(pillDataUrl()).catch((error: unknown) => {
    console.error("SatelliteT3 pill failed to load", error);
  });
}
