// @effect-diagnostics nodeBuiltinImport:off -- Native Electron boundary owns desktop placement preferences.
// @effect-diagnostics globalTimers:off -- Electron listeners dispose their blur and health timers.
// @effect-diagnostics globalConsole:off -- Preference and native helper errors are reported at this boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Electron from "electron";
import {
  SatelliteAttentionIntent,
  SatellitePillLayoutRequest,
  SatellitePillState,
  type SatelliteShellState,
} from "@t3tools/contracts";
import * as Channels from "./channels.ts";
import {
  clampPillBounds,
  handleMainClose,
  resolvePillBounds,
  resolvePillLayout,
  resolveWorkspaceBounds,
  unavailablePillState,
} from "./pillModel.ts";
import { loadWindowsPillDrag } from "./WindowsPillDrag.ts";
import { installWindowsDoubleControl } from "./WindowsDoubleControl.ts";

const Position = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  workspaceWidth: Schema.optionalKey(Schema.Finite),
  workspaceHeight: Schema.optionalKey(Schema.Finite),
});
const isPosition = Schema.is(Position);
const isPillState = Schema.is(SatellitePillState);
const decodeAttentionIntent = Schema.decodeUnknownOption(SatelliteAttentionIntent);
const decodeLayoutRequest = Schema.decodeUnknownOption(SatellitePillLayoutRequest);
const isMoveDirection = Schema.is(
  Schema.Literals(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]),
);
const STALE_AFTER_MS = 30_000;
const shells = new WeakMap<Electron.BrowserWindow, { expand: () => boolean }>();

export function isSatelliteWindow(window: Electron.BrowserWindow): boolean {
  return shells.has(window);
}

/** Every desktop reveal path expands the retained workspace. */
export function expandSatelliteWindow(window: Electron.BrowserWindow): boolean {
  return shells.get(window)?.expand() ?? true;
}

