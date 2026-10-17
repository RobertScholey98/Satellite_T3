// @effect-diagnostics nodeBuiltinImport:off - a plain text rewrite with no services to provide.
/**
 * Rewrites upstream's product name to Satellite's in every file `rebrand-files.txt` lists. After an
 * upstream sync, take upstream's side of a rebrand-only conflict and rerun this. With `--check` it
 * writes nothing, lists the files it would change, and exits 1 when there are any. With `--verify`
 * it checks that every listed file not marked hand-edited is exactly the script's output on the
 * upstream commit the list names (formatter rewraps aside), and lists the ones that are not.
 *
 *   node scripts/rebrand.ts [--check | --verify]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { PRODUCT_NAME } from "../packages/contracts/src/productIdentity.ts";

const UPSTREAM_PRODUCT_NAME = "T3 Code";
/** A line carrying this marker keeps upstream's name, for text recorded in replay fixtures. */
const KEEP_MARKER = "rebrand:keep";

export const rebrandText = (text: string) =>
  text
    .split("\n")
    .map((line) =>
      line.includes(KEEP_MARKER) ? line : line.replaceAll(UPSTREAM_PRODUCT_NAME, PRODUCT_NAME),
    )
    .join("\n");

const HAND_EDITED_NOTE = /#\s*hand-edited\s*$/;

export const readListEntries = (listPath: string) =>
  NodeFS.readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((line) => ({
      file: line.replace(/#.*/, "").trim(),
      handEdited: HAND_EDITED_NOTE.test(line),
    }))
    .filter((entry) => entry.file !== "");

export const readFileList = (listPath: string) =>
  readListEntries(listPath).map((entry) => entry.file);

/** The upstream commit the list's files were rebranded from, named by its `# upstream-base:` line. */
export const readUpstreamBase = (listPath: string) =>
  /^# upstream-base: ([0-9a-f]{40})$/m.exec(NodeFS.readFileSync(listPath, "utf8"))?.[1];

// The formatter may rewrap a line the longer name lengthened and add trailing commas.
const ignoringFormatting = (text: string) => text.replaceAll(/[\s,]+/g, "");

/** Returns the files whose content is not the script's output on their upstream text. */
export function verify(input: {
  readonly root: string;
  readonly files: ReadonlyArray<string>;
  readonly readUpstream: (file: string) => string;
}) {
  return input.files.filter(
    (file) =>
      ignoringFormatting(rebrandText(input.readUpstream(file))) !==
      ignoringFormatting(NodeFS.readFileSync(NodePath.join(input.root, file), "utf8")),
  );
}

/** Rebrands `files` under `root` and returns the ones that changed, or would change. */
export function rebrand(input: {
  readonly root: string;
  readonly files: ReadonlyArray<string>;
  readonly write: boolean;
}) {
  const changed: Array<string> = [];
  for (const file of input.files) {
    const path = NodePath.join(input.root, file);
    const text = NodeFS.readFileSync(path, "utf8");
    const rebranded = rebrandText(text);
    if (rebranded === text) continue;
    changed.push(file);
    if (input.write) NodeFS.writeFileSync(path, rebranded);
  }
  return changed;
}

if (import.meta.main && process.argv.includes("--verify")) {
  const root = NodePath.dirname(import.meta.dirname);
  const listPath = NodePath.join(import.meta.dirname, "rebrand-files.txt");
  const base = readUpstreamBase(listPath);
  if (base === undefined) throw new Error(`${listPath} names no "# upstream-base: <sha>".`);
  const drifted = verify({
    root,
    files: readListEntries(listPath)
      .filter((entry) => !entry.handEdited)
      .map((entry) => entry.file),
    readUpstream: (file) =>
      NodeChildProcess.execFileSync("git", ["show", `${base}:${file}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
  });
  for (const file of drifted) process.stdout.write(`${file}\n`);
  if (drifted.length > 0) {
    process.stderr.write(
      `${drifted.length} listed file(s) carry edits the script does not make. Mark them hand-edited in scripts/rebrand-files.txt, or move the edit out.\n`,
    );
    process.exit(1);
  }
} else if (import.meta.main) {
  const check = process.argv.includes("--check");
  const changed = rebrand({
    root: NodePath.dirname(import.meta.dirname),
    files: readFileList(NodePath.join(import.meta.dirname, "rebrand-files.txt")),
    write: !check,
  });
  for (const file of changed) process.stdout.write(`${file}\n`);
  if (check && changed.length > 0) {
    process.stderr.write(
      `${changed.length} file(s) still name upstream's product. Run node scripts/rebrand.ts.\n`,
    );
    process.exit(1);
  }
}
