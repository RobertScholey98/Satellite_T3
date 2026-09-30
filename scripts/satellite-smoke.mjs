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

async function findShell(application) {
  const identity = await application.evaluate(async ({ app, BrowserWindow }) => {
    return new Promise((resolve, reject) => {
      const observed = new Set();
      const cleanup = () => {
        clearTimeout(timeout);
        app.removeListener("browser-window-created", observe);
        for (const window of observed) {
          if (!window.isDestroyed()) window.webContents.removeListener("did-finish-load", check);
        }
      };
      const check = () => {
        const main = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().startsWith("t3code://"),
        );
        if (main) {
          cleanup();
          resolve({ id: main.id, webContentsId: main.webContents.id });
        }
      };
      const observe = (_event, window) => {
        observed.add(window);
        window.webContents.on("did-finish-load", check);
        check();
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Satellite shell did not load within 60 seconds"));
      }, 60_000);
      app.on("browser-window-created", observe);
      for (const window of BrowserWindow.getAllWindows()) observe(null, window);
    });
  });
  const predicate = (page) => page.url().startsWith("t3code://");
  const page =
    application.windows().find(predicate) ??
    (await application.waitForEvent("window", { predicate, timeout: 30_000 }));
  await page.waitForFunction(() => typeof window.satelliteBridge?.publish === "function");
  await waitSettled(page, "pill");
  return { ...identity, page };
}

async function waitSettled(page, mode) {
  await page
    .locator(`[data-satellite="shell"][data-mode="${mode}"][data-phase="settled"]`)
    .waitFor();
}

async function nativeSnapshot(application, shell) {
  return application.evaluate(({ BrowserWindow, app, screen }, id) => {
    const main = BrowserWindow.fromId(id);
    if (!main) throw new Error("Satellite shell was destroyed");
    const preferences = main.webContents.getLastWebPreferences();
    return {
      id: main.id,
      webContentsId: main.webContents.id,
      windowIds: BrowserWindow.getAllWindows().map((window) => window.id),
      visible: main.isVisible(),
      minimized: main.isMinimized(),
      alwaysOnTop: main.isAlwaysOnTop(),
      resizable: main.isResizable(),
      zoomFactor: main.webContents.getZoomFactor(),
      bounds: main.getBounds(),
      contentBounds: main.getContentBounds(),
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      sandbox: preferences.sandbox,
      nativeHandle: main.getNativeWindowHandle().readBigUInt64LE().toString(),
      displayScale: screen.getDisplayMatching(main.getBounds()).scaleFactor,
      userData: app.getPath("userData"),
      workAreas: screen.getAllDisplays().map((display) => display.workArea),
    };
  }, shell.id);
}

function assertSameShell(snapshot, initial) {
  NodeAssert.equal(snapshot.id, initial.id);
  NodeAssert.equal(snapshot.webContentsId, initial.webContentsId);
  NodeAssert.equal(snapshot.visible, true);
  NodeAssert.equal(snapshot.alwaysOnTop, true);
}

async function assertCollapsed(application, shell, initial) {
  await waitSettled(shell.page, "pill");
  const snapshot = await nativeSnapshot(application, shell);
  assertSameShell(snapshot, initial);
  NodeAssert.equal(snapshot.resizable, false);
  NodeAssert.equal(snapshot.minimized, false);
  NodeAssert.equal(snapshot.bounds.width, initial.bounds.width);
  NodeAssert.equal(snapshot.bounds.height, initial.bounds.height);
  const visiblePill = await shell.page.locator('[data-satellite="shell-surface"]').boundingBox();
  NodeAssert.equal(visiblePill?.width, 320);
  NodeAssert.equal(visiblePill?.height, 70);
  NodeAssert.equal(
    await shell.page.locator('[data-satellite="workspace"]').evaluate((node) => node.inert),
    true,
  );
  return snapshot;
}

async function pillPosition(application, shell) {
  const native = await nativeSnapshot(application, shell);
  const surface = await shell.page.locator('[data-satellite="shell-surface"]').boundingBox();
  return {
    x: Math.round(native.contentBounds.x + surface.x * native.zoomFactor),
    y: Math.round(native.contentBounds.y + surface.y * native.zoomFactor),
  };
}

