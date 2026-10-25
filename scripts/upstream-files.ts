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

/** The changed paths that exist in the upstream tree, deduped and sorted. */
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

const paths = (output: string) => output.split("\0").filter((path) => path !== "");

/**
 * The last upstream commit `head` has merged. Upstream syncs merge `upstream/main` without recording
 * a SHA, so the merge-base is that commit even after upstream moves on. A local `upstream/main`
 * older than the last sync gives an older merge-base, and files upstream added since then are
 * misread as Satellite's.
 */
export function resolveUpstream(cwd: string, head: string, ref: string): string | undefined {
  try {
    return git(cwd, ["merge-base", head, ref]).trim();
  } catch {
    return undefined;
  }
}

export function readUpstreamTree(cwd: string, commit: string): ReadonlySet<string> {
  return new Set(paths(git(cwd, ["ls-tree", "-r", "-z", "--name-only", commit])));
}

/**
 * Without `firstParent`, the paths the PR diff shows, merges included. With it, the paths the
 * branch's own non-merge commits change; a conflict resolution made inside a merge commit is
 * therefore not listed.
 */
export function readChangedFiles(cwd: string, range: Range, firstParent: boolean): Array<string> {
  if (!firstParent) {
    return paths(
      git(cwd, ["diff", "--name-only", "-z", "--no-renames", `${range.base}...${range.head}`]),
    );
  }
  const commits = git(cwd, [
    "rev-list",
    "--first-parent",
    "--no-merges",
    `${range.base}..${range.head}`,
  ])
    .split("\n")
    .filter((commit) => commit !== "");
  return commits.flatMap((commit) =>
    paths(
      git(cwd, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        "--no-renames",
        commit,
      ]),
    ),
  );
}

function main(argv: ReadonlyArray<string>) {
  let rangeArg: string | undefined;
  let firstParent = false;
  let upstreamRef = DEFAULT_UPSTREAM;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--first-parent") firstParent = true;
    else if (arg === "--upstream" && argv[index + 1] !== undefined) upstreamRef = argv[++index]!;
    else if (rangeArg === undefined && !arg?.startsWith("-")) rangeArg = arg;
    else rangeArg = "";
  }
  const range = parseRange(rangeArg);
  if (range === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }

  const cwd = process.cwd();
  const upstream = resolveUpstream(cwd, range.head, upstreamRef);
  if (upstream === undefined) {
    process.stderr.write(
      `Could not find a merge-base of ${range.head} with ${upstreamRef}. Run \`git fetch upstream\`, or pass --upstream <ref>.\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `upstream: ${upstreamRef} at merge-base ${git(cwd, ["rev-parse", "--short", upstream]).trim()}\n`,
  );
  const files = upstreamFiles(
    readChangedFiles(cwd, range, firstParent),
    readUpstreamTree(cwd, upstream),
  );
  for (const file of files) process.stdout.write(`${file}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
