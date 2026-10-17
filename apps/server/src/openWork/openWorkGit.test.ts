import { assert, describe, it } from "@effect/vitest";

import {
  completeFields,
  groupWip,
  LOG_RECORD_MARKER,
  parseDiffRecords,
  parseLogRecords,
  parseWorktreeList,
  pathKey,
  selectBaseRef,
} from "./openWorkGit.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("parseDiffRecords", () => {
  it("keeps paths containing tabs, newlines, colons, and record markers intact", () => {
    const oldPath = "1\t2\tfoo";
    const newPath = ":100644 100644 aaaaaaa bbbbbbb M";
    const nextPath = `${LOG_RECORD_MARKER}\nfile`;
    const fields = [
      "\n:100644 100644 aaaaaaa bbbbbbb R100",
      oldPath,
      newPath,
      ":000000 100644 0000000 aaaaaaa A",
      nextPath,
      "0\t0\t",
      oldPath,
      newPath,
      `1\t0\t${nextPath}`,
      "",
    ];
    assert.deepStrictEqual(parseDiffRecords(fields), [
      { path: newPath, previousPath: oldPath, status: "renamed", insertions: 0, deletions: 0 },
      { path: nextPath, previousPath: null, status: "added", insertions: 1, deletions: 0 },
    ]);
  });

  it("counts binary files as zero lines and keeps unmerged paths numstat omits", () => {
    const fields = [
      ":100644 100644 aaaaaaa bbbbbbb M",
      "image.png",
      ":000000 000000 0000000 0000000 U",
      "conflict.txt",
      "-\t-\timage.png",
      "",
    ];
    assert.deepStrictEqual(parseDiffRecords(fields), [
      { path: "image.png", previousPath: null, status: "modified", insertions: 0, deletions: 0 },
      {
        path: "conflict.txt",
        previousPath: null,
        status: "conflicted",
        insertions: 0,
        deletions: 0,
      },
    ]);
  });
});

describe("parseLogRecords", () => {
  it("splits commits only at real record markers and reads each shortstat", () => {
    const stdout = [
      "",
      LOG_RECORD_MARKER,
      SHA_A,
      "",
      `${LOG_RECORD_MARKER} in a subject, 9 files changed`,
      "2026-10-01T10:00:00+02:00",
      "",
      "\n 1 file changed, 2 insertions(+)\n",
      LOG_RECORD_MARKER,
      SHA_B,
      SHA_A,
      "second",
      "2026-10-02T10:00:00Z",
      "",
      "\n 3 files changed, 1 insertion(+), 4 deletions(-)\n",
      LOG_RECORD_MARKER,
      "c".repeat(40),
      SHA_B,
      "empty",
      "2026-10-03T10:00:00Z",
      "",
    ].join("\0");
    assert.deepStrictEqual(parseLogRecords(stdout), [
      {
        sha: SHA_A,
        parents: [],
        subject: `${LOG_RECORD_MARKER} in a subject, 9 files changed`,
        committedAt: "2026-10-01T10:00:00+02:00",
        fileCount: 1,
        insertions: 2,
        deletions: 0,
      },
      {
        sha: SHA_B,
        parents: [SHA_A],
        subject: "second",
        committedAt: "2026-10-02T10:00:00Z",
        fileCount: 3,
        insertions: 1,
        deletions: 4,
      },
      {
        sha: "c".repeat(40),
        parents: [SHA_B],
        subject: "empty",
        committedAt: "2026-10-03T10:00:00Z",
        fileCount: 0,
        insertions: 0,
        deletions: 0,
      },
    ]);
  });
});

describe("completeFields", () => {
  it("drops the partial field and marker of cut output", () => {
    assert.deepStrictEqual(completeFields("a\0b\0par[truncated]", true), ["a", "b"]);
    assert.deepStrictEqual(completeFields("a\0b\0", false), ["a", "b", ""]);
  });

  it("parses cut diff records up to the last complete one", () => {
    const fields = completeFields(
      [
        ":000000 100644 0000000 aaaaaaa A",
        "kept.txt",
        ":000000 100644 0000000 bbbbbbb A",
        "cut",
      ].join("\0"),
      true,
    );
    assert.deepStrictEqual(parseDiffRecords(fields), [
      { path: "kept.txt", previousPath: null, status: "added", insertions: 0, deletions: 0 },
    ]);
  });
});

