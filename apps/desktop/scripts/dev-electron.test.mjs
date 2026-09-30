import * as NodeEvents from "node:events";

import { afterEach, assert, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  watchers: [],
  children: [],
  waitForResources: vi.fn(),
}));

vi.mock("node:os", () => ({ platform: () => "win32" }));
vi.mock("node:fs", () => ({
  watch: vi.fn((directory, _options, callback) => {
    harness.watchers.push({ directory, callback });
    return { close: vi.fn() };
  }),
}));
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => {
    const child = new NodeEvents.EventEmitter();
    child.kill = vi.fn(() => child.emit("exit", 0, null));
    harness.children.push(child);
    return child;
  }),
}));
vi.mock("./electron-launcher.mjs", () => ({
  desktopDir: "/desktop",
  resolveDevProtocolClient: () => undefined,
  resolveElectronLaunchCommand: (args) => ({ electronPath: "/electron", args }),
}));
vi.mock("./wait-for-resources.mjs", () => ({
  waitForResources: harness.waitForResources,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  harness.watchers.length = 0;
  harness.children.length = 0;
  harness.waitForResources.mockReset();
});

it("waits for rebuilt desktop resources before restarting Electron", async () => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:8526");
  vi.spyOn(process, "once").mockReturnValue(process);
  harness.waitForResources.mockResolvedValueOnce(undefined);
  await import("./dev-electron.mjs");
  assert.lengthOf(harness.children, 1);

  // Cleaning the bundle emits a watch event before main.cjs is written again.
  const rebuild = Promise.withResolvers();
  harness.waitForResources.mockReturnValue(rebuild.promise);
  const bundleWatcher = harness.watchers.find(({ directory }) =>
    directory.endsWith("dist-electron"),
  );
  assert.ok(bundleWatcher);
  bundleWatcher.callback("rename", "main.cjs");
  await vi.advanceTimersByTimeAsync(120);

  assert.lengthOf(harness.children, 1, "Electron must not launch a missing main.cjs");
  assert.equal(harness.waitForResources.mock.calls.length, 2);
  assert.includeMembers(harness.waitForResources.mock.calls[1][0].files, [
    "dist-electron/main.cjs",
    "dist-electron/preload.cjs",
    "dist-electron/boot.cjs",
  ]);

  rebuild.resolve();
  await vi.advanceTimersByTimeAsync(0);
  assert.lengthOf(harness.children, 2);
});

it("waits for build outputs when Electron exits after a missing-entry error", async () => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:8526");
  vi.spyOn(process, "once").mockReturnValue(process);
  harness.waitForResources.mockResolvedValueOnce(undefined);
  await import("./dev-electron.mjs");

  const rebuild = Promise.withResolvers();
  harness.waitForResources.mockReturnValue(rebuild.promise);
  harness.children[0].emit("exit", 1, null);
  await vi.advanceTimersByTimeAsync(120);
  assert.lengthOf(harness.children, 1);

  rebuild.resolve();
  await vi.advanceTimersByTimeAsync(0);
  assert.lengthOf(harness.children, 2);
  assert.isFalse(harness.children[0].kill.mock.calls.length > 0);
});
