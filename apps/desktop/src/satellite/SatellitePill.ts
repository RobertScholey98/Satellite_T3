// @effect-diagnostics nodeBuiltinImport:off -- Native Electron boundary owns a small position file beside desktop preferences.
// @effect-diagnostics globalTimers:off -- Electron listeners dispose their motion, blur, position, and health timers.
// @effect-diagnostics globalConsole:off -- Preference errors are reported at the Electron boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import { SatellitePillState, type SatelliteShellState } from "@t3tools/contracts";
import * as Channels from "./channels.ts";
import {
  clampPillBounds,
  handleMainClose,
  resolvePillBounds,
  resolveWorkspaceBounds,
  unavailablePillState,
} from "./pillModel.ts";

const Position = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  workspaceWidth: Schema.optionalKey(Schema.Finite),
  workspaceHeight: Schema.optionalKey(Schema.Finite),
});
const isPosition = Schema.is(Position);
const isPillState = Schema.is(SatellitePillState);
const isMoveDirection = Schema.is(
  Schema.Literals(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]),
);
const STALE_AFTER_MS = 30_000;
// Leave rendering/IPC headroom beyond the 500ms morph; this only recovers a
// missing completion after a renderer reload or stall.
const TRANSITION_FALLBACK_MS = 1_500;
const shells = new WeakMap<Electron.BrowserWindow, { expand: () => void }>();

export function isSatelliteWindow(window: Electron.BrowserWindow): boolean {
  return shells.has(window);
}

/** All desktop reveal paths, including shortcuts and capture, expand the same surface. */
export function expandSatelliteWindow(window: Electron.BrowserWindow): void {
  shells.get(window)?.expand();
}

