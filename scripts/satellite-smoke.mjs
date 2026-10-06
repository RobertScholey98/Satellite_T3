import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
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
const reportPath = NodePath.join(artifactsRoot, "native-smoke-report.json");
const keepRunning = process.argv.includes("--keep-running");
const nativePointer = !process.argv.includes("--no-native-pointer");
const actionWingOnly = process.argv.includes("--action-wing-only");
const unknownArgs = process.argv
  .slice(2)
  .filter((arg) => !["--keep-running", "--no-native-pointer", "--action-wing-only"].includes(arg));
NodeAssert.deepEqual(
  unknownArgs,
  [],
  "Only --keep-running, --no-native-pointer and --action-wing-only are supported",
);

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
  await surfaces.pill.page.evaluate(() => {
    window.satelliteSmokeObservedLayoutDispose = window.satellitePillBridge.onLayout((layout) => {
      window.satelliteSmokeObservedLayout = layout;
    });
  });
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
        alwaysOnTop: window.isAlwaysOnTop(),
        foregroundHwnd: load({
          library: "satellite-smoke-user32",
          funcName: "GetForegroundWindow",
          retType: DataType.BigInt,
          paramsType: [],
          paramsValue: [],
        }).toString(),
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

async function focusOwnedWindow(application, id) {
  NodeAssert.ok(nativePointer, "Foreground preparation is disabled by --no-native-pointer");
  await application.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id);
    if (!window || window.isDestroyed())
      throw new Error("The owned native test window is unavailable");
    window.show();
    window.focus();
    window.setAlwaysOnTop(true, "floating");
  }, id);
}

async function verifySeededCoordinator(application, surfaces) {
  const databasePath = NodePath.join(nativeHome, "userdata", "state.sqlite");
  const databaseExists = await NodeFSP.access(databasePath).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  let seededThreads = 0;
  if (databaseExists) {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      if (
        database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projection_threads'",
          )
          .get()
      ) {
        seededThreads = database
          .prepare(
            "SELECT COUNT(*) AS count FROM projection_threads WHERE project_id = 'wing-verify-project' AND thread_id IN ('wing-verify-architecture', 'wing-verify-migration')",
          )
          .get().count;
      }
    } finally {
      database.close();
    }
  }
  if (seededThreads === 0) {
    report.checks.push(
      "Real coordinator draft handoff skipped because the optional wing verification seed is absent.",
    );
    return;
  }
  NodeAssert.equal(
    seededThreads,
    2,
    "The optional real-coordinator fixture has both seeded threads",
  );
  stage("Checking seeded requests through the real retained coordinator");
  await surfaces.pill.page.evaluate(() => {
    window.satelliteSmokeCoordinatorDispose = window.satellitePillBridge.onPillState((state) => {
      window.satelliteSmokeCoordinatorState = state;
    });
  });
  await application.evaluate(({ BrowserWindow, ipcMain }, pillId) => {
    const pill = BrowserWindow.fromId(pillId);
    const intents = [];
    const observe = (event, intent) => {
      if (event.sender === pill.webContents) intents.push(intent.type);
    };
    ipcMain.on("satellite:attention-intent", observe);
    globalThis.satelliteSmokeCoordinator = {
      intents,
      dispose: () => ipcMain.off("satellite:attention-intent", observe),
    };
  }, surfaces.pill.id);
  try {
    const requestIds = [
      "wing-verify-architecture-request",
      "wing-verify-notes-request",
      "wing-verify-migration-request",
    ];
    await surfaces.pill.page.waitForFunction((ids) => {
      const items = window.satelliteSmokeCoordinatorState?.actionWing?.items;
      return (
        items &&
        ids.every((id) => items.some((item) => item.ref.requestId === id && item.available))
      );
    }, requestIds);
    const view = await surfaces.pill.page.evaluate(
      () => window.satelliteSmokeCoordinatorState.actionWing,
    );
    NodeAssert.equal(
      view.items.length,
      3,
      "The real coordinator discovers three requests across two seeded threads",
    );
    NodeAssert.deepEqual(
      view.items.map((item) => item.ref.requestId).sort(),
      [...requestIds].sort(),
    );
    await collapse(application, surfaces);
    await surfaces.pill.page.locator('[data-satellite="action-wing"]').click();
    const panel = surfaces.pill.page.locator('[data-satellite="action-panel"]');
    await panel.waitFor();
    const tabs = panel.getByRole("tablist", { name: "Pending requests" }).getByRole("tab");
    NodeAssert.equal(await tabs.count(), 3);
    const notesId = "wing-verify-notes-request";
    const architectureId = "wing-verify-architecture-request";
    const notesIndex = view.items.findIndex((item) => item.ref.requestId === notesId);
    const architectureIndex = view.items.findIndex((item) => item.ref.requestId === architectureId);
    const waitSelected = (requestId) =>
      surfaces.pill.page.waitForFunction((id) => {
        const editor = window.satelliteSmokeCoordinatorState?.actionWing?.selected;
        return editor?.ref.requestId === id && editor.status === "ready";
      }, requestId);
    const draft = "Keep compact request summaries and load the selected request details on demand.";
    await tabs.nth(notesIndex).click();
    await waitSelected(notesId);
    const answer = panel.locator("textarea");
    await answer.fill(draft);
    await surfaces.pill.page.waitForFunction(
      (text) =>
        window.satelliteSmokeCoordinatorState?.actionWing?.selected?.answers.notes?.customAnswer ===
        text,
      draft,
    );
    await tabs.nth(architectureIndex).click();
    await waitSelected(architectureId);
    await panel
      .getByText("How should pending requests reach the action wing?", { exact: true })
      .waitFor();
    await tabs.nth(notesIndex).click();
    await waitSelected(notesId);
    NodeAssert.equal(
      await answer.inputValue(),
      draft,
      "Switching request tabs retains the real draft",
    );
    await panel.getByRole("button", { name: "Mute in pill", exact: true }).click();
    await surfaces.pill.page.waitForFunction((id) => {
      const current = window.satelliteSmokeCoordinatorState?.actionWing;
      return (
        current?.items.some((item) => item.ref.requestId === id && item.muted) &&
        current.selected?.ref.requestId !== id
      );
    }, notesId);
    await panel.getByRole("button", { name: "1 muted request", exact: true }).click();
    await panel.getByRole("button", { name: "Restore", exact: true }).click();
    await waitSelected(notesId);
    NodeAssert.equal(
      await answer.inputValue(),
      draft,
      "Restoring a muted request retains its draft",
    );
    await panel.getByRole("button", { name: "Open in thread", exact: true }).click();
    await waitMode(surfaces, "workspace");
    await surfaces.main.page.waitForURL(/wing-verify-architecture/u);
    const composer = surfaces.main.page.locator('[data-chat-composer-form="true"]:visible');
    await composer.getByText("Anything else to include in the review?", { exact: true }).waitFor();
    await surfaces.main.page.waitForFunction(
      (text) =>
        [...document.querySelectorAll('[data-testid="composer-editor"]')].some(
          (editor) => editor.getClientRects().length > 0 && editor.textContent?.trim() === text,
        ),
      draft,
    );
    NodeAssert.equal(
      (await composer.getByTestId("composer-editor").textContent()).trim(),
      draft,
      "Open in thread selects the second pending request with the same unsent draft",
    );
    const intents = await application.evaluate(() => globalThis.satelliteSmokeCoordinator.intents);
    NodeAssert.equal(
      intents.some((type) =>
        ["submit", "advance", "approve", "dismiss", "retry-delivery"].includes(type),
      ),
      false,
      "The seeded coordinator check never submits a provider response",
    );
    const path = NodePath.join(artifactsRoot, "action-wing-thread-draft.png");
    await surfaces.main.page.screenshot({ path });
    report.screenshots.push(path);
    report.checks.push(
      "The real coordinator discovers three seeded requests. An unsent draft survives tab switches and mute/restore. Open in thread selects the second request and preserves its composer draft.",
    );
  } finally {
    await surfaces.pill.page.evaluate(() => window.satelliteSmokeCoordinatorDispose?.());
    await application.evaluate(() => globalThis.satelliteSmokeCoordinator.dispose());
  }
}

