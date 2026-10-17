import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const env = {
  ...process.env,
  PATH: `${NodePath.join(root, "node_modules", ".bin")}${NodePath.delimiter}${process.env.PATH ?? ""}`,
  T3CODE_HOME: NodePath.join(root, ".t3", "satellite"),
  T3CODE_DEV_INSTANCE: "satellite-t3",
  T3CODE_DESKTOP_APP_USER_MODEL_ID: "com.satellitet3.prototype.dev",
  T3CODE_DISABLE_AUTO_UPDATE: "1",
};
delete env.VITE_HTTP_URL;
delete env.VITE_WS_URL;
delete env.VITE_DEV_SERVER_URL;
delete env.T3CODE_PORT;
delete env.T3CODE_PORT_OFFSET;
delete env.ELECTRON_RUN_AS_NODE;

// oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone launcher runs before any Effect runtime exists.
const isWindows = process.platform === "win32";
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    NodePath.join(root, "scripts", "dev-runner.ts"),
    "dev:desktop",
    "--home-dir",
    env.T3CODE_HOME,
    ...process.argv.slice(2),
  ],
  { cwd: root, env, stdio: "inherit", windowsHide: true, detached: !isWindows },
);
child.on("error", (error) => {
  console.error(`SatelliteT3 could not start: ${error.message}`);
  process.exitCode = 1;
});
// The dev tasks below the runner do not forward signals, so stop the runner's whole process
// group, as a terminal does on Ctrl+C. Windows has no process groups; Ctrl+C reaches the console.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (isWindows) child.kill(signal);
    else process.kill(-child.pid, signal);
  });
}
child.on("exit", (code, signal) => {
  process.exitCode = code ?? 128 + NodeOS.constants.signals[signal];
});
