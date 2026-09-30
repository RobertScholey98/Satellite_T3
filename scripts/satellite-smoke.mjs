import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// Native integration fixtures only. This script never creates a provider turn.
const repoRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const desktopRoot = NodePath.join(repoRoot, "apps", "desktop");
const requireDesktop = NodeModule.createRequire(NodePath.join(desktopRoot, "package.json"));
const verificationRoot = NodePath.join(repoRoot, ".t3", "verification");
const nativeHome = NodePath.join(verificationRoot, "native-smoke");
const profileRoot = NodePath.join(verificationRoot, "profile");
const artifactsRoot = NodePath.join(nativeHome, "artifacts");
const keepRunning = process.argv.includes("--keep-running");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--keep-running");
NodeAssert.deepEqual(unknownArgs, [], "Only --keep-running is supported");

let currentStage = "Checking build prerequisites";
function stage(label) {
  currentStage = label;
  console.log(`[satellite-smoke] ${label}`);
}

const executablePath = requireDesktop("electron");
const { _electron } = requireDesktop("playwright-core");
const mainEntry = NodePath.join(desktopRoot, "dist-electron", "boot.cjs");
for (const requiredPath of [
  executablePath,
  mainEntry,
  NodePath.join(desktopRoot, "dist-electron", "preload.cjs"),
  NodePath.join(repoRoot, "apps", "server", "dist", "bin.mjs"),
  NodePath.join(repoRoot, "apps", "server", "dist", "client", "index.html"),
]) {
  await NodeFSP.access(requiredPath).catch(() => {
    throw new Error(`Build prerequisite missing: ${requiredPath}`);
  });
}
await NodeFSP.mkdir(artifactsRoot, { recursive: true });
await NodeFSP.mkdir(profileRoot, { recursive: true });

const launchEnv = {
  ...process.env,
  T3CODE_HOME: nativeHome,
  APPDATA: profileRoot,
  XDG_CONFIG_HOME: profileRoot,
  T3CODE_SATELLITE_PILL: "1",
  T3CODE_DISABLE_AUTO_UPDATE: "1",
  T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED: "1",
};
for (const inherited of [
  "VITE_DEV_SERVER_URL",
  "VITE_HTTP_URL",
  "VITE_WS_URL",
  "ELECTRON_RUN_AS_NODE",
  "T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT",
  "T3CODE_PORT",
  "T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH",
  "T3_SERVICE_LAUNCHER_CONTEXT",
  "T3_BOOT_SERVICE_UNIT",
]) {
  delete launchEnv[inherited];
}

async function traceWindows(application) {
  await application.evaluate(({ app, BrowserWindow, ipcMain }) => {
    globalThis.satelliteSmokeEvents = [];
    const track = (_, w) => {
      for (const event of ["show", "hide", "focus", "blur", "minimize"])
        w.on(event, () =>
          globalThis.satelliteSmokeEvents.push({ id: w.id, event, time: Date.now() }),
        );
      for (const event of ["did-start-loading", "did-stop-loading", "did-finish-load"])
        w.webContents.on(event, () =>
          globalThis.satelliteSmokeEvents.push({ id: w.id, event, time: Date.now() }),
        );
      w.webContents.on("did-start-navigation", (_, url, inPlace, mainFrame) =>
        globalThis.satelliteSmokeEvents.push({
          id: w.id,
          event: "navigation",
          inPlace,
          mainFrame,
          time: Date.now(),
        }),
      );
    };
    app.on("browser-window-created", track);
    for (const w of BrowserWindow.getAllWindows()) track(null, w);
    for (const channel of [
      "satellite:workspace-ready",
      "satellite:pill-ready",
      "satellite:pill-open",
    ])
      ipcMain.on(channel, (event) =>
        globalThis.satelliteSmokeEvents.push({
          sender: event.sender.id,
          event: channel,
          time: Date.now(),
        }),
      );
  });
}

async function launch() {
  return _electron.launch({
    executablePath,
    args: [mainEntry],
    cwd: desktopRoot,
    env: launchEnv,
    recordVideo: { dir: artifactsRoot, size: { width: 1200, height: 900 } },
    timeout: 90_000,
  });
}