async function installQuietPill(application, surfaces) {
  await application.evaluate(({ BrowserWindow, ipcMain }, mainId) => {
    const main = BrowserWindow.fromId(mainId);
    let latest;
    const overlay = (event, value) => {
      if (event.sender !== main.webContents || globalThis.satelliteSmokeWing?.active) return;
      if (value.actionWing) latest = { ...value };
      delete value.actionWing;
      value.attention = false;
    };
    ipcMain.prependListener("satellite:publish", overlay);
    globalThis.satelliteSmokeQuiet = {
      dispose: () => {
        ipcMain.off("satellite:publish", overlay);
        if (latest && !main.isDestroyed())
          ipcMain.emit("satellite:publish", { sender: main.webContents }, latest);
      },
    };
    ipcMain.emit(
      "satellite:publish",
      { sender: main.webContents },
      {
        threadId: null,
        environmentId: null,
        title: "DEVELOPMENT FIXTURE",
        state: "idle",
        detail: "Native movement regression",
        attention: false,
      },
    );
  }, surfaces.main.id);
  await surfaces.pill.page.evaluate(() =>
    window.satellitePillBridge.setLayout({ mode: "compact", wing: false }),
  );
  await surfaces.pill.page.locator('[data-satellite="action-wing"]').waitFor({ state: "detached" });
  await surfaces.pill.page.waitForFunction(
    () => window.innerWidth === 252 && window.innerHeight === 56,
  );
}

async function installWingFixture(application, surfaces) {
  await application.evaluate(
    ({ BrowserWindow, ipcMain }, { mainId, pillId }) => {
      const main = BrowserWindow.fromId(mainId);
      const pill = BrowserWindow.fromId(pillId);
      const ref = {
        environmentId: "satellite-native-smoke",
        threadId: "fixture-thread",
        kind: "question",
        requestId: "fixture-question",
      };
      const createdAt = "2026-10-05T12:00:00.000Z";
      const state = {
        threadId: ref.threadId,
        environmentId: ref.environmentId,
        title: "NATIVE ACTION WING FIXTURE",
        state: "awaiting-input",
        detail: "No live provider work",
        attention: true,
        actionWing: {
          items: [
            {
              ref,
              title: "Native fixture",
              environmentName: "Isolated fixture",
              label: "Question",
              preview: "Which implementation should the fixture use?",
              createdAt,
              available: true,
              muted: false,
            },
          ],
          selected: {
            ref,
            status: "ready",
            delivery: "editing",
            questionIndex: 0,
            answers: {},
            question: {
              requestId: ref.requestId,
              createdAt,
              dismissible: false,
              questions: [
                {
                  id: "fixture-choice",
                  header: "Implementation",
                  question: "Which implementation should the fixture use?",
                  options: [
                    {
                      label: "Small change",
                      value: "small",
                      description: "Keep the existing implementation.",
                    },
                    {
                      label: "New implementation",
                      value: "new",
                      description: "Replace the current behavior.",
                    },
                  ],
                  multiSelect: false,
                  allowCustomAnswer: true,
                },
              ],
            },
          },
          incompleteEnvironments: [],
          workingCount: 2,
          completedCount: 1,
        },
      };
      const fixture = {
        active: true,
        state,
        intents: [],
        publish: () =>
          ipcMain.emit("satellite:publish", { sender: main.webContents }, fixture.state),
      };
      const overlay = (event, value) => {
        if (event.sender === main.webContents) Object.assign(value, fixture.state);
      };
      const relay = (event, intent) => {
        if (event.sender !== pill.webContents) return;
        fixture.intents.push(intent);
        const selected = fixture.state.actionWing.selected;
        if (intent.type === "answer" && intent.ref.requestId === selected.ref.requestId) {
          selected.answers[intent.questionId] = intent.answer;
          fixture.publish();
        }
      };
      ipcMain.prependListener("satellite:publish", overlay);
      ipcMain.on("satellite:attention-intent", relay);
      fixture.dispose = () => {
        fixture.active = false;
        ipcMain.off("satellite:publish", overlay);
        ipcMain.off("satellite:attention-intent", relay);
      };
      globalThis.satelliteSmokeWing = fixture;
      fixture.publish();
    },
    { mainId: surfaces.main.id, pillId: surfaces.pill.id },
  );
  await surfaces.pill.page.evaluate(() => {
    window.satelliteSmokeLayoutDispose = window.satellitePillBridge.onLayout((layout) => {
      window.satelliteSmokeLayout = layout;
      window.satelliteSmokeReopenTrace?.record("native-layout", { layout });
    });
  });
  await surfaces.pill.page.locator('[data-satellite="action-wing"]').waitFor();
}

async function readWingLayout(surfaces, mode) {
  await surfaces.pill.page.waitForFunction(
    (mode) => window.satelliteSmokeLayout?.mode === mode,
    mode,
  );
  return surfaces.pill.page.evaluate(() => window.satelliteSmokeLayout);
}

async function waitForPillGeometry(surfaces, expected = null) {
  return surfaces.pill.page.evaluate(
    (expected) =>
      new Promise((resolve, reject) => {
        let nativeLayout;
        const inspect = () => {
          if (!nativeLayout) return;
          if (
            expected &&
            (nativeLayout.mode !== expected.mode ||
              nativeLayout.width !== expected.width ||
              nativeLayout.height !== expected.height)
          )
            return;
          // Windows encloses fractional physical bounds in the integer CSS viewport.
          if (
            innerWidth < nativeLayout.width ||
            innerWidth > nativeLayout.width + 1 ||
            innerHeight < nativeLayout.height ||
            innerHeight > nativeLayout.height + 1
          )
            return;
          if (JSON.stringify(window.satelliteSmokeObservedLayout) !== JSON.stringify(nativeLayout))
            return;
          if (
            expected &&
            JSON.stringify(window.satelliteSmokeLayout) !== JSON.stringify(nativeLayout)
          )
            return;
          const panel = document.querySelector('[data-satellite="action-panel"]');
          const pill = document.querySelector('[data-satellite="pill"]');
          const node = nativeLayout.panel ? panel : pill;
          if (!node || (!nativeLayout.panel && panel)) return;
          const box = node.getBoundingClientRect();
          const rect = nativeLayout.panel ?? nativeLayout.pill;
          if (["x", "y", "width", "height"].some((key) => Math.abs(box[key] - rect[key]) > 0.5))
            return;
          cleanup();
          resolve({
            layout: nativeLayout,
            observedLayout: window.satelliteSmokeObservedLayout,
            wingLayout: window.satelliteSmokeLayout ?? null,
            viewport: { width: innerWidth, height: innerHeight },
            panel: panel?.getBoundingClientRect().toJSON() ?? null,
            content:
              document
                .querySelector('[data-satellite="panel-content"]')
                ?.getBoundingClientRect()
                .toJSON() ?? null,
          });
        };
        const observer = new ResizeObserver(inspect);
        const mutations = new MutationObserver(inspect);
        const dispose = window.satellitePillBridge.onLayout((layout) => {
          nativeLayout = layout;
          inspect();
        });
        const cleanup = () => {
          clearTimeout(timeout);
          observer.disconnect();
          mutations.disconnect();
          removeEventListener("resize", inspect);
          dispose();
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `Pill layout did not settle: ${JSON.stringify({ expected, nativeLayout, observedLayout: window.satelliteSmokeObservedLayout, wingLayout: window.satelliteSmokeLayout, viewport: { width: innerWidth, height: innerHeight } })}`,
            ),
          );
        }, 5000);
        observer.observe(document.documentElement);
        for (const node of document.querySelectorAll(
          '[data-satellite="pill"], [data-satellite="action-panel"], [data-satellite="panel-content"]',
        ))
          observer.observe(node);
        mutations.observe(document.body, { attributes: true, childList: true, subtree: true });
        addEventListener("resize", inspect);
      }),
    expected,
  );
}

