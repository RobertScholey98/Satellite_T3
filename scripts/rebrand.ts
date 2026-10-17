// @effect-diagnostics nodeBuiltinImport:off - a plain text rewrite with no services to provide.
/**
 * Rewrites upstream's product name to Satellite's in every file `rebrand-files.txt` lists. After an
 * upstream sync, take upstream's side of a rebrand-only conflict and rerun this. With `--check` it
 * writes nothing, lists the files it would change, and exits 1 when there are any.
 *
 *   node scripts/rebrand.ts [--check]
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { PRODUCT_NAME } from "../packages/contracts/src/productIdentity.ts";

const UPSTREAM_PRODUCT_NAME = "T3 Code";

export const rebrandText = (text: string) => text.replaceAll(UPSTREAM_PRODUCT_NAME, PRODUCT_NAME);

export const readFileList = (listPath: string) =>
  NodeFS.readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

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

if (import.meta.main) {
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
