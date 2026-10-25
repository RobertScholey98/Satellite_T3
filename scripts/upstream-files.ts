// @effect-diagnostics nodeBuiltinImport:off - a few git calls with no services to provide.
/**
 * Lists the upstream-owned files a git range touches, for the upstream file list a PR body needs.
 * A path counts as upstream when it exists in the last upstream commit the head has merged, so
 * files Satellite added are left out. `--first-parent` keeps only the branch's own commits and
 * leaves out files that arrived through a merged branch.
 *
 *   node scripts/upstream-files.ts <base>..<head> [--first-parent] [--upstream <ref>]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const USAGE =
  "Usage: node scripts/upstream-files.ts <base>..<head> [--first-parent] [--upstream <ref>]";
const DEFAULT_UPSTREAM = "upstream/main";

export interface Range {
  readonly base: string;
  readonly head: string;
}

/** Accepts only `base..head`; the three-dot form is rejected so the range means one thing. */
export function parseRange(arg: string | undefined): Range | undefined {
  if (arg === undefined || arg.includes("...")) return undefined;
  const [base, head, ...rest] = arg.split("..");
  if (!base || !head || rest.length > 0) return undefined;
  return { base, head };
}

export function parseCli(argv: ReadonlyArray<string>) {
  let parsed;
  try {
    parsed = NodeUtil.parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        "first-parent": { type: "boolean", default: false },
        upstream: { type: "string", default: DEFAULT_UPSTREAM },
      },
    });
  } catch {
    return undefined;
  }
  if (parsed.positionals.length !== 1) return undefined;
  const range = parseRange(parsed.positionals[0]);
  if (range === undefined || parsed.values.upstream === "") return undefined;
  return {
    range,
    firstParent: parsed.values["first-parent"],
    upstreamRef: parsed.values.upstream,
  };
}

export function upstreamFiles(
  changed: Iterable<string>,
  upstreamTree: ReadonlySet<string>,
): Array<string> {
  return [...new Set(changed)].filter((path) => upstreamTree.has(path)).toSorted();
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const splitNul = (output: string) => output.split("\0").filter((path) => path !== "");

/** The commit SHA `ref` names, or undefined when it names no commit. */
export function verifyCommit(cwd: string, ref: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch {
    return undefined;
  }
}

/**
 * The last upstream commit `head` has merged. Upstream syncs merge `upstream/main` without recording
 * a SHA, so the merge-base is that commit even after upstream moves on. Undefined means the
 * histories are unrelated.
 */
export function resolveUpstream(cwd: string, head: string, ref: string): string | undefined {
  try {
    return git(cwd, ["merge-base", head, ref]).trim();
  } catch {
    return undefined;
  }
}

/**
 * A local upstream ref older than the last sync gives an older merge-base, and files upstream
 * added since then are misread as Satellite's. The script does not fetch, so the most it can tell
 * is that the ref has not moved past what `head` already merged, which is what a stale ref looks
 * like.
 */
export function isStale(cwd: string, ref: string, head: string): boolean {
  try {
    git(cwd, ["merge-base", "--is-ancestor", ref, head]);
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

export function readUpstreamTree(cwd: string, commit: string): ReadonlySet<string> {
  return new Set(splitNul(git(cwd, ["ls-tree", "-r", "-z", "--name-only", commit])));
}

/** The paths the PR diff shows, merges included. */
export function readRangeFiles(cwd: string, range: Range): Array<string> {
  return splitNul(
    git(cwd, ["diff", "--name-only", "-z", "--no-renames", `${range.base}...${range.head}`]),
  );
}

/**
 * The paths the branch's own non-merge commits change; a conflict resolution made inside a merge
 * commit is therefore not listed.
 */
export function readOwnCommitFiles(cwd: string, range: Range): Array<string> {
  return splitNul(
    git(cwd, [
      "log",
      "--first-parent",
      "--no-merges",
      "--name-only",
      "-z",
      "--format=",
      "--no-renames",
      `${range.base}..${range.head}`,
    ]),
  );
}

function run(cwd: string, cli: NonNullable<ReturnType<typeof parseCli>>): number {
  const { range, firstParent, upstreamRef } = cli;
  for (const ref of [range.base, range.head, upstreamRef]) {
    if (verifyCommit(cwd, ref) !== undefined) continue;
    process.stderr.write(`Unknown ref: ${ref}\n`);
    if (ref === upstreamRef) {
      process.stderr.write("Run `git fetch upstream`, or pass --upstream <ref>.\n");
    }
    return 1;
  }
  const upstream = resolveUpstream(cwd, range.head, upstreamRef);
  if (upstream === undefined) {
    process.stderr.write(`${range.head} and ${upstreamRef} have unrelated histories.\n`);
    return 1;
  }
  process.stderr.write(`upstream: ${upstreamRef} at merge-base ${upstream.slice(0, 10)}\n`);
  // An explicit ref, such as the SHA of the last sync, is merged into head by design.
  if (upstreamRef === DEFAULT_UPSTREAM && isStale(cwd, upstreamRef, range.head)) {
    process.stderr.write(
      `warning: ${upstreamRef} is fully merged into ${range.head}; if it was fetched before the last upstream sync, files upstream added since are missing. Run \`git fetch upstream\`.\n`,
    );
  }
  const changed = firstParent ? readOwnCommitFiles(cwd, range) : readRangeFiles(cwd, range);
  for (const file of upstreamFiles(changed, readUpstreamTree(cwd, upstream))) {
    process.stdout.write(`${file}\n`);
  }
  return 0;
}

function main(argv: ReadonlyArray<string>) {
  const cli = parseCli(argv);
  if (cli === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  try {
    process.exitCode = run(process.cwd(), cli);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    process.stderr.write(stderr ? stderr : `${String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
