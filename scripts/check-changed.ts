// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Runs CI's fast checks for this branch's changes: format and lint of the
// changed files, knip, generated GraphQL operations, typecheck of the affected
// packages and their dependents, and the test files beside the changed files.
// CI still runs the full test suites and the jobs listed in the summary.
//
//   vp run check:changed          compare against the merge base with origin/main
//   vp run check:changed <ref>    compare against the merge base with <ref>
//
// Uncommitted and untracked files count. Affected packages come from
// .github/scripts/ci-changes.cjs, the same mapping CI uses to gate its jobs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";
import { readFileList, readUpstreamBase } from "./rebrand.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
// Run the workspace's vp entry with this Node instead of spawning `vp`. On
// Windows node_modules/.bin only has a `vp.cmd` shim, which Node refuses to
// spawn without a shell, and a shell would split changed paths on spaces.
const VP = NodePath.join(root, "node_modules", "vite-plus", "bin", "vp");
const CODE = /\.[cm]?[jt]sx?$/;

const git = (...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

const ref = process.argv[2] ?? "origin/main";
const mergeBase = NodeChildProcess.spawnSync("git", ["merge-base", "HEAD", ref], {
  cwd: root,
  encoding: "utf8",
});
if (mergeBase.status !== 0) {
  console.error(
    `check:changed: no merge base with ${ref}. Run \`git fetch origin\` or pass a ref.`,
  );
  process.exit(1);
}
const base = mergeBase.stdout.trim();
// --no-renames lists a rename as its old and new path, as CI does.
const untracked = git("ls-files", "--others", "--exclude-standard");
const files = [
  ...new Set([...git("diff", "--name-only", "--no-renames", base, "--"), ...untracked]),
].sort();

if (files.length === 0) {
  console.log(`check:changed: no changes since ${base.slice(0, 12)}.`);
  process.exit(0);
}

const present = files.filter((file) => NodeFS.existsSync(NodePath.join(root, file)));
const code = present.filter((file) => CODE.test(file));
const packages = readWorkspace();
const { affected, outputs } = decide(files, packages, false);

// Changed test files, and the test files beside a changed source file
// (foo.ts -> foo.test.ts, foo.browser.test.tsx). Vitest's import-graph
// `related` reaches most of a package: one leaf server file pulled in 252 of
// 406 server test files and took 7 minutes. CI runs the rest. Git's paths use
// `/`, so a Windows join would list the same test a second time.
const TEST = /\.test\.[cm]?[jt]sx?$/;
const tests = new Set(code.filter((file) => TEST.test(file)));
for (const file of code) {
  const dir = NodePath.dirname(file);
  const prefix = `${NodePath.basename(file).replace(CODE, "")}.`;
  for (const entry of NodeFS.readdirSync(NodePath.join(root, dir))) {
    if (entry.startsWith(prefix) && TEST.test(entry)) tests.add(NodePath.posix.join(dir, entry));
  }
}

// knip:check takes about 35 s and cannot be scoped to a package. Any code
// change can leave a file, export, or dependency unused (removing the last
// import of a helper does), so it runs whenever code or a manifest changes.
const runKnip = files.some(
  (file) => CODE.test(file) || NodePath.basename(file) === "package.json" || file === "knip.jsonc",
);

// CI's Lint job checks that generated GraphQL operations match their sources.
const graphql = ["apps/server", "packages/source-control-github"].filter((dir) =>
  files.some((file) => file.startsWith(`${dir}/`)),
);

// CI's "Check rebrand" step, for a change to a listed file or to the list.
const REBRAND_LIST = "scripts/rebrand-files.txt";
const rebrandListed = new Set(readFileList(NodePath.join(root, REBRAND_LIST)));
const runRebrand = files.some((file) => file === REBRAND_LIST || rebrandListed.has(file));
// --verify reads the list's upstream base commit. It is in main's history, so
// only a shallow or partial clone lacks it. CI fetches it; this script stays
// offline and fails with the fetch command rather than skip the check.
const upstreamBase = runRebrand ? readUpstreamBase(NodePath.join(root, REBRAND_LIST)) : undefined;
const missingUpstreamBase =
  upstreamBase !== undefined &&
  NodeChildProcess.spawnSync("git", ["cat-file", "-e", `${upstreamBase}^{commit}`], { cwd: root })
    .status !== 0;

const filters = (names: ReadonlyArray<string>) => names.flatMap((name) => ["--filter", name]);
const vp = (name: string, args: ReadonlyArray<string>) => ({
  name: `vp ${name}`,
  args: [VP, ...args],
});
const steps = [
  present.length > 0 &&
    vp("format", ["fmt", "--check", "--no-error-on-unmatched-pattern", ...present]),
  code.length > 0 && vp("lint", ["lint", ...code]),
  runKnip && vp("knip", ["run", "knip:check"]),
  ...graphql.map((dir) =>
    vp(`graphql (${dir})`, ["run", "--filter", `./${dir}`, "generate", "--check"]),
  ),
  affected.length > 0 &&
    vp(`typecheck (${affected.length} packages)`, [
      "run",
      "--cache",
      "--concurrency-limit",
      "4",
      ...filters(affected),
      "typecheck",
    ]),
  // From the repo root, the root vite.config.ts hands each file to its package's config.
  tests.size > 0 &&
    vp(`test (${tests.size} files)`, ["test", "run", "--passWithNoTests", ...tests]),
  runRebrand && { name: "rebrand --check", args: ["scripts/rebrand.ts", "--check"] },
  runRebrand &&
    !missingUpstreamBase && { name: "rebrand --verify", args: ["scripts/rebrand.ts", "--verify"] },
].filter((step) => step !== false);

console.log(`check:changed: ${files.length} files since ${base.slice(0, 12)}`);
const results = steps.map((step) => {
  console.log(`\n> ${step.name}`);
  const started = performance.now();
  const { status, error } = NodeChildProcess.spawnSync(process.execPath, step.args, {
    cwd: root,
    stdio: "inherit",
  });
  if (error) console.error(`check:changed: ${error.message}`);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  return { name: step.name, ok: status === 0, seconds };
});
if (missingUpstreamBase) {
  console.error(
    `\n> rebrand --verify\ncheck:changed: upstream base ${upstreamBase} is not in this clone. Fetch it and rerun:\n` +
      `  git fetch --no-tags --depth=1 origin ${upstreamBase}`,
  );
  results.push({ name: "rebrand --verify", ok: false, seconds: "0.0" });
}

console.log("\ncheck:changed summary");
for (const result of results) {
  console.log(`  ${result.ok ? "pass" : "FAIL"}  ${result.name}  ${result.seconds}s`);
}
const ciOnly = Object.entries({
  "full test suites": outputs.test || outputs.test_web || outputs.test_server,
  build: outputs.build,
  rust: outputs.rust,
  "mobile native lint": outputs.mobile_native,
  "release smoke": outputs.release_smoke,
}).flatMap(([job, runs]) => (runs ? [job] : []));
if (ciOnly.length > 0) console.log(`  CI also runs: ${ciOnly.join(", ")}`);
if (!runKnip) console.log("  knip skipped: no code or manifest changed");
if (results.some((result) => !result.ok)) process.exit(1);
