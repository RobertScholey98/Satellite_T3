import { describe, expect, it } from "vite-plus/test";

import { REVDOC_WORKTREE_MEMORY_LIMIT, rememberRevdocWorktree } from "./revdocWorktreeStore";

describe("rememberRevdocWorktree", () => {
  it("keeps the most recently picked threads and forgets on Thread default", () => {
    let memory: Record<string, string> = {};
    for (let index = 0; index <= REVDOC_WORKTREE_MEMORY_LIMIT; index++) {
      memory = rememberRevdocWorktree(memory, `thread-${index}`, `/work/${index}`);
    }
    expect(Object.keys(memory)).toHaveLength(REVDOC_WORKTREE_MEMORY_LIMIT);
    expect(memory["thread-0"]).toBeUndefined();
    memory = rememberRevdocWorktree(memory, "thread-1", "/work/again");
    expect(Object.keys(memory).at(-1)).toBe("thread-1");
    memory = rememberRevdocWorktree(memory, "thread-1", null);
    expect(memory["thread-1"]).toBeUndefined();
  });
});