async function assertNativePillRegion(application, shell) {
  const native = await nativeSnapshot(application, shell);
  const surface = await shell.page.locator('[data-satellite="shell-surface"]').boundingBox();
  const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      NodePath.join(repoRoot, "scripts", "satellite-window-region.ps1"),
      "-OwnedHwnd",
      native.nativeHandle,
    ],
    { windowsHide: true, timeout: 30_000 },
  );
  const region = JSON.parse(stdout.trim());
  NodeAssert.ok(region.regionType >= 2, "Collapsed canvas must have a native input/drawing region");
  const scale = native.zoomFactor * native.displayScale;
  for (const key of ["x", "y", "width", "height"]) {
    NodeAssert.ok(
      Math.abs(region.bounds[key] - surface[key] * scale) <= 2,
      `Native ${key} must clip to the visible pill; transparent workspace must pass clicks through`,
    );
  }
  // Electron can suppress its taskbar tab through ITaskbarList without changing
  // these style bits. Record them as diagnostics, not as a taskbar-state getter.
  report.nativeRegion = region;
}

async function dragPill(application, shell, target) {
  await shell.page.bringToFront();
  await shell.page.keyboard.press("Tab");
  const content = shell.page.locator('[data-satellite="pill-content"]');
  await content.focus();
  NodeAssert.equal(
    await content.evaluate((node) => getComputedStyle(node).outlineStyle),
    "solid",
    "Keyboard navigation must retain a visible focus outline",
  );
  const pointerFocus = await shell.page.evaluateHandle(() => {
    const pill = document.querySelector('[data-satellite="pill"]');
    const completed = new Promise((resolve) => {
      pill.addEventListener(
        "pointerdown",
        () =>
          requestAnimationFrame(() => {
            resolve(
              Array.from(pill.querySelectorAll("button")).map(
                (button) => getComputedStyle(button).outlineStyle,
              ),
            );
          }),
        { once: true },
      );
    });
    return { completed };
  });
  const before = await nativeSnapshot(application, shell);
  const position = await pillPosition(application, shell);
  const box = await shell.page.locator(`[data-satellite="${target}"]`).boundingBox();
  const start = {
    x: Math.round(
      before.contentBounds.x +
        (box.x + (target === "pill" ? 4 : box.width / 2)) * before.zoomFactor,
    ),
    y: Math.round(before.contentBounds.y + (box.y + box.height / 2) * before.zoomFactor),
  };
  const points = await application.evaluate(({ screen }, start) => {
    const area = screen.getDisplayNearestPoint(start).workArea;
    const dx = start.x < area.x + area.width / 2 ? 120 : -120;
    const dy = start.y < area.y + area.height / 2 ? 40 : -40;
    return {
      start: screen.dipToScreenPoint(start),
      end: screen.dipToScreenPoint({ x: start.x + dx, y: start.y + dy }),
      dx,
      dy,
    };
  }, start);
  const receipt = await application.evaluateHandle(({ ipcMain }, id) => {
    const counts = { begin: 0, update: 0, end: 0, open: 0, menu: 0 };
    let release;
    const completed = new Promise((resolve) => {
      release = resolve;
    });
    const listeners = Object.keys(counts).map((name) => {
      const channel =
        name === "open" || name === "menu"
          ? `satellite:pill-${name}`
          : `satellite:pill-drag-${name}`;
      const listener = (event) => {
        if (event.sender.id !== id) return;
        counts[name]++;
        if (name === "end") release(true);
      };
      ipcMain.on(channel, listener);
      return { channel, listener };
    });
    const timeout = setTimeout(() => release(false), 10_000);
    return {
      completed,
      counts,
      dispose: () => {
        clearTimeout(timeout);
        for (const { channel, listener } of listeners) ipcMain.removeListener(channel, listener);
      },
    };
  }, shell.webContentsId);
  const gesture = NodeUtil.promisify(NodeChildProcess.execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      NodePath.join(repoRoot, "scripts", "satellite-drag-gesture.ps1"),
      "-OwnedHwnd",
      before.nativeHandle,
      "-StartX",
      String(points.start.x),
      "-StartY",
      String(points.start.y),
      "-EndX",
      String(points.end.x),
      "-EndY",
      String(points.end.y),
      "-WaitForReleaseAcknowledgement",
    ],
    { windowsHide: true, timeout: 30_000 },
  );
  const acknowledged = receipt
    .evaluate((handle) => handle.completed)
    .then(async (completed) => {
      gesture.child.stdin.end("\n");
      NodeAssert.ok(
        completed,
        `Dragging ${target} must reach native drag-end: ${JSON.stringify(await receipt.evaluate((handle) => handle.counts))}`,
      );
    });
  try {
    await Promise.all([gesture, acknowledged]);
    const outlines = await pointerFocus.evaluate((handle) => handle.completed);
    NodeAssert.ok(
      outlines.every((style) => style === "none"),
      "Mouse-down must not highlight the pill controls",
    );
    await shell.page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await waitSettled(shell.page, "pill");
    NodeAssert.equal(
      await content.evaluate((node) => getComputedStyle(node).outlineStyle),
      "none",
      "Drag release must keep the mouse focus outline hidden",
    );
    const counts = await receipt.evaluate((handle) => handle.counts);
    NodeAssert.equal(counts.begin, 1);
    NodeAssert.equal(counts.end, 1);
    NodeAssert.equal(counts.open, 0, "Releasing a content drag must not expand the workspace");
    NodeAssert.equal(counts.menu, 0, "Releasing a menu drag must not open the menu");
    const afterPosition = await pillPosition(application, shell);
    NodeAssert.ok(
      (afterPosition.x - position.x) * Math.sign(points.dx) > 60,
      "Pill must follow the native pointer horizontally",
    );
    NodeAssert.ok(
      (afterPosition.y - position.y) * Math.sign(points.dy) > 15,
      "Pill must follow the native pointer vertically",
    );
    const after = await nativeSnapshot(application, shell);
    assertSameShell(after, before);
    // Reanchoring at a new origin can round physical pixels to one extra DIP.
    // Expansion/collapse below still requires an entirely unchanged canvas.
    for (const dimension of ["width", "height"]) {
      NodeAssert.ok(Math.abs(after.bounds[dimension] - before.bounds[dimension]) <= 1);
    }
    await assertCollapsed(application, shell, after);
    await assertNativePillRegion(application, shell);
    return { target, counts, before: position, after: afterPosition };
  } finally {
    await pointerFocus.dispose();
    await receipt.evaluate((handle) => handle.dispose());
    await receipt.dispose();
  }
}

