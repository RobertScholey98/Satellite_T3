import { assert, describe, it } from "@effect/vitest";

import {
  groupWip,
  LOG_RECORD_MARKER,
  parseDiffRecords,
  parseLogRecords,
  parseWorktreeList,
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
  it("splits commits only at real record markers", () => {
    const stdout = [
      "",
      LOG_RECORD_MARKER,
      SHA_A,
      "",
      `${LOG_RECORD_MARKER} in a subject`,
      "2026-10-01T10:00:00+02:00",
      "\n:000000 100644 0000000 aaaaaaa A",
      LOG_RECORD_MARKER,
      `2\t0\t${LOG_RECORD_MARKER}`,
      "",
      LOG_RECORD_MARKER,
      SHA_B,
      SHA_A,
      "second",
      "2026-10-02T10:00:00Z",
      "\n:100644 100644 aaaaaaa bbbbbbb M",
      LOG_RECORD_MARKER,
      `1\t1\t${LOG_RECORD_MARKER}`,
      "",
    ].join("\0");
    assert.deepStrictEqual(parseLogRecords(stdout), [
      {
        sha: SHA_A,
        parents: [],
        subject: `${LOG_RECORD_MARKER} in a subject`,
        committedAt: "2026-10-01T10:00:00+02:00",
        files: [
          {
            path: LOG_RECORD_MARKER,
            previousPath: null,
            status: "added",
            insertions: 2,
            deletions: 0,
          },
        ],
      },
      {
        sha: SHA_B,
        parents: [SHA_A],
        subject: "second",
        committedAt: "2026-10-02T10:00:00Z",
        files: [
          {
            path: LOG_RECORD_MARKER,
            previousPath: null,
            status: "modified",
            insertions: 1,
            deletions: 1,
          },
        ],
      },
    ]);
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