/** The workspace stays mounted in this window while the renderer displays its pill. */
export function installSatellitePill(
  main: Electron.BrowserWindow,
  options: { readonly revealMain: () => void; readonly icon?: string },
): void {
  const positionPath = NodePath.join(Electron.app.getPath("userData"), "satellite-pill.json");
  let position: typeof Position.Type | null = null;
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
  let pillBounds = clampPillBounds(position, workAreas());
  const initialBounds = main.getBounds();
  let workspaceSize = {
    width: Math.max(840, position?.workspaceWidth ?? initialBounds.width),
    height: Math.max(620, position?.workspaceHeight ?? initialBounds.height),
  };
  const initialCanvas = resolveWorkspaceBounds(pillBounds, workspaceSize, workAreas());
  const relativePill = (canvas: Electron.Rectangle) => ({
    ...pillBounds,
    x: pillBounds.x - canvas.x,
    y: pillBounds.y - canvas.y,
  });
  let shell: SatelliteShellState = {
    mode: "pill",
    phase: "settled",
    transitionId: 0,
    pillBounds: relativePill(initialCanvas),
    workspaceSize: { width: initialCanvas.width, height: initialCanvas.height },
    pinned: false,
  };
  let snapshot = unavailablePillState();
  let quitting = false;
  let menuOpen = false;
  let changingBounds = false;
  let placementNeedsReconcile = false;
  let pillDrag: { cursor: Electron.Point; origin: Electron.Point } | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let transitionTimer: ReturnType<typeof setTimeout> | undefined;
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  const sendShell = () => {
    if (!main.isDestroyed()) main.webContents.send(Channels.SATELLITE_SHELL_STATE, shell);
  };
  const sendState = () => {
    if (!main.isDestroyed()) main.webContents.send(Channels.SATELLITE_PILL_STATE, snapshot);
  };
  const markUnknown = () => {
    clearTimeout(staleTimer);
    snapshot = unavailablePillState(snapshot);
    sendState();
  };
  const savePosition = () => {
    clearTimeout(saveTimer);
    try {
      NodeFS.mkdirSync(NodePath.dirname(positionPath), { recursive: true });
      NodeFS.writeFileSync(
        positionPath,
        JSON.stringify({
          x: pillBounds.x,
          y: pillBounds.y,
          workspaceWidth: workspaceSize.width,
          workspaceHeight: workspaceSize.height,
        }),
        "utf8",
      );
    } catch (error) {
      console.warn("SatelliteT3 could not save pill position", error);
    }
  };
  const setBounds = (bounds: Electron.Rectangle) => {
    const current = main.getBounds();
    if (
      current.x === bounds.x &&
      current.y === bounds.y &&
      current.width === bounds.width &&
      current.height === bounds.height
    )
      return;
    changingBounds = true;
    main.setBounds(bounds);
    changingBounds = false;
  };
  const applyShape = () => {
    // The WebView keeps one viewport in both modes. Native shaping clips unused
    // pixels and lets clicks fall through the otherwise transparent canvas.
    main.setShape([
      shell.mode === "pill" && shell.phase === "settled"
        ? shell.pillBounds
        : { x: 0, y: 0, ...shell.workspaceSize },
    ]);
  };
  const rememberPlacement = () => {
    if (main.isDestroyed() || changingBounds || pillDrag || shell.phase !== "settled") return;
    const bounds = main.getBounds();
    const resized =
      bounds.width !== shell.workspaceSize.width || bounds.height !== shell.workspaceSize.height;
    if (
      !resized &&
      bounds.x + shell.pillBounds.x === pillBounds.x &&
      bounds.y + shell.pillBounds.y === pillBounds.y
    )
      return;
    placementNeedsReconcile = true;
    if (shell.mode === "pill") {
      // Native dragging moves the canvas, while its visible pill keeps the same
      // local offset. Re-anchor the canvas only once the drag has completed.
      pillBounds = {
        ...pillBounds,
        x: bounds.x + shell.pillBounds.x,
        y: bounds.y + shell.pillBounds.y,
      };
    } else {
      // A native move must not turn DPI rounding into a new preferred size.
      if (resized) workspaceSize = { width: bounds.width, height: bounds.height };
      pillBounds = resolvePillBounds(bounds, workAreas(), pillBounds);
      shell = {
        ...shell,
        pillBounds: relativePill(bounds),
        workspaceSize: { width: bounds.width, height: bounds.height },
      };
      applyShape();
      sendShell();
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, 300);
  };
  const reconcilePlacement = () => {
    pillBounds = clampPillBounds(pillBounds, workAreas());
    const canvas = resolveWorkspaceBounds(pillBounds, workspaceSize, workAreas());
    setBounds(canvas);
    const actualCanvas = main.getBounds();
    shell = {
      ...shell,
      pillBounds: relativePill(actualCanvas),
      workspaceSize: { width: actualCanvas.width, height: actualCanvas.height },
    };
    placementNeedsReconcile = false;
    applyShape();
    sendShell();
    savePosition();
  };
  const updatePillDragPosition = () => {
    if (!pillDrag || main.isDestroyed()) return;
    // Cursor and window coordinates are both native DIPs, independent of the
    // renderer's zoom and the scale factor of the display under the pointer.
    const cursor = Electron.screen.getCursorScreenPoint();
    const x = pillDrag.origin.x + cursor.x - pillDrag.cursor.x;
    const y = pillDrag.origin.y + cursor.y - pillDrag.cursor.y;
    const current = main.getBounds();
    if (current.x === x && current.y === y) return;
    main.setPosition(x, y);
    const actual = main.getBounds();
    pillBounds = {
      ...pillBounds,
      x: actual.x + shell.pillBounds.x,
      y: actual.y + shell.pillBounds.y,
    };
  };
  const finishPillDrag = (applyFinalPoint: boolean) => {
    if (!pillDrag) return;
    if (applyFinalPoint) updatePillDragPosition();
    pillDrag = undefined;
    if (!main.isDestroyed()) reconcilePlacement();
  };
  const finishTransition = (transitionId: number) => {
    if (main.isDestroyed() || transitionId !== shell.transitionId || shell.phase === "settled")
      return;
    clearTimeout(transitionTimer);
    shell = { ...shell, phase: "settled" };
    applyShape();
    if (shell.mode === "pill" && main.isFocused()) main.blur();
    sendShell();
    savePosition();
  };
  const startTransition = (mode: "pill" | "workspace") => {
    finishPillDrag(false);
    if (main.isDestroyed() || quitting || shell.mode === mode) return;
    clearTimeout(blurTimer);
    clearTimeout(transitionTimer);
    rememberPlacement();
    shell = {
      ...shell,
      mode,
      phase: mode === "workspace" ? "expanding" : "collapsing",
      transitionId: shell.transitionId + 1,
    };
    applyShape();
    sendShell();
    const transitionId = shell.transitionId;
    transitionTimer = setTimeout(() => finishTransition(transitionId), TRANSITION_FALLBACK_MS);
  };
  const collapse = () => startTransition("pill");
  shells.set(main, { expand: () => startTransition("workspace") });
  main.setSkipTaskbar(true);
  main.setAlwaysOnTop(true, "floating");
  main.setVisibleOnAllWorkspaces(true);
  main.setMinimumSize(0, 0);
  main.setResizable(false);
  setBounds(initialCanvas);
  const actualCanvas = main.getBounds();
  shell = {
    ...shell,
    pillBounds: relativePill(actualCanvas),
    workspaceSize: { width: actualCanvas.width, height: actualCanvas.height },
  };
  applyShape();

  const openMain = () => {
    if (!main.isDestroyed()) options.revealMain();
  };
  const setPinned = (pinned: boolean) => {
    shell = { ...shell, pinned };
    if (pinned) clearTimeout(blurTimer);
    sendShell();
    tray.setContextMenu(menu());
  };
  const menu = () =>
    Electron.Menu.buildFromTemplate([
      { label: "Open workspace", click: openMain },
      { label: "Collapse to pill", click: collapse },
      {
        label: "Keep workspace open",
        type: "checkbox",
        checked: shell.pinned ?? false,
        click: (item) => setPinned(item.checked),
      },
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
  tray.setToolTip("SatelliteT3 — open workspace");
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
    if (event.sender === main.webContents) collapse();
  };
  const pillReady = (event: Electron.IpcMainEvent) => {
    if (event.sender !== main.webContents) return;
    sendState();
    sendShell();
    if (!main.isVisible()) main.showInactive();
  };
  const pillOpen = (event: Electron.IpcMainEvent) => {
    if (event.sender === main.webContents) openMain();
  };
  const pillMenu = (event: Electron.IpcMainEvent) => {
    if (event.sender !== main.webContents) return;
    finishPillDrag(false);
    menuOpen = true;
    clearTimeout(blurTimer);
    menu().popup({
      window: main,
      callback: () => {
        menuOpen = false;
      },
    });
  };
  const pillMove = (event: Electron.IpcMainEvent, direction: unknown) => {
    if (
      event.sender !== main.webContents ||
      !isMoveDirection(direction) ||
      pillDrag ||
      shell.mode !== "pill" ||
      shell.phase !== "settled"
    )
      return;
    const x =
      pillBounds.x + (direction === "ArrowLeft" ? -16 : direction === "ArrowRight" ? 16 : 0);
    const y = pillBounds.y + (direction === "ArrowUp" ? -16 : direction === "ArrowDown" ? 16 : 0);
    pillBounds = clampPillBounds({ x, y }, workAreas());
    reconcilePlacement();
  };
  const pillDragBegin = (event: Electron.IpcMainEvent) => {
    if (
      event.sender !== main.webContents ||
      main.isDestroyed() ||
      quitting ||
      menuOpen ||
      pillDrag ||
      shell.mode !== "pill" ||
      shell.phase !== "settled"
    )
      return;
    clearTimeout(saveTimer);
    clearTimeout(blurTimer);
    pillDrag = { cursor: Electron.screen.getCursorScreenPoint(), origin: main.getBounds() };
  };
  const pillDragUpdate = (event: Electron.IpcMainEvent) => {
    if (event.sender === main.webContents) updatePillDragPosition();
  };
  const pillDragEnd = (event: Electron.IpcMainEvent) => {
    if (event.sender === main.webContents) finishPillDrag(true);
  };
  const transitionFinished = (event: Electron.IpcMainEvent, transitionId: unknown) => {
    if (event.sender === main.webContents && typeof transitionId === "number")
      finishTransition(transitionId);
  };
  const pin = (event: Electron.IpcMainEvent, pinned: unknown) => {
    if (event.sender === main.webContents && typeof pinned === "boolean") setPinned(pinned);
  };
  const beforeQuit = () => {
    finishPillDrag(false);
    rememberPlacement();
    quitting = true;
    savePosition();
  };
  const displayChanged = () => {
    if (main.isDestroyed()) return;
    pillDrag = undefined;
    clearTimeout(transitionTimer);
    shell = {
      ...shell,
      phase: "settled",
      transitionId: shell.transitionId + 1,
    };
    reconcilePlacement();
  };
  Electron.app.on("before-quit", beforeQuit);
  Electron.screen.on("display-added", displayChanged);
  Electron.screen.on("display-removed", displayChanged);
  Electron.screen.on("display-metrics-changed", displayChanged);
  Electron.ipcMain.on(Channels.SATELLITE_PUBLISH, publish);
  Electron.ipcMain.on(Channels.SATELLITE_HIDE_MAIN, hideMain);
  Electron.ipcMain.on(Channels.SATELLITE_PILL_READY, pillReady);
  Electron.ipcMain.on(Channels.SATELLITE_PILL_OPEN, pillOpen);
  Electron.ipcMain.on(Channels.SATELLITE_PILL_MENU, pillMenu);
  Electron.ipcMain.on(Channels.SATELLITE_PILL_MOVE, pillMove);
  Electron.ipcMain.on(Channels.SATELLITE_PILL_DRAG_BEGIN, pillDragBegin);
  Electron.ipcMain.on(Channels.SATELLITE_PILL_DRAG_UPDATE, pillDragUpdate);
  Electron.ipcMain.on(Channels.SATELLITE_PILL_DRAG_END, pillDragEnd);
  Electron.ipcMain.on(Channels.SATELLITE_TRANSITION_FINISHED, transitionFinished);
  Electron.ipcMain.on(Channels.SATELLITE_SET_PINNED, pin);
  main.on("close", (event) => handleMainClose(event, quitting, collapse));
  main.on("minimize", () => {
    if (quitting) return;
    main.restore();
    collapse();
  });
  main.on("blur", () => {
    finishPillDrag(false);
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (main.isDestroyed() || shell.pinned || menuOpen || main.isFocused() || !main.isEnabled())
        return;
      if (main.getChildWindows().some((child) => child.isVisible())) return;
      collapse();
    }, 150);
  });
  main.on("focus", () => clearTimeout(blurTimer));
  main.on("move", rememberPlacement);
  main.on("resize", rememberPlacement);
  main.on("moved", () => {
    if (changingBounds || pillDrag) return;
    rememberPlacement();
    if (placementNeedsReconcile && shell.phase === "settled") reconcilePlacement();
  });
  main.webContents.on("render-process-gone", () => {
    markUnknown();
    collapse();
    finishTransition(shell.transitionId);
  });
  main.webContents.on("did-start-loading", () => {
    finishPillDrag(false);
    markUnknown();
  });
  main.once("closed", () => {
    if (pillDrag) pillBounds = clampPillBounds(pillBounds, workAreas());
    pillDrag = undefined;
    savePosition();
    shells.delete(main);
    clearTimeout(saveTimer);
    clearTimeout(staleTimer);
    clearTimeout(transitionTimer);
    clearTimeout(blurTimer);
    Electron.app.removeListener("before-quit", beforeQuit);
    Electron.screen.removeListener("display-added", displayChanged);
    Electron.screen.removeListener("display-removed", displayChanged);
    Electron.screen.removeListener("display-metrics-changed", displayChanged);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PUBLISH, publish);
    Electron.ipcMain.removeListener(Channels.SATELLITE_HIDE_MAIN, hideMain);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PILL_READY, pillReady);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PILL_OPEN, pillOpen);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PILL_MENU, pillMenu);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PILL_MOVE, pillMove);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PILL_DRAG_BEGIN, pillDragBegin);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PILL_DRAG_UPDATE, pillDragUpdate);
    Electron.ipcMain.removeListener(Channels.SATELLITE_PILL_DRAG_END, pillDragEnd);
    Electron.ipcMain.removeListener(Channels.SATELLITE_TRANSITION_FINISHED, transitionFinished);
    Electron.ipcMain.removeListener(Channels.SATELLITE_SET_PINNED, pin);
    tray.destroy();
  });
}