async function captureScreenshot(page, name) {
  const path = NodePath.join(artifactsRoot, `${name}.png`);
  await page.screenshot({ path, animations: "allow", timeout: 10_000 });
  report.screenshots.push(path);
  return path;
}

async function observeMotion(application, shell, phase) {
  if (await shell.page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    report.limitations.push(`Motion trace skipped for ${phase}: reduced motion is enabled`);
    return null;
  }
  const native = await application.evaluateHandle(({ BrowserWindow }, id) => {
    const main = BrowserWindow.fromId(id);
    const events = [];
    const moved = () => events.push({ event: "move", bounds: main.getBounds() });
    const resized = () => events.push({ event: "resize", bounds: main.getBounds() });
    main.on("move", moved);
    main.on("resize", resized);
    return {
      finish: () => {
        main.removeListener("move", moved);
        main.removeListener("resize", resized);
        return events;
      },
    };
  }, shell.id);
  const renderer = await shell.page.evaluateHandle((phase) => {
    const root = document.querySelector('[data-satellite="shell"]');
    const surface = document.querySelector('[data-satellite="shell-surface"]');
    const workspace = document.querySelector('[data-satellite="workspace"]');
    const pill = document.querySelector('[data-satellite="pill"]');
    const initialRect = surface.getBoundingClientRect();
    const initial = {
      x: initialRect.x,
      y: initialRect.y,
      width: initialRect.width,
      height: initialRect.height,
    };
    const frames = [];
    const longFrames = [];
    let frame;
    let started;
    const performanceObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (started === undefined || entry.startTime + entry.duration < started) continue;
        longFrames.push({
          t: entry.startTime - started,
          duration: entry.duration,
          renderStart: entry.renderStart,
          styleAndLayoutStart: entry.styleAndLayoutStart,
          scripts: entry.scripts?.map((script) => ({
            invoker: script.invoker,
            duration: script.duration,
            forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
          })),
        });
      }
    });
    if (PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
      performanceObserver.observe({ type: "long-animation-frame" });
    }
    let resolve;
    const finished = new Promise((done) => {
      resolve = done;
    });
    const capture = (now) => {
      const rect = surface.getBoundingClientRect();
      frames.push({
        t: now - started,
        phase: root.dataset.phase,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        workspaceWidth: workspace.getBoundingClientRect().width,
        workspaceOpacity: Number(getComputedStyle(workspace).opacity),
        pillOpacity: Number(getComputedStyle(pill).opacity),
        visibleBackdrops: Array.from(
          document.querySelectorAll(
            '[data-slot="dialog-backdrop"], [data-slot="alert-dialog-backdrop"]',
          ),
        ).filter((node) => {
          const style = getComputedStyle(node);
          return (
            style.visibility === "visible" && style.display !== "none" && Number(style.opacity) > 0
          );
        }).length,
        viewport: [window.innerWidth, window.innerHeight],
      });
      if (root.dataset.phase === "settled") finish(false);
      else frame = requestAnimationFrame(capture);
    };
    const observer = new MutationObserver(() => {
      if (started !== undefined || root.dataset.phase !== phase) return;
      started = performance.now();
      capture(started);
    });
    const finish = (timedOut) => {
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      observer.disconnect();
      performanceObserver.disconnect();
      resolve({ phase, initial, frames, longFrames, timedOut });
    };
    const timeout = setTimeout(() => finish(true), 5_000);
    observer.observe(root, { attributes: true, attributeFilter: ["data-phase"] });
    return { finished };
  }, phase);
  return { native, renderer };
}

