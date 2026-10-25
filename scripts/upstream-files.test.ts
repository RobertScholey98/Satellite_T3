// @effect-diagnostics nodeBuiltinImport:off - builds a throwaway git repository on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  isStale,
  parseCli,
  parseRange,
  readOwnCommitFiles,
  readRangeFiles,
  readUpstreamTree,
  resolveUpstream,
  upstreamFiles,
  verifyCommit,
} from "./upstream-files.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function repo() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-files-"));
  roots.push(root);
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const commit = (files: Record<string, string | null>) => {
    for (const [file, text] of Object.entries(files)) {
      const path = NodePath.join(root, file);
      if (text === null) NodeFS.rmSync(path);
      else {
        NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
        NodeFS.writeFileSync(path, text);
      }
    }
    git("add", "-A");
    git("commit", "-q", "-m", Object.keys(files).join(" "));
  };
  git("init", "-q", "-b", "upstream");
  return { root, git, commit };
}

describe("upstreamFiles", () => {
  it("keeps upstream paths, drops Satellite-added ones, and dedupes and sorts", () => {
    const tree = new Set(["apps/web/src/b.ts", "apps/web/src/a.ts", "packages/removed.ts"]);

    expect(
      upstreamFiles(
        [
          "apps/web/src/b.ts",
          "packages/client-runtime/src/state/factory.ts",
          "packages/removed.ts",
          "apps/web/src/a.ts",
          "apps/web/src/b.ts",
        ],
        tree,
      ),
    ).toEqual(["apps/web/src/a.ts", "apps/web/src/b.ts", "packages/removed.ts"]);
  });
});

describe("parseRange", () => {
  it("accepts base..head", () => {
    expect(parseRange("main..feature/x")).toEqual({ base: "main", head: "feature/x" });
  });

  it.each(["a...b", "a", "", "..b", "a..", "a..b..c", undefined])("rejects %j", (arg) => {
    expect(parseRange(arg)).toBeUndefined();
  });
});

describe("reading a repository", () => {
  it("lists merged-in upstream files for the full range and only the branch's own with first-parent", () => {
    const { root, git, commit } = repo();
    commit({ "own.ts": "1", "merged.ts": "1", "gone.ts": "1" });
    const upstreamSha = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "main");
    commit({ "satellite.ts": "1" });
    git("checkout", "-q", "-b", "other");
    commit({ "merged.ts": "2" });
    git("checkout", "-q", "-b", "feature", "main");
    commit({ "own.ts": "2", "gone.ts": null, "satellite.ts": "2" });
    git("merge", "-q", "--no-ff", "-m", "merge other", "other");
    // Upstream moves on after the sync; the merge-base still names the synced commit.
    git("checkout", "-q", "upstream");
    commit({ "later.ts": "1" });

    const upstream = resolveUpstream(root, "feature", "upstream");
    expect(upstream).toBe(upstreamSha);
    const tree = readUpstreamTree(root, upstreamSha);
    const range = { base: "main", head: "feature" };

    expect(upstreamFiles(readRangeFiles(root, range), tree)).toEqual([
      "gone.ts",
      "merged.ts",
      "own.ts",
    ]);
    expect(upstreamFiles(readOwnCommitFiles(root, range), tree)).toEqual(["gone.ts", "own.ts"]);
  });

  it("lists a root commit's files with first-parent", () => {
    const { git, root, commit } = repo();
    commit({ "a.ts": "1" });
    git("checkout", "-q", "--orphan", "orphan");
    git("rm", "-q", "-rf", ".");
    commit({ "b.ts": "1" });

    expect(readOwnCommitFiles(root, { base: "upstream", head: "orphan" })).toEqual(["b.ts"]);
  });

  it("does not verify a ref that names no commit", () => {
    const { git, root, commit } = repo();
    commit({ "a.ts": "1" });

    expect(verifyCommit(root, "upstream")).toBe(git("rev-parse", "HEAD"));
    expect(verifyCommit(root, "missing/main")).toBeUndefined();
  });

  it("calls the upstream ref stale until it moves past the last sync", () => {
    const { git, root, commit } = repo();
    commit({ "a.ts": "1" });
    git("checkout", "-q", "-b", "main");
    commit({ "satellite.ts": "1" });
    git("checkout", "-q", "upstream");
    commit({ "b.ts": "1" });
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "sync", "upstream");

    expect(isStale(root, "upstream", "main")).toBe(true);
    git("checkout", "-q", "upstream");
    commit({ "c.ts": "1" });
    expect(isStale(root, "upstream", "main")).toBe(false);
  });
});

describe("parseCli", () => {
  const range = { base: "a", head: "b" };

  it.each([
    [["a..b"], { range, firstParent: false, upstreamRef: "upstream/main" }],
    [["--first-parent", "a..b"], { range, firstParent: true, upstreamRef: "upstream/main" }],
    [["a..b", "--upstream=origin/x"], { range, firstParent: false, upstreamRef: "origin/x" }],
    [["a..b", "--upstream", "origin/x"], { range, firstParent: false, upstreamRef: "origin/x" }],
    [["a..b", "--upstream"], undefined],
    [["a..b", "--upstream", "--first-parent"], undefined],
    [["a..b", "c..d"], undefined],
    [["a..b", "--bogus"], undefined],
    [[], undefined],
  ])("parses %j", (argv, expected) => {
    expect(parseCli(argv)).toEqual(expected);
  });
});
