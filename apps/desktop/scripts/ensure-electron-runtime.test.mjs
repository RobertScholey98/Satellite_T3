import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { extractElectronRuntimeArchive } from "./ensure-electron-runtime.mjs";

afterEach(() => vi.unstubAllEnvs());

// oxlint-disable-next-line t3code/no-global-process-runtime -- Native archive extraction runs on the actual Windows host.
const hostPlatform = NodeOS.platform();

const runtimeArchive = Buffer.from(
  "UEsDBBQAAAAAAGS6Pl0PEcKUGQAAABkAAAASAAAAbmVzdGVkL3J1bnRpbWUudHh0RWxlY3Ryb24gcnVudGltZSBmaXh0dXJlClBLAQIUABQAAAAAAGS6Pl0PEcKUGQAAABkAAAASAAAAAAAAAAAAAACAAQAAAABuZXN0ZWQvcnVudGltZS50eHRQSwUGAAAAAAEAAQBAAAAASQAAAAAA",
  "base64",
);

describe.skipIf(hostPlatform !== "win32")("Electron runtime extraction on Windows", () => {
  it("extracts nested files without PATH tools and treats special characters literally", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-electron-archive-"));
    const zipPath = NodePath.join(directory, "runtime [zip] ' $&; fixture.zip");
    const destination = NodePath.join(directory, "dist [runtime] ' $&; fixture");
    try {
      NodeFS.writeFileSync(zipPath, runtimeArchive);
      vi.stubEnv("PATH", "");

      extractElectronRuntimeArchive(zipPath, destination);

      expect(NodeFS.readFileSync(NodePath.join(destination, "nested", "runtime.txt"), "utf8")).toBe(
        "Electron runtime fixture\n",
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports a failed extraction when the archive is corrupt", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-electron-archive-"));
    const zipPath = NodePath.join(directory, "corrupt.zip");
    try {
      NodeFS.writeFileSync(zipPath, "This is not a ZIP archive.");

      expect(() =>
        extractElectronRuntimeArchive(zipPath, NodePath.join(directory, "dist")),
      ).toThrow(/failed with exit code [1-9]\d*/);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