async function nativeRegion(application, id, points) {
  const native = await snapshot(application, id);
  return application.evaluate(
    ({ BrowserWindow }, { id, points, dpi }) => {
      const ffi = globalThis.satelliteSmokeNative;
      if (!globalThis.satelliteSmokeRegionReady) {
        ffi.open({ library: "satellite-smoke-gdi32", path: "gdi32.dll" });
        globalThis.satelliteSmokeRegionReady = true;
      }
      const { load, DataType } = ffi;
      const region = load({
        library: "satellite-smoke-gdi32",
        funcName: "CreateRectRgn",
        retType: DataType.BigInt,
        paramsType: [DataType.I32, DataType.I32, DataType.I32, DataType.I32],
        paramsValue: [0, 0, 0, 0],
      });
      if (!region) throw new Error("Could not allocate native shape inspection region");
      try {
        const kind = load({
          library: "satellite-smoke-user32",
          funcName: "GetWindowRgn",
          retType: DataType.I32,
          paramsType: [DataType.BigInt, DataType.BigInt],
          paramsValue: [BrowserWindow.fromId(id).getNativeWindowHandle().readBigUInt64LE(), region],
        });
        const contains = Object.fromEntries(
          Object.entries(points).map(([name, point]) => [
            name,
            load({
              library: "satellite-smoke-gdi32",
              funcName: "PtInRegion",
              retType: DataType.Boolean,
              paramsType: [DataType.BigInt, DataType.I32, DataType.I32],
              paramsValue: [
                region,
                Math.round((point.x * dpi) / 96),
                Math.round((point.y * dpi) / 96),
              ],
            }),
          ]),
        );
        const box = Buffer.alloc(16);
        load({
          library: "satellite-smoke-gdi32",
          funcName: "GetRgnBox",
          retType: DataType.I32,
          paramsType: [DataType.BigInt, DataType.U8Array],
          paramsValue: [region, box],
        });
        const bounds = {
          x: box.readInt32LE(0),
          y: box.readInt32LE(4),
          width: box.readInt32LE(8) - box.readInt32LE(0),
          height: box.readInt32LE(12) - box.readInt32LE(4),
        };
        return { kind, contains, bounds };
      } finally {
        load({
          library: "satellite-smoke-gdi32",
          funcName: "DeleteObject",
          retType: DataType.Boolean,
          paramsType: [DataType.BigInt],
          paramsValue: [region],
        });
      }
    },
    { id, points, dpi: native.dpi },
  );
}

async function clickWingGap(application, surfaces, point) {
  NodeAssert.ok(nativePointer, "Physical gap clicks are disabled by --no-native-pointer");
  const native = await snapshot(application, surfaces.pill.id);
  const id = await application.evaluate(async ({ BrowserWindow }, bounds) => {
    const fixture = new BrowserWindow({
      ...bounds,
      frame: false,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: { sandbox: true },
    });
    await fixture.loadURL(
      'data:text/html,<body style="margin:0;background:%2320342b;color:white">Native gap receiver<script>window.receivedClick=new Promise(resolve=>addEventListener("click",()=>resolve(true),{once:true}))</script></body>',
    );
    fixture.showInactive();
    return fixture.id;
  }, native.bounds);
  try {
    await focusOwnedWindow(application, surfaces.pill.id);
    const fixture = await snapshot(application, id);
    const x = Math.round(native.physical.x + (point.x * native.dpi) / 96);
    const y = Math.round(native.physical.y + (point.y * native.dpi) / 96);
    const received = await nativeClick(
      fixture,
      { x, y },
      () =>
        application.evaluate(
          ({ BrowserWindow }, id) =>
            BrowserWindow.fromId(id).webContents.executeJavaScript(
              'Promise.race([window.receivedClick,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Transparent gap did not deliver its click")),4000))])',
            ),
          id,
        ),
      "transparent-gap",
    );
    NodeAssert.equal(
      received,
      true,
      "The window behind the panel gap receives the native pointer click",
    );
    await readWingLayout(surfaces, "compact");
  } finally {
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), id);
  }
}

async function traceWingReopen(application, surfaces) {
  const native = await application.evaluateHandle(({ BrowserWindow, ipcMain }, id) => {
    const pill = BrowserWindow.fromId(id);
    const events = [];
    const record = (event, extra = {}) => {
      events.push({
        time: Date.now(),
        event,
        focused: pill.isFocused(),
        visible: pill.isVisible(),
        bounds: pill.getBounds(),
        ...extra,
      });
      if (events.length > 100) events.shift();
    };
    const request = (event, value) => {
      if (event.sender === pill.webContents) record("layout-request", { request: value });
    };
    const listeners = ["show", "hide", "focus", "blur", "move", "resize"].map((name) => {
      const listener = () => record(name);
      pill.on(name, listener);
      return [name, listener];
    });
    ipcMain.on("satellite:pill-layout-request", request);
    record("trace-start");
    return {
      events,
      dispose: () => {
        ipcMain.off("satellite:pill-layout-request", request);
        for (const [name, listener] of listeners) pill.off(name, listener);
      },
    };
  }, surfaces.pill.id);
  await surfaces.pill.page.evaluate(() => {
    const events = [];
    const describe = (target) =>
      target instanceof Element
        ? {
            tag: target.tagName,
            satellite: target.closest("[data-satellite]")?.getAttribute("data-satellite"),
            role: target.getAttribute("role"),
          }
        : null;
    const state = () => ({
      focused: document.hasFocus(),
      activeElement: describe(document.activeElement),
      expanded: document
        .querySelector('[data-satellite="action-wing"]')
        ?.getAttribute("aria-expanded"),
      panel:
        document
          .querySelector('[data-satellite="action-panel"]')
          ?.getBoundingClientRect()
          .toJSON() ?? null,
      wing:
        document
          .querySelector('[data-satellite="action-wing"]')
          ?.getBoundingClientRect()
          .toJSON() ?? null,
      layout: window.satelliteSmokeLayout,
      observedLayout: window.satelliteSmokeObservedLayout,
      viewport: { width: innerWidth, height: innerHeight },
    });
    const record = (event, extra = {}) => {
      events.push({ time: Date.now(), event, ...state(), ...extra });
      if (events.length > 100) events.shift();
    };
    const pointer = (event) =>
      record(event.type, {
        target: describe(event.target),
        x: event.clientX,
        y: event.clientY,
        detail: event.detail,
        trusted: event.isTrusted,
        defaultPrevented: event.defaultPrevented,
      });
    const focus = (event) => record(`window-${event.type}`);
    for (const name of ["pointerdown", "pointerup", "click", "focusin", "focusout"])
      document.addEventListener(name, pointer, true);
    for (const name of ["focus", "blur"]) addEventListener(name, focus);
    let previous = JSON.stringify(state());
    const observer = new MutationObserver(() => {
      const next = JSON.stringify(state());
      if (next !== previous) {
        previous = next;
        record("dom-change");
      }
    });
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    window.satelliteSmokeReopenTrace = {
      record,
      read: () => ({ state: state(), events }),
      dispose: () => {
        observer.disconnect();
        for (const name of ["pointerdown", "pointerup", "click", "focusin", "focusout"])
          document.removeEventListener(name, pointer, true);
        for (const name of ["focus", "blur"]) removeEventListener(name, focus);
        delete window.satelliteSmokeReopenTrace;
      },
    };
    record("trace-start");
  });
  return native;
}