describe("pathKey", () => {
  it("matches Windows paths across drive-letter case, separators, and a trailing separator", () => {
    assert.strictEqual(
      pathKey("C:\\Repos\\Satellite\\", "win32"),
      pathKey("c:/repos/satellite", "win32"),
    );
    assert.notStrictEqual(pathKey("/Repos/A", "darwin"), pathKey("/repos/a", "darwin"));
    assert.strictEqual(pathKey("/repos/a/", "linux"), "/repos/a");
  });
});

describe("parseWorktreeList", () => {
  it("reads branch, detached and unborn heads, and leaves out bare and prunable entries", () => {
    const stdout = [
      "worktree /repos/bare.git",
      "bare",
      "",
      "worktree /repos/feature with\nnewline",
      `HEAD ${SHA_A}`,
      "branch refs/heads/feature/with/slashes",
      "",
      "worktree /repos/detached",
      `HEAD ${SHA_B}`,
      "detached",
      "locked",
      "",
      "worktree /repos/gone",
      `HEAD ${SHA_B}`,
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree /repos/fresh",
      `HEAD ${"0".repeat(40)}`,
      "branch refs/heads/main",
      "",
      "",
    ].join("\0");
    assert.deepStrictEqual(parseWorktreeList(stdout), [
      {
        path: "/repos/feature with\nnewline",
        head: SHA_A,
        branch: "feature/with/slashes",
        primary: false,
      },
      { path: "/repos/detached", head: SHA_B, branch: null, primary: false },
      { path: "/repos/fresh", head: null, branch: "main", primary: false },
    ]);
  });

  it("marks the first listed worktree as the primary checkout", () => {
    const stdout = [
      "worktree /repos/main",
      `HEAD ${SHA_A}`,
      "branch refs/heads/main",
      "",
      "worktree /repos/linked",
      `HEAD ${SHA_B}`,
      "detached",
      "",
      "",
    ].join("\0");
    assert.deepStrictEqual(
      parseWorktreeList(stdout).map(({ path, primary }) => [path, primary]),
      [
        ["/repos/main", true],
        ["/repos/linked", false],
      ],
    );
  });
});

describe("selectBaseRef", () => {
  const listing = (...lines: ReadonlyArray<string>) => lines.join("\n");

  it("prefers origin's main, then local main, then origin's HEAD target, then master", () => {
    assert.deepStrictEqual(
      selectBaseRef(
        listing("refs/heads/main\0", "refs/remotes/origin/HEAD\0refs/remotes/origin/trunk"),
      ),
      { ref: "refs/heads/main", name: "main" },
    );
    assert.deepStrictEqual(
      selectBaseRef(listing("refs/heads/main\0", "refs/remotes/origin/main\0")),
      { ref: "refs/remotes/origin/main", name: "origin/main" },
    );
    assert.deepStrictEqual(
      selectBaseRef(
        listing("refs/remotes/origin/HEAD\0refs/remotes/origin/trunk", "refs/heads/master\0"),
      ),
      { ref: "refs/remotes/origin/trunk", name: "origin/trunk" },
    );
    assert.deepStrictEqual(selectBaseRef(listing("refs/heads/master\0")), {
      ref: "refs/heads/master",
      name: "master",
    });
  });

  it("ignores refs nested under a candidate name and finds nothing in an empty listing", () => {
    assert.strictEqual(selectBaseRef(listing("refs/heads/main/feature\0")), null);
    assert.strictEqual(selectBaseRef(""), null);
  });
});

describe("groupWip", () => {
  const file = (path: string, insertions: number) => ({
    path,
    previousPath: null,
    status: "modified" as const,
    insertions,
    deletions: 1,
  });

  it("orders by path then layer, caps the list, and totals every file", () => {
    const wip = groupWip(
      {
        staged: [file("b.txt", 2)],
        unstaged: [file("b.txt", 3), file("a.txt", 4)],
        untracked: ["c/new.txt"],
        cut: false,
      },
      3,
    );
    assert.deepStrictEqual(
      wip.files.map(({ path, layer }) => [path, layer]),
      [
        ["a.txt", "unstaged"],
        ["b.txt", "staged"],
        ["b.txt", "unstaged"],
      ],
    );
    assert.deepStrictEqual(
      { insertions: wip.insertions, deletions: wip.deletions, truncated: wip.truncated },
      { insertions: 9, deletions: 3, truncated: true },
    );
  });
});