async function findSurfaces(application) {
  const ids = await application.evaluate(
    ({ app, BrowserWindow }) =>
      new Promise((resolve, reject) => {
        const observed = new Set();
        const inspect = () => {
          const windows = BrowserWindow.getAllWindows();
          const pill = windows.find((w) => w.webContents.getURL().includes("/satellite-pill.html"));
          const main = windows.find(
            (w) => w !== pill && w.webContents.getURL().startsWith("t3code://"),
          );
          if (!pill || !main) return;
          cleanup();
          resolve({ pill: pill.id, main: main.id });
        };
        const observe = (_, window) => {
          observed.add(window);
          window.webContents.on("did-finish-load", inspect);
          inspect();
        };
        const cleanup = () => {
          clearTimeout(timeout);
          app.off("browser-window-created", observe);
          for (const w of observed) w.webContents.off("did-finish-load", inspect);
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Satellite surfaces did not load"));
        }, 60000);
        app.on("browser-window-created", observe);
        for (const w of BrowserWindow.getAllWindows()) observe(undefined, w);
      }),
  );
  const pages = new Map();
  for (const page of application.windows()) {
    const handle = await application.browserWindow(page);
    pages.set(await handle.evaluate((w) => w.id), page);
    await handle.dispose();
  }
  const surfaces = {
    main: { id: ids.main, page: pages.get(ids.main) },
    pill: { id: ids.pill, page: pages.get(ids.pill) },
  };
  await surfaces.pill.page.locator('[data-satellite="pill-content"]').waitFor();
  await surfaces.main.page.locator('[data-satellite="workspace"]').waitFor({ state: "attached" });
  return surfaces;
}

async function snapshot(application, id) {
  return application.evaluate(
    ({ app, BrowserWindow, screen }, { id, desktopRoot }) => {
      if (!globalThis.satelliteSmokeNative) {
        const req = process
          .getBuiltinModule("node:module")
          .createRequire(desktopRoot + "/package.json");
        const ffi = req("ffi-rs");
        ffi.open({ library: "satellite-smoke-user32", path: "user32.dll" });
        globalThis.satelliteSmokeNative = ffi;
      }
      const { DataType, load } = globalThis.satelliteSmokeNative;
      const window = BrowserWindow.fromId(id);
      const hwnd = window.getNativeWindowHandle().readBigUInt64LE();
      const rect = Buffer.alloc(16);
      load({
        library: "satellite-smoke-user32",
        funcName: "GetWindowRect",
        retType: DataType.Boolean,
        paramsType: [DataType.BigInt, DataType.U8Array],
        paramsValue: [hwnd, rect],
      });
      const dpi = load({
        library: "satellite-smoke-user32",
        funcName: "GetDpiForWindow",
        retType: DataType.U32,
        paramsType: [DataType.BigInt],
        paramsValue: [hwnd],
      });
      return {
        id,
        hwnd: hwnd.toString(),
        visible: window.isVisible(),
        focused: window.isFocused(),
        bounds: window.getBounds(),
        physical: {
          x: rect.readInt32LE(0),
          y: rect.readInt32LE(4),
          width: rect.readInt32LE(8) - rect.readInt32LE(0),
          height: rect.readInt32LE(12) - rect.readInt32LE(4),
        },
        dpi,
        zoom: window.webContents.getZoomFactor(),
        preferences: window.webContents.getLastWebPreferences(),
        display: screen.getDisplayMatching(window.getBounds()).id,
        userData: app.getPath("userData"),
        windows: BrowserWindow.getAllWindows().map((w) => w.id),
      };
    },
    { id, desktopRoot },
  );
}

async function waitMode(surfaces, mode) {
  await surfaces.main.page.waitForFunction(
    (mode) => document.querySelector('[data-satellite="shell"]')?.dataset.mode === mode,
    mode,
  );
}

async function expand(application, surfaces) {
  const native = await snapshot(application, surfaces.pill.id);
  const box = await surfaces.pill.page
    .getByRole("button", { name: "Expand SatelliteT3", exact: true })
    .boundingBox();
  const x = Math.round(native.physical.x + ((box.x + box.width / 2) * native.dpi) / 96);
  const y = Math.round(native.physical.y + ((box.y + box.height / 2) * native.dpi) / 96);
  await NodeUtil.promisify(NodeChildProcess.execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      NodePath.join(repoRoot, "scripts", "satellite-drag-gesture.ps1"),
      "-OwnedHwnd",
      native.hwnd,
      "-StartX",
      String(x),
      "-StartY",
      String(y),
      "-EndX",
      String(x),
      "-EndY",
      String(y),
    ],
    { windowsHide: true, timeout: 30000 },
  );
  await waitMode(surfaces, "workspace");
  NodeAssert.equal((await snapshot(application, surfaces.main.id)).visible, true);
  NodeAssert.equal((await snapshot(application, surfaces.pill.id)).visible, false);
}