async function verifyWingPointer(application, surfaces) {
  NodeAssert.ok(nativePointer, "Physical action wing checks are disabled by --no-native-pointer");
  stage("Checking native answer text selection");
  const answer = surfaces.pill.page.locator('[data-satellite="action-panel"] textarea');
  await focusOwnedWindow(application, surfaces.pill.id);
  const diagnostic = { kind: "action-wing-text-selection" };
  let selectionReceipt;
  try {
    NodeAssert.equal(
      await answer.inputValue(),
      "Native selection remains editable.",
      "The restored question retains its editable draft",
    );
    diagnostic.geometry = await waitForPillGeometry(surfaces);
    NodeAssert.equal(diagnostic.geometry.layout.mode, "panel", "The restored question is open");
    await answer.scrollIntoViewIfNeeded();
    const screenshot = NodePath.join(artifactsRoot, "action-wing-question-before-selection.png");
    await surfaces.pill.page.screenshot({ path: screenshot });
    report.screenshots.push(screenshot);
    const selectionWindow = await snapshot(application, surfaces.pill.id);
    diagnostic.beforeNative = selectionWindow;
    const answerBox = await answer.boundingBox();
    NodeAssert.ok(answerBox, "The question fixture exposes its custom answer field");
    const point = { x: answerBox.x + 14, y: answerBox.y + 14 };
    selectionReceipt = await answer.evaluateHandle((field, point) => {
      const describe = (target) =>
        target instanceof Element
          ? {
              tag: target.tagName,
              satellite: target.getAttribute("data-satellite"),
              role: target.getAttribute("role"),
              isAnswer: target === field,
            }
          : null;
      const events = [];
      let released;
      const done = new Promise((resolve) => {
        released = resolve;
      });
      const timeout = setTimeout(() => released(null), 5000);
      const eventTypes = [
        "pointerdown",
        "pointerup",
        "pointercancel",
        "keydown",
        "keyup",
        "beforeinput",
        "input",
      ];
      const observe = (event) => {
        events.push({
          time: Date.now(),
          type: event.type,
          target: describe(event.target),
          x: event.clientX,
          y: event.clientY,
          buttons: event.buttons,
          trusted: event.isTrusted,
          key:
            event instanceof KeyboardEvent
              ? event.key.length === 1
                ? "<text>"
                : event.key
              : undefined,
          inputType: event instanceof InputEvent ? event.inputType : undefined,
          dataLength: event instanceof InputEvent ? event.data?.length : undefined,
          valueLength: field.value.length,
          selectionStart: field.selectionStart,
          selectionEnd: field.selectionEnd,
        });
        if (events.length > 100) events.shift();
        if (event.type === "pointerup") released(events.at(-1));
      };
      for (const name of eventTypes) document.addEventListener(name, observe, true);
      return {
        done,
        read: () => ({
          value: field.value,
          selectionStart: field.selectionStart,
          selectionEnd: field.selectionEnd,
          focused: document.hasFocus(),
          activeElement: describe(document.activeElement),
          answerBox: field.getBoundingClientRect().toJSON(),
          panelBox: field
            .closest('[data-satellite="action-panel"]')
            .getBoundingClientRect()
            .toJSON(),
          point,
          hit: describe(document.elementFromPoint(point.x, point.y)),
          layout: window.satelliteSmokeLayout,
          viewport: { width: innerWidth, height: innerHeight },
          events,
        }),
        dispose: () => {
          clearTimeout(timeout);
          for (const name of eventTypes) document.removeEventListener(name, observe, true);
        },
      };
    }, point);
    diagnostic.before = await selectionReceipt.evaluate((receipt) => receipt.read());
    NodeAssert.equal(
      diagnostic.before.hit?.isAnswer,
      true,
      "The selection point hits the visible textarea",
    );
    const selectionStart = {
      x: Math.round(selectionWindow.physical.x + (point.x * selectionWindow.dpi) / 96),
      y: Math.round(selectionWindow.physical.y + (point.y * selectionWindow.dpi) / 96),
    };
    diagnostic.start = selectionStart;
    const gesture = NodeUtil.promisify(NodeChildProcess.execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        NodePath.join(repoRoot, "scripts/satellite-drag-gesture.ps1"),
        "-OwnedHwnd",
        selectionWindow.hwnd,
        "-StartX",
        String(selectionStart.x),
        "-StartY",
        String(selectionStart.y),
        "-EndX",
        String(Math.round(selectionStart.x + (130 * selectionWindow.dpi) / 96)),
        "-EndY",
        String(selectionStart.y),
        "-WaitForReleaseAcknowledgement",
      ],
      { windowsHide: true, timeout: 30000 },
    );
    const released = new Promise((resolve, reject) =>
      gesture.child.stdout.once("data", async () => {
        try {
          diagnostic.pointerup = await selectionReceipt.evaluate((receipt) => receipt.done);
          diagnostic.atRelease = await selectionReceipt.evaluate((receipt) => receipt.read());
          diagnostic.atReleaseNative = await snapshot(application, surfaces.pill.id);
          gesture.child.stdin.end("\n");
          resolve();
        } catch (error) {
          gesture.child.stdin.end("\n");
          reject(error);
        }
      }),
    );
    const [{ stdout }] = await Promise.all([gesture, released]);
    diagnostic.gesture = JSON.parse(stdout);
    diagnostic.after = await selectionReceipt.evaluate((receipt) => receipt.read());
    diagnostic.afterNative = await snapshot(application, surfaces.pill.id);
    NodeAssert.equal(
      diagnostic.pointerup?.target?.isAnswer,
      true,
      "The textarea receives native pointer release",
    );
    NodeAssert.equal(
      diagnostic.after.value,
      diagnostic.before.value,
      "The mouse-only selection gesture preserves the fixture answer",
    );
    NodeAssert.equal(
      diagnostic.after.selectionStart !== diagnostic.after.selectionEnd,
      true,
      "Dragging over answer text selects text",
    );
    NodeAssert.deepEqual(
      diagnostic.afterNative.bounds,
      selectionWindow.bounds,
      "Selecting answer text does not drag the native pill",
    );
  } catch (error) {
    diagnostic.error = String(error);
    diagnostic.after = await selectionReceipt
      ?.evaluate((receipt) => receipt.read())
      .catch(() => null);
    diagnostic.afterNative = await snapshot(application, surfaces.pill.id).catch(() => null);
    const screenshot = NodePath.join(artifactsRoot, "action-wing-text-selection-failure.png");
    await surfaces.pill.page.screenshot({ path: screenshot }).then(
      () => report.screenshots.push(screenshot),
      () => undefined,
    );
    report.failureDiagnostics.push(diagnostic);
    console.error(`[satellite-smoke] Selection failure evidence: ${reportPath}`);
    throw error;
  } finally {
    await selectionReceipt?.evaluate((receipt) => receipt.dispose());
    await selectionReceipt?.dispose();
  }
  report.checks.push(
    "Native answer text selection receives pointer release and preserves the pill bounds.",
  );
  stage("Checking native transparent-gap click-through and collapse");
  const layout = await readWingLayout(surfaces, "panel");
  const panelAbove = layout.panel.y < layout.pill.y;
  const gap = {
    x:
      Math.max(layout.panel.x, layout.pill.x) + Math.min(layout.pill.width, layout.panel.width) / 2,
    y: panelAbove
      ? (layout.panel.y + layout.panel.height + layout.pill.y) / 2
      : (layout.pill.y + layout.pill.height + layout.panel.y) / 2,
  };
  const reopenTrace = await traceWingReopen(application, surfaces);
  const reopenDiagnostic = { kind: "action-wing-gap-reopen" };
  let reopenedGeometry;
  try {
    await clickWingGap(application, surfaces, gap);
    report.checks.push(
      "A physical gap click reaches a separate owned window and collapses the native panel.",
    );
    await surfaces.pill.page
      .locator('[data-satellite="action-panel"]')
      .waitFor({ state: "detached" });
    const closedWing = surfaces.pill.page.locator(
      '[data-satellite="action-wing"][aria-expanded="false"]',
    );
    await closedWing.waitFor();
    reopenDiagnostic.beforeNative = await snapshot(application, surfaces.pill.id);
    await surfaces.pill.page.evaluate(() =>
      window.satelliteSmokeReopenTrace.record("before-reopen-click"),
    );
    await closedWing.click();
    await surfaces.pill.page.evaluate(() =>
      window.satelliteSmokeReopenTrace.record("after-reopen-click"),
    );
    await surfaces.pill.page
      .locator('[data-satellite="action-wing"][aria-expanded="true"]')
      .waitFor();
    await surfaces.pill.page.locator('[data-satellite="action-panel"]').waitFor();
    reopenedGeometry = await waitForPillGeometry(surfaces, diagnostic.geometry.layout);
    report.checks.push(
      "The action wing reopens after native gap-click collapse with its settled question geometry.",
    );
  } catch (error) {
    reopenDiagnostic.error = String(error);
    const screenshot = NodePath.join(artifactsRoot, "action-wing-gap-reopen-failure.png");
    await surfaces.pill.page.screenshot({ path: screenshot }).then(
      () => report.screenshots.push(screenshot),
      () => undefined,
    );
    report.failureDiagnostics.push({
      kind: reopenDiagnostic.kind,
      error: reopenDiagnostic.error,
      trace: "wingReopen",
    });
    throw error;
  } finally {
    reopenDiagnostic.renderer = await surfaces.pill.page.evaluate(() =>
      window.satelliteSmokeReopenTrace.read(),
    );
    reopenDiagnostic.nativeEvents = await reopenTrace.evaluate((trace) => trace.events);
    reopenDiagnostic.afterNative = await snapshot(application, surfaces.pill.id);
    report.wingReopen = reopenDiagnostic;
    console.log(
      "[satellite-smoke] Wing reopen",
      JSON.stringify({
        outcome: reopenDiagnostic.error ? "failed" : "passed",
        nativeEvents: reopenDiagnostic.nativeEvents.length,
        layoutRequests: reopenDiagnostic.nativeEvents.filter(
          (event) => event.event === "layout-request",
        ).length,
        rendererEvents: reopenDiagnostic.renderer.events.length,
        reportPath,
      }),
    );
    await surfaces.pill.page.evaluate(() => window.satelliteSmokeReopenTrace.dispose());
    await reopenTrace.evaluate((trace) => trace.dispose());
    await reopenTrace.dispose();
  }
  stage("Checking native expanded-panel edge dragging");
  const beforeDrag = await snapshot(application, surfaces.pill.id);
  const beforeDragLayout = reopenedGeometry.layout;
  const target = await application.evaluate(
    ({ screen }, { bounds, layout }) => {
      const area = screen.getDisplayMatching(bounds).workArea;
      const anchor = { x: bounds.x + layout.pill.x, y: bounds.y + layout.pill.y };
      return screen.dipToScreenPoint({
        x: anchor.x < area.x + area.width / 2 ? area.x + area.width - 190 : area.x + 180,
        y: anchor.y < area.y + area.height / 2 ? area.y + area.height - 50 : area.y + 50,
      });
    },
    { bounds: beforeDrag.bounds, layout: beforeDragLayout },
  );
  await dragPill(application, surfaces, "pill-content", {
    end: target,
    steps: 60,
    delay: 5,
    expectedLayout: beforeDragLayout,
  });
  await surfaces.pill.page.waitForFunction(
    (previous) => window.satelliteSmokeLayout?.pill.y !== previous.pill.y,
    beforeDragLayout,
  );
  const afterGeometry = await waitForPillGeometry(surfaces);
  const afterDrag = await snapshot(application, surfaces.pill.id);
  const areas = await application.evaluate(
    ({ BrowserWindow, screen }, { bounds, id }) => {
      const workArea = screen.getDisplayMatching(bounds).workArea;
      return {
        workArea,
        physicalWorkArea: screen.dipToScreenRect(BrowserWindow.fromId(id), workArea),
      };
    },
    { bounds: afterDrag.bounds, id: surfaces.pill.id },
  );
  const controls = await surfaces.pill.page.evaluate(() =>
    Object.fromEntries(
      [
        ["pill", "pill"],
        ["wing", "action-wing"],
        ["panel", "action-panel"],
      ].map(([name, selector]) => [
        name,
        document.querySelector(`[data-satellite="${selector}"]`)?.getBoundingClientRect().toJSON(),
      ]),
    ),
  );
  const region = await nativeRegion(application, surfaces.pill.id, {});
  report.wingEdgeDrag = { native: afterDrag, geometry: afterGeometry, ...areas, controls, region };
  for (const [name, rect] of Object.entries(controls)) {
    NodeAssert.ok(rect, `The released ${name} remains visible`);
    for (const key of ["x", "y", "width", "height"])
      NodeAssert.ok(
        Math.abs(rect[key] - afterGeometry.layout[name][key]) <= 0.5,
        `The released ${name} matches its native layout`,
      );
  }
  const physicalArea = areas.physicalWorkArea;
  NodeAssert.equal(region.kind, 3, "The released window retains its interactive shape");
  NodeAssert.ok(
    afterDrag.physical.x + region.bounds.x >= physicalArea.x &&
      afterDrag.physical.y + region.bounds.y >= physicalArea.y &&
      afterDrag.physical.x + region.bounds.x + region.bounds.width <=
        physicalArea.x + physicalArea.width &&
      afterDrag.physical.y + region.bounds.y + region.bounds.height <=
        physicalArea.y + physicalArea.height,
    "All active native regions fit inside the physical monitor work area",
  );
  NodeAssert.ok(
    afterDrag.physical.x >= physicalArea.x - 1 &&
      afterDrag.physical.y >= physicalArea.y - 1 &&
      afterDrag.physical.x + afterDrag.physical.width <= physicalArea.x + physicalArea.width + 1 &&
      afterDrag.physical.y + afterDrag.physical.height <= physicalArea.y + physicalArea.height + 1,
    "The enclosing native frame fits apart from at most one outward physical pixel",
  );
  report.checks.push("Edge dragging reflows the expanded panel inside the monitor work area.");
}