async function finishMotion(observation) {
  if (!observation) return;
  try {
    const trace = await observation.renderer.evaluate(async ({ finished }) => finished);
    const nativeEvents = await observation.native.evaluate(({ finish }) => finish());
    NodeAssert.equal(trace.timedOut, false, "Motion must complete and settle");
    NodeAssert.deepEqual(nativeEvents, [], "Morph must not move or resize the OS window");
    NodeAssert.ok(trace.frames.length > 3, "Capture intermediate motion frames");
    const first = trace.frames[0];
    for (const key of ["x", "y", "width", "height"]) {
      NodeAssert.ok(
        Math.abs(first[key] - trace.initial[key]) < 1,
        `The first ${trace.phase} frame must start at the visible ${key}`,
      );
    }
    const opening = trace.phase === "expanding";
    for (let index = 0; index < trace.frames.length; index++) {
      const frame = trace.frames[index];
      if (frame.phase !== "settled")
        NodeAssert.equal(
          frame.visibleBackdrops,
          0,
          "Dialog backdrops must not paint outside the morphing surface",
        );
      NodeAssert.deepEqual(frame.viewport, first.viewport, "Viewport must remain stable");
      NodeAssert.ok(
        Math.abs(frame.workspaceWidth - first.workspaceWidth) < 1,
        "Workspace content must not reflow during the morph",
      );
      if (index === 0) continue;
      const previous = trace.frames[index - 1];
      const direction = opening ? 1 : -1;
      NodeAssert.ok(
        direction * (frame.width - previous.width) >= -1,
        "Surface width must follow a continuous, unreversed path",
      );
      NodeAssert.ok(
        direction * (frame.height - previous.height) >= -1,
        "Surface height must follow a continuous, unreversed path",
      );
      NodeAssert.ok(
        direction * (previous.x - frame.x) >= -1 && direction * (previous.y - frame.y) >= -1,
        "Surface origin must move continuously between the pill and workspace",
      );
    }
    const gaps = trace.frames.slice(1).map((frame, index) => frame.t - trace.frames[index].t);
    const sorted = gaps.toSorted((a, b) => a - b);
    trace.timing = {
      durationMs: trace.frames.at(-1).t,
      frames: trace.frames.length,
      medianFrameMs: sorted[Math.floor(sorted.length / 2)],
      maxFrameMs: Math.max(...gaps),
      largestWidthStep:
        Math.max(
          ...trace.frames
            .slice(1)
            .map((frame, index) => Math.abs(frame.width - trace.frames[index].width)),
        ) / Math.abs(trace.frames.at(-1).width - first.width),
    };
    NodeAssert.ok(
      trace.timing.largestWidthStep < 0.45,
      "The morph must show intermediate geometry rather than jump most of the distance in one frame",
    );
    const path = NodePath.join(
      artifactsRoot,
      `motion-${trace.phase}-${report.motion?.length ?? 0}.json`,
    );
    await NodeFSP.writeFile(path, JSON.stringify(trace, null, 2));
    report.motion ??= [];
    report.motion.push({ ...trace.timing, phase: trace.phase, path });
  } finally {
    await observation.native.dispose();
    await observation.renderer.dispose();
  }
}

async function expand(application, shell, initial, captureEvidence = false, keyboard = false) {
  // Video and the frame trace cover motion. Taking a forced screenshot during
  // the morph stalls Chromium's compositor and distorts the timing measurement.
  const button = shell.page.getByRole("button", { name: "Expand SatelliteT3", exact: true });
  if (keyboard) {
    await button.focus();
    await shell.page.keyboard.press("Enter");
  } else {
    await button.click();
  }
  await waitSettled(shell.page, "workspace");
  const snapshot = await nativeSnapshot(application, shell);
  assertSameShell(snapshot, initial);
  NodeAssert.equal(snapshot.resizable, false);
  NodeAssert.deepEqual(
    snapshot.bounds,
    initial.bounds,
    "Expansion must not resize or move the native canvas",
  );
  NodeAssert.ok(snapshot.bounds.width > 320 && snapshot.bounds.height > 70);
  NodeAssert.equal(
    await shell.page.locator('[data-satellite="workspace"]').evaluate((node) => node.inert),
    false,
  );
  if (captureEvidence) await captureScreenshot(shell.page, "workspace-expanded");
}