/** Own both native surfaces. The pill never borrows the workspace's viewport or geometry. */
export function installSatellitePill(
  main: Electron.BrowserWindow,
  options: {
    readonly revealMain: () => void;
    readonly icon?: string;
    readonly pillUrl: string;
    readonly pillPreloadPath: string;
  },
): void {
  const positionPath = NodePath.join(Electron.app.getPath("userData"), "satellite-pill.json");
  let position: typeof Position.Type | null = null;
  try {
    const saved: unknown = JSON.parse(NodeFS.readFileSync(positionPath, "utf8"));
    if (isPosition(saved)) position = saved;
  } catch {
    /* Missing or damaged preferences use the primary display. */
  }
  const workAreas = () => {
    const primary = Electron.screen.getPrimaryDisplay();
    return [
      primary,
      ...Electron.screen.getAllDisplays().filter((display) => display.id !== primary.id),
    ].map((display) => display.workArea);
  };
  let pillBounds = clampPillBounds(position, workAreas());
  let layoutRequest: SatellitePillLayoutRequest = { mode: "compact", wing: false };
  let pillGeometry = resolvePillLayout(pillBounds, layoutRequest, workAreas());
  let pendingLayout: SatellitePillLayoutRequest | undefined;
  const initial = main.getBounds();
  let workspaceSize = {
    width: Math.max(840, position?.workspaceWidth ?? initial.width),
    height: Math.max(620, position?.workspaceHeight ?? initial.height),
  };
  let shell: SatelliteShellState = { mode: "workspace", pinned: false };
  let snapshot = unavailablePillState();
  let quitting = false;
  let menuOpen = false;
  let mainReady = false;
  let pillReady = false;
  let nativePillMove = false;
  let topologyRecoveryPending = false;
  let workspaceGesture: "idle" | "moving" | "resizing" = "idle";
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  let pillBlurTimer: ReturnType<typeof setTimeout> | undefined;
  let nativeDrag: ((handle: Buffer) => boolean) | undefined;
  let disposeDoubleControl: (() => void) | undefined;
  const pill = new Electron.BrowserWindow({
    ...pillBounds,
    minWidth: 1,
    minHeight: 1,
    show: false,
    frame: false,
    thickFrame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(options.icon ? { icon: options.icon } : {}),
    webPreferences: {
      preload: options.pillPreloadPath,
      partition: "satellite-pill",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // Reusing getBounds() dimensions for placement accumulates enclosing-pixel rounding.
  pill.setMinimumSize(1, 1);
  pill.setMaximumSize(0, 0);
  pill.setBounds(pillBounds);
  pill.setShape(pillGeometry.shape);
  pill.setVisibleOnAllWorkspaces(true);
  pill.webContents.setZoomFactor(1);
  const pillScheme = new URL(options.pillUrl).protocol.slice(0, -1);
  if (pillScheme === "t3code" || pillScheme === "t3code-dev") {
    pill.webContents.session.protocol.handle(pillScheme, (request) =>
      Electron.net.fetch(request.url),
    );
  }
  main.setSkipTaskbar(true);
  main.setAlwaysOnTop(true, "floating");
  main.setVisibleOnAllWorkspaces(true);
  main.setResizable(true);
  const setWorkspaceBounds = (bounds: Electron.Rectangle) => {
    main.setMinimumSize(Math.min(840, bounds.width), Math.min(620, bounds.height));
    main.setBounds(bounds);
  };
  setWorkspaceBounds(resolveWorkspaceBounds(pillBounds, workspaceSize, workAreas()));

  const sendShell = () => {
    if (!main.isDestroyed()) main.webContents.send(Channels.SATELLITE_SHELL_STATE, shell);
  };
  const sendState = () => {
    if (!pill.isDestroyed()) pill.webContents.send(Channels.SATELLITE_PILL_STATE, snapshot);
  };
  const sendLayout = () => {
    if (!pill.isDestroyed())
      pill.webContents.send(Channels.SATELLITE_PILL_LAYOUT, {
        ...pillGeometry.layout,
        ...(layoutRequest.requestId === undefined ? {} : { requestId: layoutRequest.requestId }),
      });
  };
  const applyLayout = (request: SatellitePillLayoutRequest) => {
    if (pill.isDestroyed()) return;
    if (nativePillMove || menuOpen) {
      pendingLayout = request;
      return;
    }
    pendingLayout = undefined;
    const previousMode = pillGeometry.layout.mode;
    layoutRequest = request;
    pillGeometry = resolvePillLayout(pillBounds, request, workAreas());
    pillBounds = {
      ...pillGeometry.layout.pill,
      x: pillGeometry.bounds.x + pillGeometry.layout.pill.x,
      y: pillGeometry.bounds.y + pillGeometry.layout.pill.y,
    };
    pill.setBounds(pillGeometry.bounds);
    pill.setShape(pillGeometry.shape);
    sendLayout();
    if (shell.mode === "pill" && previousMode !== "panel" && pillGeometry.layout.mode === "panel") {
      pill.show();
      pill.focus();
    }
  };
  const schedulePanelCollapse = () => {
    clearTimeout(pillBlurTimer);
    pillBlurTimer = setTimeout(() => {
      if (
        pill.isDestroyed() ||
        shell.mode !== "pill" ||
        pillGeometry.layout.mode !== "panel" ||
        menuOpen ||
        nativePillMove ||
        pill.isFocused() ||
        !pill.isEnabled() ||
        pill.getChildWindows().some((child) => child.isVisible())
      )
        return;
      applyLayout({ ...layoutRequest, mode: "compact" });
    }, 150);
  };
  const savePosition = () => {
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
  const rememberPill = () => {
    if (pill.isDestroyed()) return;
    const actual = pill.getBounds();
    pillBounds = {
      ...pillGeometry.layout.pill,
      x: actual.x + pillGeometry.layout.pill.x,
      y: actual.y + pillGeometry.layout.pill.y,
    };
    savePosition();
  };
  const markUnknown = () => {
    clearTimeout(staleTimer);
    snapshot = unavailablePillState(snapshot);
    sendState();
  };
  const expand = () => {
    if (quitting || main.isDestroyed()) return false;
    if (shell.mode === "workspace") return mainReady;
    clearTimeout(blurTimer);
    clearTimeout(pillBlurTimer);
    rememberPill();
    applyLayout({ ...(pendingLayout ?? layoutRequest), mode: "compact" });
    setWorkspaceBounds(resolveWorkspaceBounds(pillBounds, workspaceSize, workAreas()));
    shell = { ...shell, mode: "workspace" };
    sendShell();
    if (mainReady) {
      main.show();
      main.focus();
      pill.hide();
    }
    return mainReady;
  };
  const collapse = () => {
    if (quitting || main.isDestroyed() || shell.mode === "pill") return;
    clearTimeout(blurTimer);
    pillBounds = resolvePillBounds(main.getBounds(), workAreas(), pillBounds);
    applyLayout({ ...(pendingLayout ?? layoutRequest), mode: "compact" });
    shell = { ...shell, mode: "pill" };
    sendShell();
    if (pillReady) {
      pill.showInactive();
      main.hide();
    }
    savePosition();
  };
  shells.set(main, { expand });
  main.once("ready-to-show", () => {
    if (quitting || main.isDestroyed() || shell.mode !== "workspace") return;
    main.show();
    main.focus();
    pill.hide();
  });
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
  void installWindowsDoubleControl(main, () => {
    if (quitting || main.isDestroyed()) return;
    if (shell.mode === "pill") openMain();
    else if (main.isFocused()) setPinned(!shell.pinned);
  })
    .then((dispose) => {
      if (quitting || main.isDestroyed()) dispose();
      else disposeDoubleControl = dispose;
    })
    .catch((error) => console.warn("SatelliteT3 could not register double-Ctrl", error));
  const mainSender = (event: Electron.IpcMainEvent) => event.sender === main.webContents;
  const pillSender = (event: Electron.IpcMainEvent) => event.sender === pill.webContents;
  const listeners = {
    [Channels.SATELLITE_PUBLISH]: (event: Electron.IpcMainEvent, value: unknown) => {
      if (!mainSender(event) || !isPillState(value)) return;
      snapshot = { ...value, title: value.title.slice(0, 240), detail: value.detail.slice(0, 500) };
      clearTimeout(staleTimer);
      staleTimer = setTimeout(markUnknown, STALE_AFTER_MS);
      sendState();
    },
    [Channels.SATELLITE_HIDE_MAIN]: (event: Electron.IpcMainEvent) => {
      if (mainSender(event)) collapse();
    },
    [Channels.SATELLITE_OPEN_MAIN]: (event: Electron.IpcMainEvent) => {
      if (mainSender(event)) openMain();
    },
    [Channels.SATELLITE_ATTENTION_INTENT]: (event: Electron.IpcMainEvent, value: unknown) => {
      if (!pillSender(event) || !mainReady || main.isDestroyed()) return;
      const intent = decodeAttentionIntent(value);
      if (Option.isSome(intent))
        main.webContents.send(Channels.SATELLITE_ATTENTION_INTENT, intent.value);
    },
    [Channels.SATELLITE_PILL_LAYOUT_REQUEST]: (event: Electron.IpcMainEvent, value: unknown) => {
      if (!pillSender(event)) return;
      const request = decodeLayoutRequest(value);
      if (Option.isNone(request)) return;
      applyLayout(shell.mode === "pill" ? request.value : { ...request.value, mode: "compact" });
    },
    [Channels.SATELLITE_WORKSPACE_READY]: (event: Electron.IpcMainEvent) => {
      if (!mainSender(event)) return;
      mainReady = true;
      sendShell();
      if (shell.mode === "workspace") {
        main.show();
        main.focus();
        pill.hide();
        options.revealMain();
      }
    },
    [Channels.SATELLITE_PILL_READY]: (event: Electron.IpcMainEvent) => {
      if (!pillSender(event)) return;
      pillReady = true;
      sendLayout();
      sendState();
      if (shell.mode === "pill") {
        pill.showInactive();
        main.hide();
      }
    },
    [Channels.SATELLITE_PILL_OPEN]: (event: Electron.IpcMainEvent) => {
      if (pillSender(event)) openMain();
    },
    [Channels.SATELLITE_PILL_MENU]: (event: Electron.IpcMainEvent) => {
      if (!pillSender(event) || nativePillMove) return;
      menuOpen = true;
      clearTimeout(blurTimer);
      clearTimeout(pillBlurTimer);
      menu().popup({
        window: pill,
        callback: () => {
          menuOpen = false;
          if (pendingLayout) applyLayout(pendingLayout);
          if (!pill.isFocused()) schedulePanelCollapse();
        },
      });
    },
    [Channels.SATELLITE_PILL_MOVE]: (event: Electron.IpcMainEvent, direction: unknown) => {
      if (
        !pillSender(event) ||
        !isMoveDirection(direction) ||
        nativePillMove ||
        shell.mode !== "pill"
      )
        return;
      rememberPill();
      pillBounds = clampPillBounds(
        {
          x: pillBounds.x + (direction === "ArrowLeft" ? -16 : direction === "ArrowRight" ? 16 : 0),
          y: pillBounds.y + (direction === "ArrowUp" ? -16 : direction === "ArrowDown" ? 16 : 0),
        },
        workAreas(),
      );
      applyLayout(layoutRequest);
      savePosition();
    },
    [Channels.SATELLITE_PILL_DRAG_BEGIN]: (event: Electron.IpcMainEvent) => {
      if (
        !pillSender(event) ||
        quitting ||
        menuOpen ||
        nativePillMove ||
        shell.mode !== "pill" ||
        pill.isDestroyed()
      )
        return;
      nativeDrag?.(pill.getNativeWindowHandle());
    },
    [Channels.SATELLITE_SET_PINNED]: (event: Electron.IpcMainEvent, pinned: unknown) => {
      if (mainSender(event) && typeof pinned === "boolean") setPinned(pinned);
    },
  };
  for (const [channel, listener] of Object.entries(listeners))
    Electron.ipcMain.on(channel, listener);
  pill.hookWindowMessage(0x0231, () => {
    nativePillMove = true;
  });
  pill.hookWindowMessage(0x0232, () => {
    nativePillMove = false;
    rememberPill();
    if (topologyRecoveryPending) displayChanged();
    else if (pendingLayout || layoutRequest.wing || layoutRequest.mode !== "compact") {
      applyLayout(pendingLayout ?? layoutRequest);
      savePosition();
    }
    if (!pill.isFocused()) schedulePanelCollapse();
  });
  main.hookWindowMessage(0x0231, () => {
    workspaceGesture = "moving";
  });
  main.on("will-resize", () => {
    if (workspaceGesture !== "idle") workspaceGesture = "resizing";
  });
  main.hookWindowMessage(0x0232, () => {
    if (workspaceGesture === "resizing" && !topologyRecoveryPending) {
      const bounds = main.getBounds();
      workspaceSize = { width: bounds.width, height: bounds.height };
      savePosition();
    }
    workspaceGesture = "idle";
    if (topologyRecoveryPending) displayChanged();
  });
  pill.on("moved", () => {
    if (!nativePillMove) rememberPill();
  });
  pill.on("close", (event) => {
    if (!quitting) event.preventDefault();
  });
  pill.on("blur", schedulePanelCollapse);
  pill.on("focus", () => clearTimeout(pillBlurTimer));
  main.on("close", (event) => handleMainClose(event, quitting, collapse));
  main.on("minimize", () => {
    if (!quitting) {
      main.restore();
      collapse();
    }
  });
  main.on("blur", () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (
        main.isDestroyed() ||
        shell.mode !== "workspace" ||
        shell.pinned ||
        menuOpen ||
        main.isFocused() ||
        !main.isEnabled()
      )
        return;
      if (main.getChildWindows().some((child) => child.isVisible())) return;
      collapse();
    }, 150);
  });
  main.on("focus", () => clearTimeout(blurTimer));
  main.webContents.on("did-start-navigation", (event) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    mainReady = false;
    markUnknown();
  });
  main.webContents.on("render-process-gone", () => {
    mainReady = false;
    markUnknown();
    collapse();
  });
  pill.webContents.on("did-start-navigation", (event) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    pillReady = false;
  });
  pill.webContents.on("render-process-gone", () => {
    pillReady = false;
    if (!quitting) pill.webContents.reload();
  });
  const beforeQuit = () => {
    rememberPill();
    quitting = true;
    disposeDoubleControl?.();
    disposeDoubleControl = undefined;
  };
  const displayChanged = () => {
    if (main.isDestroyed() || pill.isDestroyed()) return;
    if (nativePillMove || workspaceGesture !== "idle") {
      topologyRecoveryPending = true;
      return;
    }
    topologyRecoveryPending = false;
    rememberPill();
    pillBounds = clampPillBounds(pillBounds, workAreas());
    applyLayout(pendingLayout ?? layoutRequest);
    if (shell.mode === "workspace")
      setWorkspaceBounds(
        resolveWorkspaceBounds(
          resolvePillBounds(main.getBounds(), workAreas(), pillBounds),
          workspaceSize,
          workAreas(),
        ),
      );
    savePosition();
  };
  const displayMetricsChanged = (
    _event: Electron.Event,
    _display: Electron.Display,
    metrics: string[],
  ) => {
    if (metrics.includes("workArea") || metrics.includes("bounds")) displayChanged();
  };
  Electron.app.on("before-quit", beforeQuit);
  Electron.screen.on("display-added", displayChanged);
  Electron.screen.on("display-removed", displayChanged);
  Electron.screen.on("display-metrics-changed", displayMetricsChanged);
  main.once("closed", () => {
    shells.delete(main);
    quitting = true;
    disposeDoubleControl?.();
    disposeDoubleControl = undefined;
    clearTimeout(staleTimer);
    clearTimeout(blurTimer);
    clearTimeout(pillBlurTimer);
    Electron.app.removeListener("before-quit", beforeQuit);
    Electron.screen.removeListener("display-added", displayChanged);
    Electron.screen.removeListener("display-removed", displayChanged);
    Electron.screen.removeListener("display-metrics-changed", displayMetricsChanged);
    for (const [channel, listener] of Object.entries(listeners))
      Electron.ipcMain.removeListener(channel, listener);
    if (!pill.isDestroyed()) {
      if (pillScheme === "t3code" || pillScheme === "t3code-dev")
        pill.webContents.session.protocol.unhandle(pillScheme);
      rememberPill();
      pill.destroy();
    }
    tray.destroy();
  });
  void loadWindowsPillDrag()
    .then((start) => {
      if (quitting || pill.isDestroyed()) return;
      nativeDrag = start;
      return pill.loadURL(options.pillUrl);
    })
    .catch((error) => {
      console.warn("SatelliteT3 could not prepare native pill", error);
      if (!quitting && !pill.isDestroyed()) void pill.loadURL(options.pillUrl);
    });
}