async function collapse(application, surfaces) {
  await surfaces.main.page.evaluate(() => window.satelliteBridge.hideMain());
  await waitMode(surfaces, "pill");
  NodeAssert.equal((await snapshot(application, surfaces.pill.id)).visible, true);
  NodeAssert.equal((await snapshot(application, surfaces.main.id)).visible, false);
}

async function nativeGesture(application, surface, start, end, options = {}) {
  const before = await snapshot(application, surface.id);
  const receipt = await application.evaluateHandle(
    ({ BrowserWindow, ipcMain }, { id, stallRenderer }) => {
      const window = BrowserWindow.fromId(id);
      const trace = [];
      const observe = () => trace.push(window.getBounds());
      window.on("move", observe);
      window.on("resize", observe);
      let finish;
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      const completed = () => finish(window.getBounds());
      window.on("moved", completed);
      window.on("resized", completed);
      const stall = (event) => {
        if (!stallRenderer || event.sender !== window.webContents) return;
        void window.webContents.executeJavaScript(
          "const until=performance.now()+700;while(performance.now()<until){}",
        );
      };
      ipcMain.on("satellite:pill-drag-begin", stall);
      const timeout = setTimeout(() => finish(null), 10000);
      return {
        done,
        trace,
        dispose: () => {
          clearTimeout(timeout);
          window.off("moved", completed);
          window.off("resized", completed);
          window.off("move", observe);
          window.off("resize", observe);
          ipcMain.off("satellite:pill-drag-begin", stall);
        },
      };
    },
    { id: surface.id, stallRenderer: options.stallRenderer },
  );
  const gesture = NodeUtil.promisify(NodeChildProcess.execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      NodePath.join(repoRoot, "scripts/satellite-drag-gesture.ps1"),
      "-OwnedHwnd",
      before.hwnd,
      "-StartX",
      String(Math.round(start.x)),
      "-StartY",
      String(Math.round(start.y)),
      "-EndX",
      String(Math.round(end.x)),
      "-EndY",
      String(Math.round(end.y)),
      "-Steps",
      String(options.steps ?? 20),
      "-StepDelayMs",
      String(options.delay ?? 12),
      "-WaitForReleaseAcknowledgement",
    ],
    { windowsHide: true, timeout: 30000 },
  );
  let atRelease;
  const released = new Promise((resolve, reject) =>
    gesture.child.stdout.once("data", async () => {
      try {
        atRelease = await snapshot(application, surface.id);
        gesture.child.stdin.end("\n");
        resolve();
      } catch (error) {
        reject(error);
      }
    }),
  );
  try {
    const [{ stdout }] = await Promise.all([gesture, released]);
    const completed = await receipt.evaluate((r) => r.done);
    NodeAssert.ok(completed, "A native move or resize must complete");
    const after = await snapshot(application, surface.id);
    NodeAssert.deepEqual(
      after.physical,
      atRelease.physical,
      "Restoring the cursor after release must not move or resize the window",
    );
    return {
      before,
      after,
      held: JSON.parse(stdout).samples,
      trace: await receipt.evaluate((r) => r.trace),
    };
  } finally {
    await receipt.evaluate((r) => r.dispose());
    await receipt.dispose();
  }
}

async function dragPill(application, surfaces, target, options = {}) {
  const pill = surfaces.pill;
  await pill.page.bringToFront();
  const before = await snapshot(application, pill.id);
  const box = await pill.page.locator(`[data-satellite="${target}"]`).boundingBox();
  const start = {
    x: before.physical.x + ((box.x + (target === "pill" ? 4 : box.width / 2)) * before.dpi) / 96,
    y: before.physical.y + ((box.y + box.height / 2) * before.dpi) / 96,
  };
  const end = options.end ?? { x: start.x - 120, y: start.y - 45 };
  const result = await nativeGesture(application, pill, start, end, options);
  NodeAssert.ok(
    Math.abs(result.after.physical.x - before.physical.x) > 40,
    "Pill must follow the native drag",
  );
  for (const sample of result.held) {
    NodeAssert.ok(
      Math.abs(sample.width - (320 * sample.dpi) / 96) <= 1,
      "Held pill width must follow native DPI without accumulating drift",
    );
    NodeAssert.ok(
      Math.abs(sample.height - (70 * sample.dpi) / 96) <= 1,
      "Held pill height must follow native DPI without accumulating drift",
    );
  }
  await waitMode(surfaces, "pill");
  NodeAssert.equal(
    (await snapshot(application, surfaces.main.id)).visible,
    false,
    "Drag must not open the workspace",
  );
  report.drags.push({
    target,
    held: result.held,
    before: result.before.physical,
    after: result.after.physical,
  });
}