async function verifyActionWing(application, surfaces) {
  await installWingFixture(application, surfaces);
  try {
    await surfaces.pill.page.locator('[data-satellite="action-wing"]').click();
    await surfaces.pill.page.locator('[data-satellite="action-panel"]').waitFor();
    await surfaces.pill.page
      .locator('[data-satellite="action-panel"] textarea')
      .fill("Native selection remains editable.");
    const layout = await readWingLayout(surfaces, "panel");
    NodeAssert.equal(await surfaces.pill.page.locator('[data-satellite="pill-menu"]').count(), 0);
    NodeAssert.equal(
      layout.wing.x,
      layout.pill.x + layout.pill.width,
      "The wing stays on the right",
    );
    NodeAssert.ok(
      layout.panel && layout.wing,
      "The native layout includes a panel and an attached wing",
    );
    const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    const gap = {
      x:
        Math.max(layout.panel.x, layout.pill.x) +
        Math.min(layout.pill.width, layout.panel.width) / 2,
      y:
        layout.panel.y < layout.pill.y
          ? (layout.panel.y + layout.panel.height + layout.pill.y) / 2
          : (layout.pill.y + layout.pill.height + layout.panel.y) / 2,
    };
    const shape = await nativeRegion(application, surfaces.pill.id, {
      pill: center(layout.pill),
      wing: center(layout.wing),
      panel: center(layout.panel),
      gap,
    });
    NodeAssert.equal(shape.kind, 3, "The native window has a nonrectangular region");
    NodeAssert.deepEqual(shape.contains, { pill: true, wing: true, panel: true, gap: false });
    const before = await snapshot(application, surfaces.pill.id);
    await surfaces.pill.page.keyboard.press("Escape");
    const compact = await readWingLayout(surfaces, "compact");
    const after = await snapshot(application, surfaces.pill.id);
    NodeAssert.deepEqual(
      after.bounds,
      before.bounds,
      "Closing keeps the native window frame stable",
    );
    NodeAssert.deepEqual(compact.pill, layout.pill, "Closing keeps the rendered pill in place");
    NodeAssert.deepEqual(compact.wing, layout.wing, "Closing keeps the wing in place");
    NodeAssert.deepEqual(
      (
        await nativeRegion(application, surfaces.pill.id, {
          pill: center(layout.pill),
          wing: center(layout.wing),
          panel: center(layout.panel),
          gap,
        })
      ).contains,
      { pill: true, wing: true, panel: false, gap: false },
      "The hidden panel and gap are outside the compact native input region",
    );
    NodeAssert.deepEqual(
      { x: before.bounds.x + layout.pill.x, y: before.bounds.y + layout.pill.y },
      { x: after.bounds.x + compact.pill.x, y: after.bounds.y + compact.pill.y },
      "Escape preserves the compact pill's screen position",
    );
    await surfaces.pill.page.locator('[data-satellite="action-wing"]').click();
    const reopened = await readWingLayout(surfaces, "panel");
    NodeAssert.equal(reopened.panel.width, layout.panel.width);
    NodeAssert.deepEqual((await snapshot(application, surfaces.pill.id)).bounds, before.bounds);
    const questionState = await application.evaluate(() => globalThis.satelliteSmokeWing.state);
    await application.evaluate(() => {
      const fixture = globalThis.satelliteSmokeWing;
      const ref = {
        ...fixture.state.actionWing.items[0].ref,
        kind: "approval",
        requestId: "fixture-approval",
      };
      const createdAt = "2026-10-05T12:00:00.000Z";
      fixture.state.actionWing.items = [
        {
          ...fixture.state.actionWing.items[0],
          ref,
          label: "Approval",
          preview: "Approve the native fixture",
        },
      ];
      fixture.state.actionWing.selected = {
        ref,
        status: "ready",
        delivery: "editing",
        questionIndex: 0,
        answers: {},
        approval: {
          requestId: ref.requestId,
          createdAt,
          requestKind: "command",
          detail: "Native fixture command. No provider receives this request.",
          options: [
            { decision: "accept", label: "Approve fixture" },
            { decision: "decline", label: "Decline fixture" },
            { decision: "acceptForSession", label: "Allow fixture this session" },
          ],
        },
      };
      fixture.publish();
    });
    await surfaces.pill.page.getByRole("button", { name: "More approval options" }).click();
    const menuItem = surfaces.pill.page.getByRole("menuitem", {
      name: "Allow fixture this session",
    });
    const menuBox = await menuItem.boundingBox();
    const menuLayout = await readWingLayout(surfaces, "panel");
    NodeAssert.ok(
      menuBox &&
        menuBox.x >= menuLayout.panel.x &&
        menuBox.y >= menuLayout.panel.y &&
        menuBox.x + menuBox.width <= menuLayout.panel.x + menuLayout.panel.width &&
        menuBox.y + menuBox.height <= menuLayout.panel.y + menuLayout.panel.height,
      "Approval menu portals remain inside the interactive panel",
    );
    const menuShape = await nativeRegion(application, surfaces.pill.id, {
      approval: center(menuBox),
    });
    NodeAssert.equal(
      menuShape.contains.approval,
      true,
      "The native region includes the approval menu",
    );
    await surfaces.pill.page.keyboard.press("Escape");
    const path = NodePath.join(artifactsRoot, "action-wing-panel.png");
    await surfaces.pill.page.screenshot({ path });
    report.screenshots.push(path);
    report.checks.push(
      "Rendered question and approval panels fit their native layout. The native region contains controls and approval portals and excludes the gap. Escape preserves the compact anchor.",
    );
    if (nativePointer) {
      await application.evaluate((_, state) => {
        globalThis.satelliteSmokeWing.state = state;
        globalThis.satelliteSmokeWing.publish();
      }, questionState);
      await surfaces.pill.page.locator('[data-satellite="action-panel"] textarea').waitFor();
      await verifyWingPointer(application, surfaces);
    }
  } finally {
    await surfaces.pill.page.evaluate(() => {
      window.satelliteSmokeLayoutDispose?.();
      window.satellitePillBridge.setLayout({ mode: "compact", wing: false });
    });
    await application.evaluate(() => globalThis.satelliteSmokeWing.dispose());
    await surfaces.main.page.evaluate(() =>
      window.satelliteBridge.publish({
        threadId: null,
        environmentId: null,
        title: "DEVELOPMENT FIXTURE",
        state: "idle",
        detail: "Native movement regression",
        attention: false,
      }),
    );
    await surfaces.pill.page
      .locator('[data-satellite="action-wing"]')
      .waitFor({ state: "detached" });
    await surfaces.pill.page.waitForFunction(
      () => window.innerWidth === 252 && window.innerHeight === 56,
    );
  }
}