async function blurIntoOwnedFixture(application, shell, observePinned = false) {
  await shell.page.bringToFront();
  return application.evaluate(
    async ({ BrowserWindow }, { id, observePinned }) => {
      const main = BrowserWindow.fromId(id);
      if (!main) throw new Error("Satellite shell missing before blur");
      const fixture = new BrowserWindow({
        title: "SatelliteT3 smoke focus fixture",
        width: 240,
        height: 120,
        show: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      await fixture.loadURL("data:text/html,<p>DEVELOPMENT FIXTURE — focus target only</p>");
      main.focus();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          main.removeListener("blur", blurred);
          fixture.destroy();
          reject(new Error("Satellite shell did not lose focus to the owned fixture"));
        }, 30_000);
        const blurred = () => {
          clearTimeout(timeout);
          // A negative assertion must observe beyond the shell's 150ms blur
          // debounce. Positive collapse checks await the settled renderer state.
          if (observePinned) setTimeout(resolve, 300);
          else resolve();
        };
        main.once("blur", blurred);
        fixture.show();
        fixture.focus();
      });
      return fixture.id;
    },
    { id: shell.id, observePinned },
  );
}

async function destroyFixture(application, fixtureId) {
  await application.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(),
    fixtureId,
  );
}

async function assertBackgroundScrollIsolation(page) {
  const result = await page.evaluate(() => {
    const workspace = document.querySelector('[data-satellite="workspace"]');
    const surface = document.querySelector('[data-satellite="shell-surface"]');
    const shell = document.querySelector('[data-satellite="shell"]');
    const expander = document.querySelector('[data-satellite="pill-content"]');
    // Model a retained chat following its caret or new content while collapsed.
    // Chromium must still scroll the chat, without scrolling either shell boundary.
    const scroller = document.createElement("div");
    scroller.style.cssText =
      "position:absolute;right:20px;bottom:20px;width:180px;height:100px;overflow:auto";
    const content = document.createElement("div");
    content.style.cssText = "height:500px;position:relative";
    const target = document.createElement("button");
    target.textContent = "Background chat scroll fixture";
    target.style.cssText = "position:absolute;bottom:0;left:0";
    content.append(target);
    scroller.append(content);
    workspace.append(scroller);
    try {
      const before = expander.getBoundingClientRect().toJSON();
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
      const after = expander.getBoundingClientRect().toJSON();
      const hit = document.elementFromPoint(after.x + after.width / 2, after.y + after.height / 2);
      return {
        before,
        after,
        chatScrolled: scroller.scrollTop > 0,
        shellScroll: [shell.scrollLeft, shell.scrollTop, surface.scrollLeft, surface.scrollTop],
        clickable: hit !== null && expander.contains(hit),
      };
    } finally {
      scroller.remove();
    }
  });
  NodeAssert.equal(result.chatScrolled, true, "Background chat can still follow new content");
  NodeAssert.deepEqual(result.shellScroll, [0, 0, 0, 0], "Chat scrolling cannot move the shell");
  NodeAssert.deepEqual(result.after, result.before, "The pill must remain in its visible frame");
  NodeAssert.equal(result.clickable, true, "Background chat scrolling must not hide pill controls");
}

async function quit(application) {
  // Playwright Electron's close invokes app.quit(), preserving the app's shutdown path.
  await application.close();
}

