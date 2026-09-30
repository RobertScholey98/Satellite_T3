import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Use the upstream desktop runner, with this checkout's own data and ports.
const root = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const env = {
  ...process.env,
  PATH: `${NodePath.join(root, "node_modules", ".bin")}${NodePath.delimiter}${process.env.PATH ?? ""}`,
  T3CODE_HOME: NodePath.join(root, ".t3", "satellite"),
  T3CODE_DEV_INSTANCE: "satellite-t3",
  T3CODE_SATELLITE_PILL: "1",
  T3CODE_DESKTOP_APP_USER_MODEL_ID: "com.satellitet3.prototype.dev",
  // Do not replace the user's installed T3 Code URL-handler registration.
  T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED: "1",
  T3CODE_DISABLE_AUTO_UPDATE: "1",
};
delete env.VITE_HTTP_URL;
delete env.VITE_WS_URL;
delete env.VITE_DEV_SERVER_URL;
delete env.T3CODE_PORT;
delete env.T3CODE_PORT_OFFSET;
delete env.ELECTRON_RUN_AS_NODE;

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
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
