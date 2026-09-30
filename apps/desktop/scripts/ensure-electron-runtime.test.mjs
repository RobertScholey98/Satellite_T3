import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { extractElectronRuntime } from "./ensure-electron-runtime.mjs";

afterEach(() => vi.unstubAllEnvs());

// oxlint-disable-next-line t3code/no-global-process-runtime -- Tests exercise the host's real extraction tools.
describe.skipIf(NodeOS.platform() !== "win32")("Windows Electron extraction", () => {
  it("extracts without Python and treats special characters in paths literally", () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-electron O'Brien $[a]&;-"),
    );
    try {
      const source = NodePath.join(directory, "source");
      const archive = NodePath.join(directory, "runtime [1].zip");
      const destination = NodePath.join(directory, "runtime [2]");
      NodeFS.mkdirSync(NodePath.join(source, "resources"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(source, "resources", "fixture.txt"), "Electron fixture\n");
      NodeChildProcess.execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:T3_TEST_SOURCE, $env:T3_TEST_ARCHIVE)",
        ],
        {
          env: { ...process.env, T3_TEST_SOURCE: source, T3_TEST_ARCHIVE: archive },
          windowsHide: true,
        },
      );
      // Only Windows PowerShell is available to the extractor, never Python.
      vi.stubEnv(
        "PATH",
        NodePath.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0"),
      );

      extractElectronRuntime(archive, destination);

      expect(
        NodeFS.readFileSync(NodePath.join(destination, "resources", "fixture.txt"), "utf8"),
      ).toBe("Electron fixture\n");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports an invalid archive as a failed extraction", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-electron-invalid-"));
    try {
      const archive = NodePath.join(directory, "invalid.zip");
      const destination = NodePath.join(directory, "runtime");
      NodeFS.writeFileSync(archive, "not a zip file");

      expect(() => extractElectronRuntime(archive, destination)).toThrow(
        /failed with exit code 1\b/,
      );
      expect(NodeFS.existsSync(NodePath.join(destination, "electron.exe"))).toBe(false);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