async function captureFailure(application) {
  const diagnostics = { stage: currentStage, checksCompleted: report.checks.length };
  if (!application) return diagnostics;
  diagnostics.windows = await application
    .evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        visible: window.isVisible(),
        focused: window.isFocused(),
        bounds: window.getBounds(),
        loading: window.webContents.isLoading(),
      })),
    )
    .catch(() => "unavailable");
  const page = application.windows().find((candidate) => candidate.url().startsWith("t3code://"));
  if (page && !page.isClosed()) {
    // Only inspect structural flags. Never dump DOM text, input values, URLs,
    // accessible names, or provider/conversation content into diagnostics.
    diagnostics.dom = await page
      .evaluate(() => {
        const flags = (node) => {
          if (!(node instanceof HTMLElement)) return null;
          const style = getComputedStyle(node);
          return {
            tag: node.tagName,
            role: node.getAttribute("role"),
            ariaHidden: node.getAttribute("aria-hidden"),
            ariaModal: node.getAttribute("aria-modal"),
            inert: node.inert,
            hidden: node.hidden,
            display: style.display,
            visibility: style.visibility,
            pointerEvents: style.pointerEvents,
          };
        };
        const shell = document.querySelector('[data-satellite="shell"]');
        const expander = document.querySelector('[data-satellite="pill-content"]');
        const ancestors = [];
        for (let node = expander; node && ancestors.length < 7; node = node.parentElement)
          ancestors.push(flags(node));
        const rect = expander?.getBoundingClientRect();
        const hit = rect
          ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          : null;
        return {
          readyState: document.readyState,
          hasFocus: document.hasFocus(),
          root: flags(document.getElementById("root")),
          shell: { mode: shell?.dataset.mode, phase: shell?.dataset.phase },
          expanderAncestors: ancestors,
          expanderCenterHitsButton: Boolean(expander && hit && expander.contains(hit)),
          activeElement: flags(document.activeElement),
          dialogs: Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
            .slice(0, 5)
            .map(flags),
        };
      })
      .catch(() => "unavailable");
    diagnostics.screenshot = await captureScreenshot(page, "failure-shell").catch(
      () => "unavailable",
    );
  }
  const path = NodePath.join(artifactsRoot, "failure-diagnostics.json");
  await NodeFSP.writeFile(path, JSON.stringify(diagnostics, null, 2), "utf8");
  console.error(`[satellite-smoke] Failure diagnostics: ${path}`);
  console.error(JSON.stringify(diagnostics));
  return diagnostics;
}

