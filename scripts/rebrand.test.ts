// @effect-diagnostics nodeBuiltinImport:off - exercises a plain-Node script against a temp tree.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readFileList, rebrand } from "./rebrand.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rebrand-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), text);
  }
  const read = (file: string) => NodeFS.readFileSync(NodePath.join(root, file), "utf8");
  return { root, read };
}

describe("rebrand", () => {
  it("rewrites listed files once and then leaves them alone", () => {
    const { root, read } = tree({ "src/title.ts": 'export const title = "T3 Code (Dev)";\r\n' });

    expect(rebrand({ root, files: ["src/title.ts"], write: true })).toEqual(["src/title.ts"]);
    expect(read("src/title.ts")).toBe('export const title = "Satellite (Dev)";\r\n');
    expect(rebrand({ root, files: ["src/title.ts"], write: true })).toEqual([]);
  });

  it("leaves lines marked rebrand:keep alone", () => {
    const { root, read } = tree({
      "src/client.ts":
        'const clientName = "T3 Code"; // rebrand:keep\nconst message = "Restart T3 Code.";\n',
    });

    rebrand({ root, files: ["src/client.ts"], write: true });
    expect(read("src/client.ts")).toBe(
      'const clientName = "T3 Code"; // rebrand:keep\nconst message = "Restart Satellite.";\n',
    );
    expect(rebrand({ root, files: ["src/client.ts"], write: false })).toEqual([]);
  });

  it("names a planted upstream literal in check mode without writing", () => {
    const { root, read } = tree({
      "src/clean.ts": 'export const name = "Satellite";\n',
      "src/planted.ts": 'export const name = "T3 Code";\n',
    });

    expect(rebrand({ root, files: ["src/clean.ts", "src/planted.ts"], write: false })).toEqual([
      "src/planted.ts",
    ]);
    expect(read("src/planted.ts")).toBe('export const name = "T3 Code";\n');
  });

  it("never touches files the list leaves out, such as vendored references", () => {
    const { root, read } = tree({
      ".repos/effect/README.md": "Built for T3 Code.\n",
      "src/title.ts": '"T3 Code"\n',
    });

    rebrand({ root, files: ["src/title.ts"], write: true });
    expect(read(".repos/effect/README.md")).toBe("Built for T3 Code.\n");
  });

  it("reads list entries without their trailing notes", () => {
    const { root } = tree({
      "list.txt": "# heading\nsrc/a.ts\nsrc/b.ts  # hand-edited\n\n",
    });

    expect(readFileList(NodePath.join(root, "list.txt"))).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("finds nothing to change in the files this repository rebrands", () => {
    const root = NodePath.dirname(import.meta.dirname);
    const files = readFileList(NodePath.join(import.meta.dirname, "rebrand-files.txt"));

    expect(files.filter((file) => file.startsWith(".repos/"))).toEqual([]);
    expect(rebrand({ root, files, write: false })).toEqual([]);
  });
});
