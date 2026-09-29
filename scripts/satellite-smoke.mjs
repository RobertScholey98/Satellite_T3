import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

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

const executablePath = requireDesktop("electron");
const { _electron } = requireDesktop("playwright-core");
const mainEntry = NodePath.join(desktopRoot, "dist-electron", "boot.cjs");
for (const requiredPath of [
  executablePath,
  mainEntry,
  NodePath.join(desktopRoot, "dist-electron", "satellite-pill-preload.cjs"),
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

async function launch() {
  return _electron.launch({
    executablePath,
    args: [mainEntry],
    cwd: desktopRoot,
    env: launchEnv,
    timeout: 90_000,
  });
}

async function findWindows(application) {
  // Observe actual native windows and their completed loads; no timing sleeps.
  const identities = await application.evaluate(async ({ app, BrowserWindow }) => {
    return new Promise((resolve, reject) => {
      const observed = new Set();
      const check = () => {
        const windows = BrowserWindow.getAllWindows();
        const pill = windows.find((window) =>
          window.webContents.getURL().startsWith("data:text/html"),
        );
        const main = windows.find((window) => window.webContents.getURL().startsWith("t3code://"));
        if (pill && main) {
          cleanup();
          resolve({ mainId: main.id, pillId: pill.id, mainUrl: main.webContents.getURL() });
        }
      };
      const observe = (_event, window) => {
        observed.add(window);
        window.webContents.on("did-finish-load", check);
        check();
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Main and pill windows did not load within 60 seconds"));
      }, 60_000);
      const cleanup = () => {
        clearTimeout(timeout);
        app.removeListener("browser-window-created", observe);
        for (const window of observed) {
          if (!window.isDestroyed()) window.webContents.removeListener("did-finish-load", check);
        }
      };
      app.on("browser-window-created", observe);
      for (const window of BrowserWindow.getAllWindows()) observe(null, window);
    });
  });
  const pageFor = async (predicate) =>
    application.windows().find(predicate) ??
    application.waitForEvent("window", { predicate, timeout: 30_000 });
  const main = await pageFor((page) => page.url().startsWith("t3code://"));
  const pill = await pageFor((page) => page.url().startsWith("data:text/html"));
  await main.waitForFunction(() => typeof window.satelliteBridge?.publish === "function");
  await pill.locator("#open").waitFor();
  return { ...identities, main, pill };
}

async function nativeSnapshot(application, identities) {
  return application.evaluate(
    ({ BrowserWindow, app, screen }, ids) => {
      const main = BrowserWindow.fromId(ids.mainId);
      const pill = BrowserWindow.fromId(ids.pillId);
      if (!main || !pill) throw new Error("Expected native window was destroyed");
      const preferences = pill.webContents.getLastWebPreferences();
      return {
        main: { id: main.id, visible: main.isVisible(), destroyed: main.isDestroyed() },
        pill: {
          id: pill.id,
          visible: pill.isVisible(),
          alwaysOnTop: pill.isAlwaysOnTop(),
          resizable: pill.isResizable(),
          minimizable: pill.isMinimizable(),
          maximizable: pill.isMaximizable(),
          fullscreenable: pill.isFullScreenable(),
          bounds: pill.getBounds(),
          contentBounds: pill.getContentBounds(),
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
          sandbox: preferences.sandbox,
        },
        userData: app.getPath("userData"),
        workAreas: screen
          .getAllDisplays()
          .map((display) => ({ ...display.workArea, scaleFactor: display.scaleFactor })),
      };
    },
    { mainId: identities.mainId, pillId: identities.pillId },
  );
}

async function waitVisible(application, windowId) {
  await application.evaluate(async ({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id);
    if (!window) throw new Error("Expected window was destroyed");
    if (window.isVisible()) return;
    await new Promise((resolve, reject) => {
      const shown = () => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        window.removeListener("show", shown);
        reject(new Error("Expected native window did not become visible"));
      }, 30_000);
      window.once("show", shown);
    });
  }, windowId);
}

