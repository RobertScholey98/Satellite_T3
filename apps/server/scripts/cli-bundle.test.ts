// @effect-diagnostics nodeBuiltinImport:off - the bundle regression exercises native Node module loading.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus/pack";
import { expect, it } from "vite-plus/test";

import serverConfig from "../vite.config.ts";

it("loads the bundled OpenCode idea environment without unresolved parser imports", async () => {
  const outputDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-bundle-"));
  const pack = serverConfig.pack;
  if (!pack || Array.isArray(pack)) throw new Error("Expected one server bundle configuration.");

  try {
    await build({
      ...pack,
      config: false,
      cwd: NodePath.resolve(import.meta.dirname, ".."),
      entry: ["src/ideas/OpenCodeIdeaEnvironment.ts"],
      outDir: outputDirectory,
      sourcemap: false,
      dts: false,
      logLevel: "silent",
    });
    const entry = NodeFS.readdirSync(outputDirectory).find((name) => /\.(?:mjs|js)$/.test(name));
    expect(entry).toBeDefined();
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(outputDirectory, entry!)).href)});`,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  } finally {
    NodeFS.rmSync(outputDirectory, { recursive: true, force: true });
  }
}, 60_000);