async function waitMode(surfaces, mode, timeout = 30000) {
  await surfaces.main.page.waitForFunction(
    (mode) => document.querySelector('[data-satellite="shell"]')?.dataset.mode === mode,
    mode,
    { timeout },
  );
}

async function expand(application, surfaces) {
  if (nativePointer) {
    await focusOwnedWindow(application, surfaces.pill.id);
    const native = await snapshot(application, surfaces.pill.id);
    const box = await surfaces.pill.page
      .getByRole("button", { name: "Expand SatelliteT3", exact: true })
      .boundingBox();
    const x = Math.round(native.physical.x + ((box.x + box.width / 2) * native.dpi) / 96);
    const y = Math.round(native.physical.y + ((box.y + box.height / 2) * native.dpi) / 96);
    const pressReceipt = await armPillPointer(surfaces.pill.page, "pill-content");
    await nativeClick(
      native,
      { x, y },
      () => waitMode(surfaces, "workspace", 4000),
      "expand-workspace",
      pressReceipt,
    );
  } else {
    await surfaces.pill.page.evaluate(() => window.satellitePillBridge.openMain());
  }
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

async function armPillPointer(page, target) {
  return page.evaluateHandle((target) => {
    const targetNode = document.querySelector(`[data-satellite="${target}"]`);
    const events = [];
    let pressed;
    let timeout;
    const done = new Promise((resolve) => {
      pressed = resolve;
    });
    const observe = (event) => {
      if (event.type.startsWith("key") && !["Enter", " ", "Escape"].includes(event.key)) return;
      const pointerTarget = event.target instanceof Element ? event.target : null;
      const sample = {
        time: Date.now(),
        type: event.type,
        target: pointerTarget?.closest("[data-satellite]")?.getAttribute("data-satellite") ?? null,
        targetMatched: !!targetNode && !!pointerTarget && targetNode.contains(pointerTarget),
        button: event.button,
        buttons: event.buttons,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        detail: event.detail,
        key: event.key,
        code: event.code,
        repeat: event.repeat,
        trusted: event.isTrusted,
        focused: document.hasFocus(),
      };
      events.push(sample);
      if (events.length > 64) events.splice(16, 1);
      if (event.type === "pointerdown")
        queueMicrotask(() =>
          pressed({
            ...sample,
            captured: targetNode?.hasPointerCapture(event.pointerId) ?? false,
          }),
        );
    };
    const names = [
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
      "gotpointercapture",
      "lostpointercapture",
      "click",
      "keydown",
      "keyup",
    ];
    for (const name of names) document.addEventListener(name, observe, true);
    return {
      wait: () =>
        Promise.race([
          done,
          new Promise((resolve) => {
            timeout = setTimeout(() => resolve(null), 4000);
          }),
        ]),
      events,
      dispose: () => {
        clearTimeout(timeout);
        for (const name of names) document.removeEventListener(name, observe, true);
      },
    };
  }, target);
}

async function acknowledgePointerDown(pressReceipt, gesture) {
  NodeAssert.ok(pressReceipt, "Only a pill gesture requests a renderer press receipt");
  const pointerdown = await pressReceipt.evaluate((receipt) => receipt.wait());
  NodeAssert.ok(
    pointerdown,
    "The pill renderer must receive pointerdown before movement or release",
  );
  NodeAssert.equal(
    pointerdown.targetMatched,
    true,
    "Native pointerdown reaches the intended pill region",
  );
  NodeAssert.equal(pointerdown.trusted, true, "The pointerdown receipt comes from native input");
  NodeAssert.equal(pointerdown.buttons & 1, 1, "The renderer sees the left button held");
  gesture.child.stdin.write("pressed\n");
  return pointerdown;
}

async function nativeClick(native, point, receive, kind, pressReceipt = null) {
  NodeAssert.ok(nativePointer, "Physical clicks are disabled by --no-native-pointer");
  const diagnostic = {
    kind,
    hwnd: native.hwnd,
    point,
    bounds: native.bounds,
    physical: native.physical,
    dpi: native.dpi,
  };
  const gesture = NodeUtil.promisify(NodeChildProcess.execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      NodePath.join(repoRoot, "scripts/satellite-drag-gesture.ps1"),
      "-OwnedHwnd",
      native.hwnd,
      "-StartX",
      String(Math.round(point.x)),
      "-StartY",
      String(Math.round(point.y)),
      "-EndX",
      String(Math.round(point.x)),
      "-EndY",
      String(Math.round(point.y)),
      ...(pressReceipt ? ["-WaitForPressAcknowledgement"] : []),
      "-WaitForReleaseAcknowledgement",
    ],
    { windowsHide: true, timeout: 30000 },
  );
  const output = NodeReadline.createInterface({ input: gesture.child.stdout });
  const released = (async () => {
    try {
      for await (const line of output) {
        if (line === "[satellite-drag-pressed]") {
          diagnostic.pointerdown = await acknowledgePointerDown(pressReceipt, gesture);
          continue;
        }
        JSON.parse(line);
        const received = await receive();
        diagnostic.outcome = "received";
        gesture.child.stdin.end("\n");
        return received;
      }
      await gesture;
      throw new Error("Native click did not publish its release receipt");
    } catch (error) {
      if (gesture.child.stdin.writable && !gesture.child.stdin.destroyed)
        gesture.child.stdin.end("cancel\n");
      throw error;
    }
  })();
  try {
    const [, received] = await Promise.all([gesture, released]);
    return received;
  } catch (error) {
    diagnostic.outcome = "failed";
    diagnostic.error = String(error);
    throw error;
  } finally {
    diagnostic.pointerEvents =
      (await pressReceipt?.evaluate((receipt) => receipt.events).catch(() => [])) ?? [];
    report.clicks.push(diagnostic);
    output.close();
    await pressReceipt?.evaluate((receipt) => receipt.dispose());
    await pressReceipt?.dispose();
  }
}