let application;
const report = {
  kind: "DEVELOPMENT FIXTURE — native smoke, no live provider work",
  checks: [],
  limitations: [
    "Taskbar exclusion uses Electron setSkipTaskbar; native region checks do not prove taskbar visibility.",
    "Fixture states do not exercise live provider approval or real conversation navigation.",
  ],
  screenshots: [],
};
try {
  stage("Launching isolated SatelliteT3");
  application = await launch();
  stage("Waiting for the native shell and settled pill");
  const shell = await findShell(application);
  stage("Checking collapsed native geometry and renderer isolation");
  let initial = await nativeSnapshot(application, shell);
  NodeAssert.deepEqual(
    initial.windowIds,
    [shell.id],
    "Pill and workspace must share one native window",
  );
  NodeAssert.equal(initial.contextIsolation, true);
  NodeAssert.equal(initial.nodeIntegration, false);
  NodeAssert.equal(initial.sandbox, true);
  await assertCollapsed(application, shell, initial);
  await assertNativePillRegion(application, shell);
  const relativeProfile = NodePath.relative(profileRoot, initial.userData);
  NodeAssert.equal(NodePath.isAbsolute(relativeProfile), false);
  NodeAssert.equal(relativeProfile.startsWith(".."), false);
  const workspace = await shell.page.locator('[data-satellite="workspace"]').elementHandle();
  NodeAssert.ok(workspace);
  report.checks.push(
    "Startup uses one sandboxed, always-on-top native window showing the 320×70 pill",
  );

  stage("Dragging the pill from its content, menu, and padding with the native pointer");
  NodeAssert.equal(await shell.page.locator('[data-satellite="pill-grip"]').count(), 0);
  report.drags = [];
  for (const target of ["pill-content", "pill-menu", "pill"]) {
    stage(`Checking native drag from ${target}`);
    report.drags.push(await dragPill(application, shell, target));
  }
  initial = await nativeSnapshot(application, shell);
  report.checks.push(
    "The entire pill drags without opening the workspace or menu, and has no grip",
  );
  report.checks.push("Keyboard navigation shows focus; mouse-down and drag release hide it");

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
    stage(`Publishing ${fixture.name} pill fixture`);
    const projection = {
      threadId: null,
      environmentId: null,
      title: "DEVELOPMENT FIXTURE",
      state: fixture.state,
      detail: fixture.detail,
      attention: fixture.attention,
    };
    await shell.page.evaluate((state) => window.satelliteBridge.publish(state), projection);
    await shell.page.waitForFunction(
      (expected) =>
        document.querySelector('[data-satellite="pill"]')?.dataset.state === expected.state &&
        document.querySelector('[data-satellite="pill-detail"]')?.textContent === expected.detail,
      projection,
    );
    const rendered = await shell.page.evaluate(() => ({
      title: document.querySelector('[data-satellite="pill-title"]')?.textContent,
      color: getComputedStyle(document.querySelector('[data-satellite="pill-dot"]'))
        .backgroundColor,
      attention: document.querySelector('[data-satellite="pill-attention"]') !== null,
    }));
    NodeAssert.equal(rendered.title, projection.title);
    NodeAssert.equal(rendered.color, fixture.color);
    NodeAssert.equal(rendered.attention, fixture.attention);
    const screenshot = NodePath.join(artifactsRoot, `fixture-${fixture.name}.png`);
    await shell.page.screenshot({ path: screenshot });
    report.screenshots.push(screenshot);
  }
  report.checks.push(
    "Collapsed workspace publishes working, approval, completed, and unknown fixture states",
  );

  stage("Expanding from the pill and capturing transition evidence");
  const expansionMotion = await observeMotion(application, shell, "expanding");
  await expand(application, shell, initial, true);
  await finishMotion(expansionMotion);
  stage("Checking native close collapses the same window");
  const collapseMotion = await observeMotion(application, shell, "collapsing");
  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), shell.id);
  await assertCollapsed(application, shell, initial);
  await finishMotion(collapseMotion);
  report.checks.push(
    "Both morphs keep the native canvas and workspace layout stable, with continuous surface geometry",
  );

  stage("Checking native minimize collapses the same window");
  await expand(application, shell, initial, false, true);
  await application.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id).minimize(),
    shell.id,
  );
  await assertCollapsed(application, shell, initial);
  report.checks.push("Minimizing returns to the visible pill");

  stage("Checking native pill geometry after workspace zoom");
  await expand(application, shell, initial);
  try {
    await application.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.fromId(id).webContents.setZoomLevel(1);
    }, shell.id);
    const zoomedWorkspace = await nativeSnapshot(application, shell);
    NodeAssert.ok(zoomedWorkspace.zoomFactor > 1);
    await shell.page.waitForFunction(
      ({ width, zoomFactor }) => {
        const surface = document.querySelector('[data-satellite="shell-surface"]');
        return (
          Math.abs(window.innerWidth * zoomFactor - width) < 2 &&
          surface &&
          Math.abs(surface.getBoundingClientRect().width * zoomFactor - width) < 2
        );
      },
      { width: zoomedWorkspace.bounds.width, zoomFactor: zoomedWorkspace.zoomFactor },
    );
    await application.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(),
      shell.id,
    );
    await waitSettled(shell.page, "pill");
    const zoomedPill = await nativeSnapshot(application, shell);
    assertSameShell(zoomedPill, initial);
    NodeAssert.deepEqual(zoomedPill.bounds, initial.bounds);
    await shell.page.waitForFunction((zoomFactor) => {
      const pill = document
        .querySelector('[data-satellite="shell-surface"]')
        ?.getBoundingClientRect();
      const menu = document.querySelector('[data-satellite="pill-menu"]')?.getBoundingClientRect();
      return (
        pill &&
        menu &&
        Math.abs(pill.width * zoomFactor - 320) < 2 &&
        Math.abs(pill.height * zoomFactor - 70) < 2 &&
        menu.x >= 0 &&
        menu.y >= 0 &&
        menu.right <= window.innerWidth + 1 &&
        menu.bottom <= window.innerHeight + 1
      );
    }, zoomedPill.zoomFactor);
    await captureScreenshot(shell.page, "pill-zoomed");
  } finally {
    await application.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.fromId(id).webContents.setZoomLevel(0);
    }, shell.id);
  }
  await shell.page.waitForFunction(() => {
    const pill = document
      .querySelector('[data-satellite="shell-surface"]')
      ?.getBoundingClientRect();
    return pill?.width === 320;
  });
  await assertCollapsed(application, shell, initial);
  report.checks.push(
    "Workspace zoom preserves the pill's native 320×70 size and visible menu; zoom reset to zero",
  );

  stage("Checking pinned workspace survives native blur");
  await expand(application, shell, initial);
  // The isolated profile can still be showing onboarding. Exercise the same
  // bridge used by the pill menu without dismissing or completing that dialog.
  await shell.page.evaluate(() => window.satelliteBridge.setPinned(true));
  await shell.page
    .locator('[data-satellite="window-controls"] button[aria-pressed="true"]')
    .waitFor();
  const pinnedFixtureId = await blurIntoOwnedFixture(application, shell, true);
  try {
    await waitSettled(shell.page, "workspace");
    assertSameShell(await nativeSnapshot(application, shell), initial);
  } finally {
    await destroyFixture(application, pinnedFixtureId);
  }
  report.checks.push("Pinned workspace remains expanded after native focus leaves it");

  stage("Checking unpinned workspace collapses on native blur");
  await shell.page.bringToFront();
  await shell.page.evaluate(() => window.satelliteBridge.setPinned(false));
  await shell.page
    .locator('[data-satellite="window-controls"] button[aria-pressed="false"]')
    .waitFor();
  const blurFixtureId = await blurIntoOwnedFixture(application, shell);
  try {
    await assertCollapsed(application, shell, initial);
  } finally {
    await destroyFixture(application, blurFixtureId);
  }
  report.checks.push("Unpinned workspace collapses on native blur");
  stage("Checking background chat scrolling after click-away collapse");
  await assertBackgroundScrollIsolation(shell.page);
  await expand(application, shell, initial);
  const scrollFixtureId = await blurIntoOwnedFixture(application, shell);
  try {
    await assertCollapsed(application, shell, initial);
  } finally {
    await destroyFixture(application, scrollFixtureId);
  }
  report.checks.push("Background chat scrolling preserves visible, clickable pill and workspace");
  NodeAssert.equal(
    await workspace.evaluate(
      (node) => node.isConnected && node === document.querySelector('[data-satellite="workspace"]'),
    ),
    true,
  );
  NodeAssert.deepEqual((await nativeSnapshot(application, shell)).windowIds, [shell.id]);
  report.checks.push("Workspace DOM and native renderer remain mounted throughout all transitions");

  stage("Checking keyboard movement after collapse");
  await application.evaluate(({ BrowserWindow, screen }, id) => {
    const area = screen.getPrimaryDisplay().workArea;
    const main = BrowserWindow.fromId(id);
    main.setPosition(area.x + 32, area.y + 32);
  }, shell.id);
  const beforeKeyboardMove = await pillPosition(application, shell);
  const moveObservation = await shell.page.evaluateHandle(async () => {
    let ready;
    const initial = new Promise((resolve) => {
      ready = resolve;
    });
    let receivedInitial = false;
    let changed;
    const moved = new Promise((resolve) => {
      changed = resolve;
    });
    const timeout = setTimeout(() => {
      stop();
      changed(null);
      ready();
    }, 10_000);
    const stop = window.satelliteBridge.onShellState((state) => {
      if (!receivedInitial) {
        receivedInitial = true;
        ready();
        return;
      }
      clearTimeout(timeout);
      stop();
      changed(state);
    });
    await initial;
    return { moved };
  });
  let expectedPosition;
  try {
    await shell.page.bringToFront();
    await shell.page.getByRole("button", { name: "Expand SatelliteT3", exact: true }).focus();
    await shell.page.keyboard.press("Alt+ArrowRight");
    const state = await moveObservation.evaluate(async ({ moved }) => moved);
    NodeAssert.ok(state, "Keyboard movement must publish its new placement");
    const native = await nativeSnapshot(application, shell);
    expectedPosition = {
      x: native.bounds.x + state.pillBounds.x,
      y: native.bounds.y + state.pillBounds.y,
    };
  } finally {
    await moveObservation.dispose();
  }
  NodeAssert.deepEqual(expectedPosition, { x: beforeKeyboardMove.x + 16, y: beforeKeyboardMove.y });
  report.checks.push("Alt+ArrowRight moves the collapsed native shell by 16px through preload/IPC");
  const positionFile = NodePath.join(initial.userData, "satellite-pill.json");
  await workspace.dispose();
  stage("Quitting and checking saved pill placement");
  report.video = await shell.page.video()?.path();
  await quit(application);
  application = undefined;
  const savedPosition = JSON.parse(await NodeFSP.readFile(positionFile, "utf8"));
  NodeAssert.deepEqual({ x: savedPosition.x, y: savedPosition.y }, expectedPosition);

  stage("Relaunching and checking restored pill placement");
  application = await launch();
  const restartedShell = await findShell(application);
  const restarted = await nativeSnapshot(application, restartedShell);
  await assertCollapsed(application, restartedShell, restarted);
  NodeAssert.deepEqual(restarted.windowIds, [restartedShell.id]);
  NodeAssert.deepEqual(await pillPosition(application, restartedShell), expectedPosition);
  report.checks.push(
    "Explicit quit and relaunch restore one collapsed shell at the saved pill position",
  );
  report.native = { initial, restarted };
  report.retained = keepRunning;
  stage("Native smoke checks completed");
  console.log(JSON.stringify(report, null, 2));
  if (keepRunning) {
    console.log("Owned isolated smoke instance retained; quit SatelliteT3 to finish this script.");
    await application.waitForEvent("close", { timeout: 0 });
    application = undefined;
  }
} catch (error) {
  console.error(`[satellite-smoke] Failed during: ${currentStage}`);
  await captureFailure(application).catch(() => {
    console.error("[satellite-smoke] Failure diagnostics could not be captured");
  });
  throw error;
} finally {
  if (application) await quit(application);
}
