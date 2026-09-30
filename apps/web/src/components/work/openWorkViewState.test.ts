import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  readOpenWorkSelection,
  readOpenWorkSnapshot,
  saveOpenWorkSelection,
  saveOpenWorkSnapshot,
  type OpenWorkSnapshot,
} from "./openWorkViewState";

const snapshot = (selectedId: string): OpenWorkSnapshot => ({
  worktrees: [],
  selectedId,
  timeline: null,
  favorites: [],
  attempts: [],
  diff: null,
  opened: {
    documentId: "doc",
    title: "Plan",
    format: "markdown",
    content: "Retained document",
    truncated: false,
    live: false,
    cwd: "/work",
  },
});
describe("open work remount state", () => {
  it("retains loaded document and selection for a later mount and isolates environments", () => {
    const first = EnvironmentId.make("cache-first");
    const second = EnvironmentId.make("cache-second");
    saveOpenWorkSnapshot(first, snapshot("selected"));
    expect(readOpenWorkSnapshot(first)?.selectedId).toBe("selected");
    expect(readOpenWorkSnapshot(first)?.opened?.content).toBe("Retained document");
    expect(readOpenWorkSnapshot(second)).toBeUndefined();
    expect(readOpenWorkSnapshot(first, "/explicit")?.opened).toBeNull();
    expect(readOpenWorkSnapshot(first, "/explicit")?.selectedId).toBeNull();
  });
  it("bounds retained environments and evicts the least recently saved entry", () => {
    for (let index = 0; index < 7; index++)
      saveOpenWorkSnapshot(EnvironmentId.make(`bounded-${index}`), snapshot(String(index)));
    expect(readOpenWorkSnapshot(EnvironmentId.make("bounded-0"))).toBeUndefined();
    expect(readOpenWorkSnapshot(EnvironmentId.make("bounded-6"))?.selectedId).toBe("6");
  });
  it("restores durable selections, rejects malformed storage, and tolerates blocked storage", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key),
      setItem: (key: string, value: string) => data.set(key, value),
    });
    const id = EnvironmentId.make("durable");
    saveOpenWorkSelection(id, "/repo/worktree");
    expect(readOpenWorkSelection()).toEqual({ environmentId: id, worktreePath: "/repo/worktree" });
    for (const key of data.keys()) data.set(key, '{"environmentId":42}');
    expect(readOpenWorkSelection()).toBeUndefined();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readOpenWorkSelection()).toBeUndefined();
    expect(() => saveOpenWorkSelection(id)).not.toThrow();
    vi.unstubAllGlobals();
  });
});
