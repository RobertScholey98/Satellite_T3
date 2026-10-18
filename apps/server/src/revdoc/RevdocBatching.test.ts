import { describe, expect, it } from "vite-plus/test";

import {
  applyCombined,
  combineGroups,
  MAX_PROMPT_BYTES,
  mergeUpserts,
  planBatches,
  splitText,
} from "./RevdocBatching.ts";
import type { CompactItem } from "./RevdocGeneration.ts";
import type { Upsert } from "./RevdocStore.ts";

const upsert = (items: Upsert["items"], title = "Checkout"): Upsert => ({
  title,
  summary: "Payment flow",
  context: "",
  items,
});
const check = (
  check: string,
  id: string | null = null,
  area = "Checkout",
  paths: string[] = [],
) => ({
  id,
  area,
  check,
  expected: "Works",
  coveredPaths: paths,
});
const compact = (index: number, note = ""): CompactItem => ({
  id: `chk-${index}`,
  area: `Area ${index}`,
  check: `Check ${index}`,
  expected: "Works",
  coveredPaths: [],
  outcome: "change_requested",
  note,
  stale: false,
});
const fitsBudget = (prompts: ReadonlyArray<{ prompt: string }>) =>
  prompts.every(({ prompt }) => Buffer.byteLength(prompt) <= MAX_PROMPT_BYTES);

describe("planBatches", () => {
  it("keeps small changes in one prompt", () => {
    const batches = planBatches({
      conversation: [],
      overview: "app.ts",
      changes: "+Payment",
      items: [],
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.prompt).toContain("+Payment");
    expect(batches[0]!.prompt).not.toContain("This is batch");
  });

  it("splits by file and hunk with headers kept, without losing text or splitting a character", () => {
    const longLine = '😀\\"'.repeat(30_000);
    const parts = splitText(longLine, 80_000);
    expect(parts.join("")).toBe(longLine);
    expect(parts.every((part) => Buffer.byteLength(JSON.stringify(part)) <= 80_000)).toBe(true);
    expect(parts.some((part) => part.includes("�"))).toBe(false);

    const patch = [
      `diff --git a/one.ts b/one.ts\n--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-Old\n+${longLine}END_ONE\n`,
      "diff --git a/two.ts b/two.ts\n--- a/two.ts\n+++ b/two.ts\n@@ -1 +1 @@\n+END_TWO\n",
    ].join("");
    const batches = planBatches({
      conversation: [],
      overview: "one.ts two.ts",
      changes: patch,
      items: [],
    });
    expect(batches.length).toBeGreaterThan(1);
    expect(fitsBudget(batches)).toBe(true);
    const all = batches.map(({ prompt }) => prompt).join("\n");
    expect(all).toContain("END_ONE");
    expect(all).toContain("END_TWO");
    expect(
      batches
        .filter(({ prompt }) => prompt.includes("😀"))
        .every(({ prompt }) => prompt.includes("b/one.ts")),
    ).toBe(true);
  });

  it("names a large untracked file in every fragment", () => {
    const batches = planBatches({
      conversation: [],
      overview: "new.ts",
      changes: `Untracked file: new.ts\n${"Untracked content\n".repeat(30_000)}`,
      items: [],
    });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every(({ prompt }) => prompt.includes("Untracked file: new.ts"))).toBe(true);
    expect(
      batches
        .map(({ prompt }) => prompt)
        .join("\n")
        .match(/Untracked content/g),
    ).toHaveLength(30_000);
  });

  it("carries oversized conversation and current checks as excerpt batches", () => {
    const batches = planBatches({
      conversation: [{ role: "user", text: `${"Plan details\n".repeat(40_000)}END_PLAN` }],
      overview: "app.ts",
      changes: "+SMALL_CHANGE",
      items: Array.from({ length: 30 }, (_, index) =>
        compact(index, `NOTE_${index} ${"x".repeat(4_000)}`),
      ),
    });
    expect(batches.length).toBeGreaterThan(1);
    expect(fitsBudget(batches)).toBe(true);
    const all = batches.map(({ prompt }) => prompt).join("\n");
    expect(all).toContain("END_PLAN");
    expect(all).toContain("+SMALL_CHANGE");
    for (let index = 0; index < 30; index++) expect(all).toContain(`NOTE_${index}`);
  });

  it("plans identical inputs identically so a resumed pass can match saved batches", () => {
    const input = {
      conversation: [{ role: "user", text: "Build checkout" }],
      overview: "app.ts",
      changes: `diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n+${"a".repeat(120_000)}\ndiff --git a/b.ts b/b.ts\n@@ -1 +1 @@\n+b\n`,
      items: [compact(1)],
    };
    const first = planBatches(input).map(({ digest }) => digest);
    expect(first.length).toBeGreaterThan(1);
    expect(planBatches(input).map(({ digest }) => digest)).toEqual(first);
    expect(
      planBatches({ ...input, items: [compact(1, "edited")] }).map(({ digest }) => digest),
    ).toEqual(first);
  });
});

describe("mergeUpserts", () => {
  it("updates known ids in place, merges their paths, and never repeats a new check", () => {
    const first = mergeUpserts(
      null,
      upsert([check("Pay by card", "chk-1", "Checkout", ["a.ts"]), check("Refund an order")]),
    );
    const merged = mergeUpserts(
      first,
      upsert(
        [
          check("Pay by card again", "chk-1", "Checkout", ["b.ts"]),
          check("refund an order "),
          check("Refund an order", null, "Support"),
        ],
        "Other title",
      ),
    );
    expect(merged).toEqual(
      upsert([
        check("Pay by card again", "chk-1", "Checkout", ["a.ts", "b.ts"]),
        check("refund an order ", null, "Checkout", []),
        check("Refund an order", null, "Support"),
      ]),
    );
  });
});

describe("combining", () => {
  const merged = upsert(
    Array.from({ length: 60 }, (_, index) =>
      check(`Check ${index} ${"detail ".repeat(200)}`, `chk-${index}`, `Area ${index % 3}`),
    ),
  );

  it("keeps each area in bounded groups covering every check once", () => {
    const groups = combineGroups(merged);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.every((group) => Buffer.byteLength(JSON.stringify(group)) <= 60_000)).toBe(true);
    expect(groups.flatMap((group) => group.items.map((item) => item.id)).toSorted()).toEqual(
      merged.items.map((item) => item.id).toSorted(),
    );
    expect(combineGroups(merged)).toEqual(groups);
  });

  it("lets the combining model merge and rename but never rewrite or invent checks", () => {
    const groups = combineGroups(merged);
    const results = groups.map((group, index) =>
      index === 0
        ? upsert([
            { ...group.items[1]!, check: "Rewritten", area: "Renamed" },
            group.items[0]!,
            check("Invented", "chk-made-up"),
            check("Also invented"),
          ])
        : upsert([]),
    );
    const combined = applyCombined(merged, groups, results);
    expect(combined.items.slice(0, 2)).toEqual([
      { ...groups[0]!.items[1]!, area: "Renamed" },
      groups[0]!.items[0]!,
    ]);
    expect(combined.items.slice(2)).toEqual(groups.slice(1).flatMap((group) => group.items));
    expect(combined.summary).toBe(
      `Review changes across ${new Set(combined.items.map((item) => item.area)).size} areas.`,
    );
  });
});
