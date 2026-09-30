import { assert, it } from "@effect/vitest";
import { parseOpenWorkDiff } from "./reviewDiff.ts";

it("preserves Git metadata paths containing tabs, newlines, colons, and log markers", () => {
  const oldPath = "1\t2\tfoo";
  const newPath = ":100644 100644 aaaaaaa bbbbbbb M";
  const nextPath = "t3-commit\nfile";
  const output = [
    "\n:100644 100644 aaaaaaa bbbbbbb R100",
    oldPath,
    newPath,
    ":000000 100644 0000000 aaaaaaa A",
    nextPath,
    "0\t0\t",
    oldPath,
    newPath,
    "1\t0\t" + nextPath,
    "",
  ].join("\0");
  assert.deepEqual(parseOpenWorkDiff(output), [
    { path: newPath, previousPath: oldPath, status: "renamed", insertions: 0, deletions: 0 },
    { path: nextPath, previousPath: null, status: "added", insertions: 1, deletions: 0 },
  ]);
});