async function clickOutside(application) {
  const id = await application.evaluate(async ({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    const fixture = new BrowserWindow({
      x: area.x + 24,
      y: area.y + 24,
      width: 180,
      height: 100,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: { sandbox: true },
    });
    await fixture.loadURL(
      'data:text/html,<body style="background:%2317382d;color:white">Satellite focus test</body>',
    );
    fixture.show();
    fixture.focus();
    return fixture.id;
  });
  const fixture = await snapshot(application, id);
  const x = fixture.physical.x + fixture.physical.width / 2;
  const y = fixture.physical.y + fixture.physical.height / 2;
  await NodeUtil.promisify(NodeChildProcess.execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      NodePath.join(repoRoot, "scripts/satellite-drag-gesture.ps1"),
      "-OwnedHwnd",
      fixture.hwnd,
      "-StartX",
      String(Math.round(x)),
      "-StartY",
      String(Math.round(y)),
      "-EndX",
      String(Math.round(x)),
      "-EndY",
      String(Math.round(y)),
    ],
    { windowsHide: true, timeout: 30000 },
  );
  return () =>
    application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), id);
}

const report = {
  kind: "Isolated SatelliteT3 native regression. No live provider work.",
  checks: [],
  drags: [],
  resizes: [],
  screenshots: [],
};
let application;
try {
  stage("Launching separate native pill and retained workspace");
  application = await launch();
  await traceWindows(application);
  let surfaces = await findSurfaces(application);
  const initial = await snapshot(application, surfaces.pill.id);
  NodeAssert.equal(initial.windows.length, 2);
  NodeAssert.equal(initial.preferences.sandbox, true);
  NodeAssert.equal(initial.preferences.contextIsolation, true);
  NodeAssert.equal(initial.preferences.nodeIntegration, false);
  NodeAssert.ok(NodePath.relative(profileRoot, initial.userData).startsWith("..") === false);
  NodeAssert.deepEqual(
    await surfaces.pill.page.evaluate(() => ({
      workspace: !!document.querySelector('[data-satellite="workspace"]'),
      mainBridge: !!window.satelliteBridge,
    })),
    { workspace: false, mainBridge: false },
  );
  const retained = await surfaces.main.page.locator('[data-satellite="workspace"]').elementHandle();
  report.checks.push("Two sandboxed surfaces. Pill has no workspace or main bridge.");
  await application.evaluate(({ BrowserWindow, screen }, id) => {
    const a = screen.getPrimaryDisplay().workArea;
    BrowserWindow.fromId(id).setBounds({ x: a.x + 700, y: a.y + 500, width: 320, height: 70 });
  }, surfaces.pill.id);
  stage("Dragging content, menu and padding with the native pointer");
  for (const target of ["pill-content", "pill-menu", "pill"])
    await dragPill(application, surfaces, target);
  stage("Dragging while the pill renderer is busy");
  await dragPill(application, surfaces, "pill-content", {
    stallRenderer: true,
    steps: 50,
    delay: 20,
  });
  report.checks.push(
    "Native drag from every pill region survives renderer work and cursor movement after release.",
  );
  const displays = await application.evaluate(({ screen }) =>
    screen.getAllDisplays().map((d) => ({ id: d.id, scale: d.scaleFactor, workArea: d.workArea })),
  );
  const primary = displays.find((d) => d.id === initial.display) ?? displays[0];
  const other = displays.find((d) => d.scale !== primary.scale);
  if (other) {
    stage("Dragging across different display scales in both directions");
    for (const display of [other, primary]) {
      const end = await application.evaluate(
        ({ screen }, a) => screen.dipToScreenPoint({ x: a.x + a.width / 2, y: a.y + a.height / 2 }),
        display.workArea,
      );
      await dragPill(application, surfaces, "pill-content", { end, steps: 180, delay: 5 });
      NodeAssert.equal((await snapshot(application, surfaces.pill.id)).display, display.id);
    }
    report.checks.push(
      "Mixed-DPI round trip keeps 320 by 70 logical pixels throughout held movement.",
    );
  } else report.checks.push("Mixed-DPI test skipped because only one scale is connected.");
  stage("Checking status updates and repeated click-away reopening");
  await expand(application, surfaces);
  const closeFixture = await clickOutside(application);
  await waitMode(surfaces, "pill");
  await closeFixture();
  await surfaces.main.page.evaluate(() => {
    const workspace = document.querySelector('[data-satellite="workspace"]');
    const spacer = document.createElement("div");
    spacer.style.height = "3000px";
    workspace.append(spacer);
    spacer.scrollIntoView({ block: "end" });
    spacer.remove();
    window.satelliteBridge.publish({
      threadId: null,
      environmentId: null,
      title: "DEVELOPMENT FIXTURE",
      state: "working",
      detail: "Native movement regression",
      attention: false,
    });
  });
  await surfaces.pill.page.waitForFunction(
    () =>
      document.querySelector('[data-satellite="pill-title"]')?.textContent ===
      "DEVELOPMENT FIXTURE",
  );
  await expand(application, surfaces);
  await collapse(application, surfaces);
  await dragPill(application, surfaces, "pill-content");
  report.checks.push(
    "Click-away collapse, background scrolling, status updates and immediate drag leave a responsive pill.",
  );
  stage("Checking native resize from all eight edges and corners");
  await expand(application, surfaces);
  await surfaces.main.page.evaluate(() => window.satelliteBridge.setPinned(true));
  for (const [name, rx, ry, dx, dy] of [
    ["right", 1, 0.5, 80, 0],
    ["bottom", 0.5, 1, 0, 60],
    ["left", 0, 0.5, -80, 0],
    ["top", 0.5, 0, 0, -60],
    ["bottom-right", 1, 1, 60, 40],
    ["top-left", 0, 0, -60, -40],
    ["top-right", 1, 0, 60, -40],
    ["bottom-left", 0, 1, -60, 40],
  ]) {
    await application.evaluate(
      ({ BrowserWindow }, id) =>
        BrowserWindow.fromId(id).setBounds({ x: 400, y: 250, width: 1000, height: 700 }),
      surfaces.main.id,
    );
    const b = await snapshot(application, surfaces.main.id);
    const start = {
      x: b.physical.x + 2 + (b.physical.width - 4) * rx,
      y: b.physical.y + 2 + (b.physical.height - 4) * ry,
    };
    const result = await nativeGesture(application, surfaces.main, start, {
      x: start.x + (dx * b.dpi) / 96,
      y: start.y + (dy * b.dpi) / 96,
    });
    if (dx)
      NodeAssert.ok(
        result.after.bounds.width > b.bounds.width + 40,
        `${name} must resize horizontally`,
      );
    if (dy)
      NodeAssert.ok(
        result.after.bounds.height > b.bounds.height + 20,
        `${name} must resize vertically`,
      );
    report.resizes.push({ name, before: b.bounds, after: result.after.bounds });
  }
  const resized = (await snapshot(application, surfaces.main.id)).bounds;
  if (other) {
    stage("Checking workspace movement across display scales preserves the chosen size");
    const preferencePath = NodePath.join(initial.userData, "satellite-pill.json");
    const preferred = JSON.parse(await NodeFSP.readFile(preferencePath, "utf8"));
    for (const display of [other, primary]) {
      const header = await surfaces.main.page.locator(".drag-region").first().boundingBox();
      NodeAssert.ok(header, "The workspace must expose its native drag region");
      const points = await application.evaluate(
        ({ BrowserWindow, screen }, { id, header, area }) => {
          const b = BrowserWindow.fromId(id).getContentBounds();
          return {
            start: screen.dipToScreenPoint({
              x: Math.round(b.x + header.x + header.width / 2),
              y: Math.round(b.y + header.y + header.height / 2),
            }),
            end: screen.dipToScreenPoint({
              x: Math.round(area.x + area.width / 2),
              y: Math.round(area.y + area.height / 2),
            }),
          };
        },
        { id: surfaces.main.id, header, area: display.workArea },
      );
      await nativeGesture(application, surfaces.main, points.start, points.end, {
        steps: 180,
        delay: 5,
      });
      const afterMove = JSON.parse(await NodeFSP.readFile(preferencePath, "utf8"));
      NodeAssert.equal(
        afterMove.workspaceWidth,
        preferred.workspaceWidth,
        "DPI movement must not replace the chosen width",
      );
      NodeAssert.equal(
        afterMove.workspaceHeight,
        preferred.workspaceHeight,
        "DPI movement must not replace the chosen height",
      );
    }
    report.checks.push(
      "Workspace movement across display scales preserves the user resize preference.",
    );
  }
  await collapse(application, surfaces);
  await expand(application, surfaces);
  let restored = (await snapshot(application, surfaces.main.id)).bounds;
  NodeAssert.ok(
    Math.abs(restored.width - resized.width) <= 1 &&
      Math.abs(restored.height - resized.height) <= 1,
    "Reopening restores the user resize",
  );
  report.checks.push(
    "All eight resize edges and corners work. User dimensions survive collapse and reopen.",
  );
  stage("Checking workspace zoom, pinning, close and minimize");
  await application.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.setZoomFactor(1.2),
    surfaces.main.id,
  );
  await collapse(application, surfaces);
  NodeAssert.equal((await snapshot(application, surfaces.pill.id)).zoom, 1);
  await expand(application, surfaces);
  await application.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.setZoomFactor(1),
    surfaces.main.id,
  );
  const closePinned = await clickOutside(application);
  await waitMode(surfaces, "workspace");
  await closePinned();
  await surfaces.main.page.bringToFront();
  await surfaces.main.page.evaluate(() => window.satelliteBridge.setPinned(false));
  await application.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(),
    surfaces.main.id,
  );
  await waitMode(surfaces, "pill");
  await expand(application, surfaces);
  await application.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id).minimize(),
    surfaces.main.id,
  );
  await waitMode(surfaces, "pill");
  NodeAssert.equal(
    await retained.evaluate(
      (node) => node.isConnected && node === document.querySelector('[data-satellite="workspace"]'),
    ),
    true,
  );
  report.checks.push(
    "Workspace zoom leaves the pill unchanged. Pin, native close and minimize preserve the mounted workspace.",
  );
  stage("Checking restart persistence");
  const positionFile = NodePath.join(initial.userData, "satellite-pill.json");
  const expectedPosition = (await snapshot(application, surfaces.pill.id)).bounds;
  for (const surface of [surfaces.main, surfaces.pill]) {
    const path = NodePath.join(
      artifactsRoot,
      surface === surfaces.main ? "workspace-after.png" : "pill-after.png",
    );
    await surface.page.screenshot({ path });
    report.screenshots.push(path);
  }
  await application.close();
  application = undefined;
  const saved = JSON.parse(await NodeFSP.readFile(positionFile, "utf8"));
  NodeAssert.equal(saved.x, expectedPosition.x);
  NodeAssert.equal(saved.y, expectedPosition.y);
  application = await launch();
  await traceWindows(application);
  surfaces = await findSurfaces(application);
  const restarted = (await snapshot(application, surfaces.pill.id)).bounds;
  NodeAssert.equal(restarted.x, saved.x);
  NodeAssert.equal(restarted.y, saved.y);
  await expand(application, surfaces);
  restored = (await snapshot(application, surfaces.main.id)).bounds;
  NodeAssert.ok(
    Math.abs(restored.width - saved.workspaceWidth) <= 1 &&
      Math.abs(restored.height - saved.workspaceHeight) <= 1,
    "Restart restores preferred workspace dimensions",
  );
  report.checks.push("Restart restores the pill position and preferred workspace dimensions.");
  await collapse(application, surfaces);
  console.log(JSON.stringify(report, null, 2));
  console.log("PASS Satellite native drag, DPI, resize and lifecycle regression");
} catch (error) {
  console.error(`[satellite-smoke] Failed at ${currentStage}`, error);
  if (application)
    console.error(
      "WINDOW EVENTS",
      await application.evaluate(() => globalThis.satelliteSmokeEvents).catch(() => null),
    );
  if (application)
    console.error(
      await application
        .evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((w) => ({
            id: w.id,
            url: w.webContents.getURL(),
            visible: w.isVisible(),
            bounds: w.getBounds(),
          })),
        )
        .catch(() => null),
    );
  process.exitCode = 1;
} finally {
  await NodeFSP.writeFile(
    NodePath.join(artifactsRoot, "native-smoke-report.json"),
    JSON.stringify(report, null, 2),
  );
  if (application && !keepRunning) await application.close();
}
