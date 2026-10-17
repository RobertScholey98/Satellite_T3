// @effect-diagnostics nodeBuiltinImport:off - exercises a plain-Node script against a temp tree.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readFileList, readListEntries, readUpstreamBase, rebrand, verify } from "./rebrand.ts";

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

  it("flags a listed file carrying an edit the script does not make", () => {
    const upstream: Record<string, string> = {
      "src/rewrapped.ts": 'fail("T3 Code could not open the project in time");\n',
      "src/stray.ts": 'export const name = "T3 Code";\n',
    };
    const { root } = tree({
      "src/rewrapped.ts": 'fail(\n  "Satellite could not open the project in time",\n);\n',
      "src/stray.ts": 'export const name = "Satellite";\nexport const extra = 1;\n',
    });

    expect(
      verify({
        root,
        files: ["src/rewrapped.ts", "src/stray.ts"],
        readUpstream: (file) => upstream[file] ?? "",
      }),
    ).toEqual(["src/stray.ts"]);
  });

  it("reads hand-edited marks and the upstream base from the list", () => {
    const { root } = tree({
      "list.txt": `# upstream-base: ${"a".repeat(40)}\nsrc/a.ts\nsrc/b.ts  # hand-edited\n`,
    });
    const listPath = NodePath.join(root, "list.txt");

    expect(readListEntries(listPath)).toEqual([
      { file: "src/a.ts", handEdited: false },
      { file: "src/b.ts", handEdited: true },
    ]);
    expect(readUpstreamBase(listPath)).toBe("a".repeat(40));
  });

  it("finds nothing to change in the files this repository rebrands", () => {
    const root = NodePath.dirname(import.meta.dirname);
    const files = readFileList(NodePath.join(import.meta.dirname, "rebrand-files.txt"));

    expect(files.filter((file) => file.startsWith(".repos/"))).toEqual([]);
    expect(rebrand({ root, files, write: false })).toEqual([]);
  });
});