async function quit(application) {
  // Playwright Electron's close invokes app.quit(), preserving the app's shutdown path.
  await application.close();
}

let application;
const report = {
  kind: "DEVELOPMENT FIXTURE — native smoke, no live provider work",
  checks: [],
  screenshots: [],
};
try {
  application = await launch();
  const windows = await findWindows(application);
  await waitVisible(application, windows.mainId);
  await waitVisible(application, windows.pillId);
  const initial = await nativeSnapshot(application, windows);
  NodeAssert.equal(initial.pill.alwaysOnTop, true);
  NodeAssert.equal(initial.pill.resizable, false);
  NodeAssert.equal(initial.pill.minimizable, false);
  NodeAssert.equal(initial.pill.maximizable, false);
  NodeAssert.equal(initial.pill.fullscreenable, false);
  NodeAssert.equal(initial.pill.contextIsolation, true);
  NodeAssert.equal(initial.pill.nodeIntegration, false);
  NodeAssert.equal(initial.pill.sandbox, true);
  NodeAssert.equal(initial.pill.bounds.width, 320);
  // This Windows host rounds the requested 70px native height to 72px, even
  // without a thick frame. Verify the visible capsule separately below.
  NodeAssert.ok(
    initial.pill.bounds.height >= 70 && initial.pill.bounds.height <= 72,
    `Native pill geometry exceeds the verified height range: ${JSON.stringify(initial.pill)}`,
  );
  const visiblePill = await windows.pill.locator(".pill").boundingBox();
  NodeAssert.equal(visiblePill?.width, 320);
  NodeAssert.equal(visiblePill?.height, 70);
  const relativeProfile = NodePath.relative(profileRoot, initial.userData);
  NodeAssert.equal(NodePath.isAbsolute(relativeProfile), false);
  NodeAssert.equal(relativeProfile.startsWith(".."), false);
  report.checks.push(
    `Separate visible 320×70 pill is always on top, nonresizable, and sandboxed (native host height ${initial.pill.bounds.height}px)`,
  );

  await application.evaluate(async ({ BrowserWindow }, id) => {
    const main = BrowserWindow.fromId(id);
    if (!main) throw new Error("Main window missing before close");
    const hidden = main.isVisible()
      ? new Promise((resolve, reject) => {
          const hiddenHandler = () => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            main.removeListener("hide", hiddenHandler);
            reject(new Error("Closing main did not hide it"));
          }, 30_000);
          main.once("hide", hiddenHandler);
        })
      : Promise.resolve();
    main.close();
    await hidden;
  }, windows.mainId);
  const hidden = await nativeSnapshot(application, windows);
  NodeAssert.equal(hidden.main.id, initial.main.id);
  NodeAssert.equal(hidden.main.destroyed, false);
  NodeAssert.equal(hidden.main.visible, false);
  NodeAssert.equal(hidden.pill.visible, true);
  report.checks.push("Closing main hides it while the same renderer and pill remain alive");

  const fixtures = [
    {
      name: "working",
      state: "working",
      detail: "DEVELOPMENT FIXTURE · Working",
      attention: false,
      color: "rgb(136, 184, 245)",
    },
    {
      name: "approval",
      state: "awaiting-input",
      detail: "DEVELOPMENT FIXTURE · Approval required",
      attention: true,
      color: "rgb(235, 195, 122)",
    },
    {
      name: "completed",
      state: "completed",
      detail: "DEVELOPMENT FIXTURE · Completed",
      attention: false,
      color: "rgb(166, 216, 189)",
    },
    {
      name: "unknown",
      state: "unknown",
      detail: "DEVELOPMENT FIXTURE · Status unavailable",
      attention: false,
      color: "rgb(146, 154, 150)",
    },
  ];
  for (const fixture of fixtures) {
    const projection = {
      threadId: null,
      environmentId: null,
      title: "DEVELOPMENT FIXTURE",
      state: fixture.state,
      detail: fixture.detail,
      attention: fixture.attention,
    };
    await windows.main.evaluate((state) => window.satelliteBridge.publish(state), projection);
    await windows.pill.waitForFunction(
      (expected) =>
        document.body.dataset.state === expected.state &&
        document.getElementById("detail")?.textContent === expected.detail,
      projection,
    );
    const rendered = await windows.pill.evaluate(() => ({
      title: document.getElementById("title")?.textContent,
      color: getComputedStyle(document.querySelector(".dot")).backgroundColor,
      attention: getComputedStyle(document.getElementById("attention")).display !== "none",
    }));
    NodeAssert.equal(rendered.title, projection.title);
    NodeAssert.equal(rendered.color, fixture.color);
    NodeAssert.equal(rendered.attention, fixture.attention);
    const screenshot = NodePath.join(artifactsRoot, `fixture-${fixture.name}.png`);
    await windows.pill.screenshot({ path: screenshot });
    report.screenshots.push(screenshot);
  }
  report.checks.push(
    "Hidden main publishes working, approval-required, completed, and unknown fixture states with matching color/attention",
  );

  await windows.pill.locator("#open").click();
  await waitVisible(application, windows.mainId);
  const reopened = await nativeSnapshot(application, windows);
  NodeAssert.equal(reopened.main.id, initial.main.id);
  NodeAssert.equal(reopened.main.visible, true);
  report.checks.push(
    "Clicking pill reveals the existing main window (conversation navigation needs real thread verification)",
  );

  const beforeKeyboardMove = await application.evaluate(({ BrowserWindow, screen }, id) => {
    const area = screen.getPrimaryDisplay().workArea;
    const pill = BrowserWindow.fromId(id);
    if (!pill) throw new Error("Pill disappeared before position check");
    pill.setPosition(area.x + 32, area.y + 32);
    const { x, y } = pill.getBounds();
    return { x, y };
  }, windows.pillId);
  const moveObservation = await application.evaluateHandle(({ BrowserWindow }, id) => {
    const pill = BrowserWindow.fromId(id);
    if (!pill) throw new Error("Pill disappeared before keyboard movement");
    const moved = new Promise((resolve) => {
      const changed = () => {
        clearTimeout(timeout);
        const { x, y } = pill.getBounds();
        resolve({ x, y });
      };
      const timeout = setTimeout(() => {
        pill.removeListener("move", changed);
        resolve(null);
      }, 30_000);
      pill.once("move", changed);
    });
    return { moved };
  }, windows.pillId);
  let expectedPosition;
  try {
    await windows.pill.bringToFront();
    await windows.pill.locator("#open").focus();
    await windows.pill.keyboard.press("Alt+ArrowRight");
    expectedPosition = await moveObservation.evaluate(async ({ moved }) => moved);
  } finally {
    await moveObservation.dispose();
  }
  NodeAssert.deepEqual(expectedPosition, { x: beforeKeyboardMove.x + 16, y: beforeKeyboardMove.y });
  report.checks.push("Alt+ArrowRight moves the actual native pill by 16px through its preload/IPC");
  const positionFile = NodePath.join(initial.userData, "satellite-pill.json");
  await quit(application);
  application = undefined;
  const savedPosition = JSON.parse(await NodeFSP.readFile(positionFile, "utf8"));
  NodeAssert.deepEqual(savedPosition, expectedPosition);

  application = await launch();
  const restartedWindows = await findWindows(application);
  const restarted = await nativeSnapshot(application, restartedWindows);
  NodeAssert.deepEqual(
    { x: restarted.pill.bounds.x, y: restarted.pill.bounds.y },
    expectedPosition,
  );
  report.checks.push("Explicit quit completes and relaunch restores saved native pill position");
  report.native = { initial, restarted };
  report.retained = keepRunning;
  console.log(JSON.stringify(report, null, 2));
  if (keepRunning) {
    console.log("Owned isolated smoke instance retained; quit SatelliteT3 to finish this script.");
    await application.waitForEvent("close", { timeout: 0 });
    application = undefined;
  }
} finally {
  if (application) await quit(application);
}