async function nativeGesture(application, surface, start, end, options = {}) {
  await focusOwnedWindow(application, surface.id);
  const before = await snapshot(application, surface.id);
  const pressReceipt = options.awaitPointerDown
    ? await armPillPointer(surface.page, options.target)
    : null;
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
      ...(pressReceipt ? ["-WaitForPressAcknowledgement"] : []),
      "-WaitForReleaseAcknowledgement",
    ],
    { windowsHide: true, timeout: 30000 },
  );
  let atRelease;
  let pointerdown;
  const output = NodeReadline.createInterface({ input: gesture.child.stdout });
  const released = (async () => {
    try {
      for await (const line of output) {
        if (line === "[satellite-drag-pressed]") {
          pointerdown = await acknowledgePointerDown(pressReceipt, gesture);
          continue;
        }
        const samples = JSON.parse(line);
        atRelease = await snapshot(application, surface.id);
        gesture.child.stdin.end("\n");
        return samples;
      }
      await gesture;
      throw new Error("Native gesture did not publish its release receipt");
    } catch (error) {
      if (gesture.child.stdin.writable && !gesture.child.stdin.destroyed)
        gesture.child.stdin.end("cancel\n");
      throw error;
    }
  })();
  try {
    const [, samples] = await Promise.all([gesture, released]);
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
      held: samples.samples,
      trace: await receipt.evaluate((r) => r.trace),
      pointerdown,
      pointerEvents: (await pressReceipt?.evaluate((receipt) => receipt.events)) ?? [],
    };
  } catch (error) {
    const guardLine = String(error.stderr ?? "")
      .split(/\r?\n/u)
      .find((line) => line.startsWith("[satellite-drag-guard] "));
    const summarizeNative = (value) => ({
      id: value.id,
      hwnd: value.hwnd,
      visible: value.visible,
      focused: value.focused,
      alwaysOnTop: value.alwaysOnTop,
      foregroundHwnd: value.foregroundHwnd,
      bounds: value.bounds,
      physical: value.physical,
      dpi: value.dpi,
      zoom: value.zoom,
      display: value.display,
    });
    const diagnostic = {
      stage: currentStage,
      target: options.target ?? "native-window",
      cssBoxBefore: options.cssBox ?? null,
      shellModeBefore: options.shellMode ?? null,
      start,
      end,
      nativeBefore: summarizeNative(before),
      guard: guardLine ? JSON.parse(guardLine.slice("[satellite-drag-guard] ".length)) : null,
      error: String(error.message).slice(0, 2000),
      pointerdown,
      pointerEvents:
        (await pressReceipt?.evaluate((receipt) => receipt.events).catch(() => [])) ?? [],
    };
    diagnostic.nativeAfter = await snapshot(application, surface.id).then(
      summarizeNative,
      (failure) => ({ unavailable: String(failure).slice(0, 500) }),
    );
    diagnostic.renderer = await surface.page
      .evaluate(
        ({ target, start, physical, dpi }) => {
          const describe = (element) => {
            if (!element) return null;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName,
              satellite: element.getAttribute("data-satellite"),
              state: element.getAttribute("data-state"),
              wingSide: element.getAttribute("data-wing-side"),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              background: style.backgroundColor,
              opacity: style.opacity,
              visibility: style.visibility,
              display: style.display,
              pointerEvents: style.pointerEvents,
              transform: style.transform,
            };
          };
          const local = {
            x: ((start.x - physical.x) * 96) / dpi,
            y: ((start.y - physical.y) * 96) / dpi,
          };
          return {
            documentVisible: document.visibilityState,
            documentFocused: document.hasFocus(),
            viewport: {
              width: innerWidth,
              height: innerHeight,
              devicePixelRatio,
              scale: visualViewport?.scale,
            },
            layout: window.satelliteSmokeObservedLayout ?? null,
            cssPointFromPhysical: local,
            cssHit: describe(document.elementFromPoint(local.x, local.y)),
            target: target
              ? describe(document.querySelector(`[data-satellite="${target}"]`))
              : null,
            pill: describe(document.querySelector('[data-satellite="pill"]')),
            wing: describe(document.querySelector('[data-satellite="action-wing"]')),
            panel: describe(document.querySelector('[data-satellite="action-panel"]')),
          };
        },
        { target: options.target, start, physical: before.physical, dpi: before.dpi },
      )
      .catch((failure) => ({ unavailable: String(failure).slice(0, 500) }));
    diagnostic.ownedWindows = await application
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          id: window.id,
          hwnd: window.getNativeWindowHandle().readBigUInt64LE().toString(),
          visible: window.isVisible(),
          focused: window.isFocused(),
          bounds: window.getBounds(),
        })),
      )
      .catch((failure) => ({ unavailable: String(failure).slice(0, 500) }));
    report.failureDiagnostics.push(diagnostic);
    const path = NodePath.join(
      artifactsRoot,
      `native-gesture-failure-${report.failureDiagnostics.length}.png`,
    );
    await surface.page.screenshot({ path, timeout: 5000 }).then(
      () => report.screenshots.push(path),
      (failure) => {
        diagnostic.screenshotError = String(failure).slice(0, 500);
      },
    );
    console.error(`[satellite-smoke] Native gesture failure evidence: ${reportPath}`);
    throw error;
  } finally {
    output.close();
    await pressReceipt?.evaluate((receipt) => receipt.dispose());
    await pressReceipt?.dispose();
    await receipt.evaluate((r) => r.dispose());
    await receipt.dispose();
  }
}

async function dragPill(application, surfaces, target, options = {}) {
  NodeAssert.ok(nativePointer, "Physical pill dragging is disabled by --no-native-pointer");
  const pill = surfaces.pill;
  await pill.page.bringToFront();
  const rendering = await waitForPillGeometry(surfaces, options.expectedLayout);
  const before = await snapshot(application, pill.id);
  const canonicalSize = rendering.layout ?? rendering.viewport;
  const box = await pill.page.locator(`[data-satellite="${target}"]`).boundingBox();
  const start = {
    x: before.physical.x + ((box.x + (target === "pill" ? 4 : box.width / 2)) * before.dpi) / 96,
    y: before.physical.y + ((box.y + box.height / 2) * before.dpi) / 96,
  };
  const end = options.end ?? { x: start.x - 120, y: start.y - 45 };
  const shellMode = await surfaces.main.page.evaluate(
    () => document.querySelector('[data-satellite="shell"]')?.dataset.mode,
  );
  const result = await nativeGesture(application, pill, start, end, {
    ...options,
    target,
    cssBox: box,
    shellMode,
    awaitPointerDown: true,
  });
  report.drags.push({
    target,
    cssBox: box,
    logicalBounds: before.bounds,
    rendering,
    held: result.held,
    before: result.before.physical,
    after: result.after.physical,
    pointerdown: result.pointerdown,
    pointerEvents: result.pointerEvents,
  });
  NodeAssert.ok(
    Math.abs(result.after.physical.x - before.physical.x) > 40,
    "Pill must follow the native drag",
  );
  for (const sample of result.held) {
    NodeAssert.ok(
      Math.abs(sample.width - (canonicalSize.width * sample.dpi) / 96) <= 1,
      `Held pill width must follow native DPI without accumulating drift: ${JSON.stringify({ target, logicalBounds: before.bounds, rendering, cssBox: box, sample })}`,
    );
    NodeAssert.ok(
      Math.abs(sample.height - (canonicalSize.height * sample.dpi) / 96) <= 1,
      `Held pill height must follow native DPI without accumulating drift: ${JSON.stringify({ target, logicalBounds: before.bounds, rendering, cssBox: box, sample })}`,
    );
  }
  await waitMode(surfaces, "pill");
  NodeAssert.equal(
    (await snapshot(application, surfaces.main.id)).visible,
    false,
    "Drag must not open the workspace",
  );
}

