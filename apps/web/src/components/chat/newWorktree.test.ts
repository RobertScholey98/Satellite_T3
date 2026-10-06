import { describe, expect, it } from "vite-plus/test";
import { projectWorktreePath } from "./newWorktree";

describe("projectWorktreePath", () => {
  it.each([
    ["C:\\code\\appRepo", "C:\\code\\appRepo\\worktree1"],
    ["C:\\code\\appRepo\\", "C:\\code\\appRepo\\worktree1"],
    ["C:/code/appRepo", "C:/code/appRepo/worktree1"],
    ["\\\\server\\share\\appRepo", "\\\\server\\share\\appRepo\\worktree1"],
    ["/home/user/appRepo/", "/home/user/appRepo/worktree1"],
    ["/", "/worktree1"],
  ])("uses the environment path style for %s", (root, expected) => {
    expect(projectWorktreePath(root, "worktree1")).toBe(expected);
  });

  it.each([
    "",
    " ",
    ".",
    "..",
    "../outside",
    "..\\outside",
    "/tmp/tree",
    "C:\\tree",
    "a/b",
    ".git",
    "NUL",
    "con.txt",
    "worktree.",
    "a:b",
    "a\nname",
  ])("rejects invalid child folder %j", (folder) =>
    expect(projectWorktreePath("C:\\repo", folder)).toBeNull(),
  );
});
