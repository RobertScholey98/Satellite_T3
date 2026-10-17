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
  { cwd: root, env, stdio: "inherit", windowsHide: true },
);
child.on("error", (error) => {
  console.error(`SatelliteT3 could not start: ${error.message}`);
  process.exitCode = 1;
});
const ps = (args) =>
  NodeChildProcess.execFileSync("ps", args, { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));

// Ctrl+C in a terminal already signalled every process in its foreground group; signalling them
// again would read as a second Ctrl+C.
const terminalSignalledOurGroup = () => {
  const [[pgid, terminalPgid]] = ps(["-o", "pgid=,tpgid=", "-p", String(process.pid)]);
  return pgid === terminalPgid;
};

const descendantsOf = (rootPid) => {
  const rows = ps(["-axo", "pid=,ppid="]);
  const found = [rootPid];
  for (let index = 0; index < found.length; index++) {
    for (const [pid, ppid] of rows) if (ppid === found[index]) found.push(pid);
  }
  return found;
};

// Signalling only the launcher's PID reaches nothing below the runner: its tasks do not forward
// signals, and the backend Electron starts runs in its own process group. On Windows, Ctrl+C
// already reaches every console process.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (isWindows) {
      child.kill(signal);
      return;
    }
    if (signal === "SIGINT" && terminalSignalledOurGroup()) return;
    for (const pid of descendantsOf(child.pid)) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  });
}
child.on("exit", (code, signal) => {
  process.exitCode = code ?? 128 + NodeOS.constants.signals[signal];
});