async function clickOutside(application) {
  NodeAssert.ok(nativePointer, "Physical outside clicks are disabled by --no-native-pointer");
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
      'data:text/html,<body style="background:%2317382d;color:white">Satellite focus test<script>window.receivedClick=new Promise(resolve=>addEventListener("click",()=>resolve(true),{once:true}))</script></body>',
    );
    fixture.show();
    fixture.focus();
    return fixture.id;
  });
  await focusOwnedWindow(application, id);
  const fixture = await snapshot(application, id);
  const x = fixture.physical.x + fixture.physical.width / 2;
  const y = fixture.physical.y + fixture.physical.height / 2;
  const received = await nativeClick(
    fixture,
    { x, y },
    () =>
      application.evaluate(
        ({ BrowserWindow }, id) =>
          BrowserWindow.fromId(id).webContents.executeJavaScript(
            'Promise.race([window.receivedClick,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Outside fixture did not receive its click")),4000))])',
          ),
        id,
      ),
    "outside-workspace",
  );
  NodeAssert.equal(received, true, "The outside fixture receives the native click");
  return () =>
    application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), id);
}

const report = {
  kind: "Isolated SatelliteT3 native regression. No live provider work.",
  status: "running",
  scope: actionWingOnly ? "action-wing" : "full",
  pointerMode: nativePointer ? "native" : "disabled",
  skippedChecks: nativePointer
    ? []
    : [
        "Physical pill dragging, busy-renderer dragging, and held-size checks.",
        "Physical mixed-DPI movement of the pill and workspace.",
        "Physical text selection, transparent-gap click-through, and panel edge dragging.",
        "Physical expansion clicks and outside-click collapse or pin retention.",
        "Physical resizing from the workspace's eight edges and corners.",
      ],
  checks: [],
  drags: [],
  clicks: [],
  resizes: [],
  screenshots: [],
  failureDiagnostics: [],
};
if (actionWingOnly)
  report.skippedChecks.push(
    "Out of scope: compact pill drag, busy renderer, mixed-DPI movement, and status/click-away baseline.",
    "Out of scope: workspace resize, zoom, pin, close/minimize, and restart persistence.",
  );
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
  await verifySeededCoordinator(application, surfaces);
  await installQuietPill(application, surfaces);
  await collapse(application, surfaces);
  await application.evaluate(({ BrowserWindow, screen }, id) => {
    const a = screen.getPrimaryDisplay().workArea;
    BrowserWindow.fromId(id).setBounds({ x: a.x + 700, y: a.y + 500, width: 252, height: 56 });
  }, surfaces.pill.id);
  if (nativePointer && !actionWingOnly) {
    stage("Dragging content and padding with the native pointer");
    for (const target of ["pill-content", "pill"]) await dragPill(application, surfaces, target);
    stage("Dragging while the pill renderer is busy");
    await dragPill(application, surfaces, "pill-content", {
      stallRenderer: true,
      steps: 50,
      delay: 20,
    });
    report.checks.push(
      "Native drag from every pill region survives renderer work and cursor movement after release.",
    );
  }
  const displays = await application.evaluate(({ screen }) =>
    screen.getAllDisplays().map((d) => ({ id: d.id, scale: d.scaleFactor, workArea: d.workArea })),
  );
  const primary = displays.find((d) => d.id === initial.display) ?? displays[0];
  const other = displays.find((d) => d.scale !== primary.scale);
  if (nativePointer && !actionWingOnly && other) {
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
      "Mixed-DPI round trip keeps 252 by 56 logical pixels throughout held movement.",
    );
  } else if (nativePointer && !actionWingOnly)
    report.skippedChecks.push("Mixed-DPI test: only one scale is connected.");
  if (!actionWingOnly) {
    stage(
      nativePointer
        ? "Checking status updates and repeated click-away reopening"
        : "Checking status updates and workspace bridge transitions",
    );
    await expand(application, surfaces);
    if (nativePointer) {
      const closeFixture = await clickOutside(application);
      await waitMode(surfaces, "pill");
      await closeFixture();
    } else {
      await collapse(application, surfaces);
    }
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
    if (nativePointer) await dragPill(application, surfaces, "pill-content");
    report.checks.push(
      nativePointer
        ? "Click-away collapse, background scrolling, status updates and immediate drag leave a responsive pill."
        : "Background scrolling and status updates preserve workspace bridge expansion and collapse.",
    );
  }
  stage(
    nativePointer
      ? "Checking action wing geometry, native shape and transparent gap click-through"
      : "Checking rendered action wing geometry, native shape and approval portals",
  );
  await verifyActionWing(application, surfaces);
  if (!actionWingOnly) {
    stage(
      nativePointer
        ? "Checking native resize from all eight edges and corners"
        : "Checking workspace dimensions across bridge transitions",
    );
    await expand(application, surfaces);
    await surfaces.main.page.evaluate(() => window.satelliteBridge.setPinned(true));
    if (nativePointer)
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
    if (nativePointer && other) {
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
      "Reopening restores the workspace dimensions",
    );
    report.checks.push(
      nativePointer
        ? "All eight resize edges and corners work. User dimensions survive collapse and reopen."
        : "Workspace dimensions survive bridge collapse and reopen.",
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
    const pinnedControl = surfaces.main.page.getByRole("button", {
      name: "Unpin workspace",
      exact: true,
    });
    await pinnedControl.waitFor();
    NodeAssert.equal(await pinnedControl.getAttribute("aria-pressed"), "true");
    if (nativePointer) {
      const closePinned = await clickOutside(application);
      await waitMode(surfaces, "workspace");
      await closePinned();
      await surfaces.main.page.bringToFront();
    }
    await surfaces.main.page.evaluate(() => window.satelliteBridge.setPinned(false));
    const unpinnedControl = surfaces.main.page.getByRole("button", {
      name: "Keep workspace open",
      exact: true,
    });
    await unpinnedControl.waitFor();
    NodeAssert.equal(await unpinnedControl.getAttribute("aria-pressed"), "false");
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
        (node) =>
          node.isConnected && node === document.querySelector('[data-satellite="workspace"]'),
      ),
      true,
    );
    report.checks.push(
      nativePointer
        ? "Workspace zoom leaves the pill unchanged. Pin, native close and minimize preserve the mounted workspace."
        : "Workspace zoom leaves the pill unchanged. Pin state reaches the renderer; native close and minimize preserve the mounted workspace.",
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
    await installQuietPill(application, surfaces);
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
  }
  report.status = nativePointer ? (actionWingOnly ? "scoped-passed" : "passed") : "partial";
  console.log(
    actionWingOnly
      ? nativePointer
        ? "SCOPED PASS Satellite real coordinator and native action-wing checks; full regression not run"
        : "SCOPED PARTIAL Satellite real coordinator and rendered action-wing checks; physical-pointer and full regression checks not run"
      : nativePointer
        ? "PASS Satellite native drag, DPI, resize and lifecycle regression"
        : "PARTIAL Satellite rendered UI, IPC, native region and lifecycle checks passed; physical-pointer checks skipped",
  );
} catch (error) {
  report.status = "failed";
  report.error = { stage: currentStage, message: String(error) };
  console.error(`[satellite-smoke] Failed at ${currentStage}`, error);
  if (application) {
    report.windowEvents = await application
      .evaluate(() => globalThis.satelliteSmokeEvents.slice(-120))
      .catch(() => null);
    report.windows = await application
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => ({
          id: w.id,
          url: w.webContents.getURL(),
          visible: w.isVisible(),
          bounds: w.getBounds(),
        })),
      )
      .catch(() => null);
  }
  process.exitCode = 1;
} finally {
  await NodeFSP.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(
    "[satellite-smoke] Report",
    JSON.stringify({
      status: report.status,
      scope: report.scope,
      pointerMode: report.pointerMode,
      checks: report.checks.length,
      skippedChecks: report.skippedChecks.length,
      drags: report.drags.length,
      resizes: report.resizes.length,
      reportPath,
    }),
  );
  if (application) {
    await application
      .evaluate(() => globalThis.satelliteSmokeQuiet?.dispose())
      .catch(() => undefined);
    if (!keepRunning) await application.close();
  }
}
