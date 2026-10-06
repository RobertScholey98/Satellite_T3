import { describe, expect, it } from "vite-plus/test";
import type { RevdocReview } from "@t3tools/contracts";
import { reconcileRevdoc, type RevdocGenerationResult } from "./RevdocGeneration.ts";
import {
  MAX_REVDOC_PROMPT_BYTES,
  mergeRevdocBatch,
  planRevdocBatches,
  revdocConsolidationGroups,
  revdocConsolidationPrompt,
  splitRevdocText,
} from "./RevdocBatching.ts";

const fragment = (title: string, expected = "One charge"): RevdocGenerationResult => ({
  title: "Checkout",
  summary: "Payment flow",
  context: "Review manually",
  sections: [
    {
      id: "area",
      area: "Checkout",
      items: [
        {
          id: "feature",
          name: "Payments",
          summary: "Cards",
          status: "done",
          prd: [],
          quirks: [],
          flags: [],
          endpoints: [],
          tests: [{ id: "check", title, expected }],
        },
      ],
    },
  ],
});

describe("Revdoc batching", () => {
  it("keeps small changes in one pass", () => {
    const prompts = planRevdocBatches({
      thread: { title: "Checkout" },
      changes: "+Payment",
      existing: null,
      overview: "app.ts",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("+Payment");
    expect(prompts[0]).not.toContain('"batch":');
  });

  it("splits large patches without losing files, hunks, Unicode, or long lines", () => {
    const longLine = '😀\\"'.repeat(30_000);
    const parts = splitRevdocText(longLine, 80_000);
    expect(parts.join("")).toBe(longLine);
    expect(parts.every((part) => Buffer.byteLength(JSON.stringify(part)) <= 80_000)).toBe(true);
    expect(parts.every((part) => !part.includes("�"))).toBe(true);
    const patch = [
      "diff --git a/one.ts b/one.ts\n--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-Old\n+" +
        longLine +
        "END_ONE\n",
      "diff --git a/two.ts b/two.ts\n--- a/two.ts\n+++ b/two.ts\n@@ -1 +1 @@\n+END_TWO\n",
    ].join("");
    const prompts = planRevdocBatches({
      thread: {},
      changes: patch,
      existing: null,
      overview: "one.ts, two.ts",
    });
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.every((prompt) => Buffer.byteLength(prompt) <= MAX_REVDOC_PROMPT_BYTES)).toBe(
      true,
    );
    expect(prompts.join("\n")).toContain("END_ONE");
    expect(prompts.join("\n")).toContain("END_TWO");
    expect(
      prompts
        .filter((prompt) => prompt.includes("😀"))
        .every((prompt) => prompt.includes("b/one.ts")),
    ).toBe(true);
  });

  it("budgets conversation and existing review as well as patches", () => {
    const previous = fragment("Pay");
    const existing: RevdocReview = {
      ...previous,
      sections: Array.from({ length: 30 }, (_, index) => ({
        id: `section-${index}`,
        area: `Area ${index}`,
        items: [
          {
            ...previous.sections[0]!.items[0]!,
            id: `item-${index}`,
            summary: "Details ".repeat(2_000),
            tests: [{ id: `test-${index}`, title: `Test ${index}`, feedback: `FEEDBACK_${index}` }],
          },
        ],
      })),
    };
    const prompts = planRevdocBatches({
      thread: { text: "Plan details\n".repeat(60_000) + "END_PLAN" },
      changes: "+SMALL_CHANGE",
      existing,
      overview: "app.ts",
    });
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.every((prompt) => Buffer.byteLength(prompt) <= MAX_REVDOC_PROMPT_BYTES)).toBe(
      true,
    );
    const all = prompts.join("\n");
    expect(all).toContain("END_PLAN");
    expect(all).toContain("+SMALL_CHANGE");
    for (let index = 0; index < 30; index++) expect(all).toContain(`FEEDBACK_${index}`);
  });

  it("identifies every fragment of a large untracked file", () => {
    const prompts = planRevdocBatches({
      thread: {},
      existing: null,
      overview: "new.ts",
      changes: "Untracked file: new.ts\n" + "Untracked content\n".repeat(30_000),
    });
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.every((prompt) => prompt.includes("Untracked file: new.ts"))).toBe(true);
    expect(prompts.join("\n").match(/Untracked content/g)).toHaveLength(30_000);
  });

  it("combines matching areas and exact duplicate checks while preserving different checks with colliding IDs", () => {
    let review = mergeRevdocBatch(null, fragment("Pay"), null);
    review = mergeRevdocBatch(review, fragment("Retry"), null);
    review = mergeRevdocBatch(review, fragment("Pay"), null);
    expect(review.sections).toHaveLength(1);
    expect(review.sections[0]!.items).toHaveLength(1);
    const tests = review.sections[0]!.items[0]!.tests;
    expect(tests.map((test) => test.title)).toEqual(["Pay", "Retry"]);
    expect(new Set(tests.map((test) => test.id)).size).toBe(2);
  });

  it("retains human feedback and evidence when batches disagree about an existing check", () => {
    const previous: RevdocReview = {
      ...fragment("Pay"),
      notes: "Human note",
      sections: [
        {
          ...fragment("Pay").sections[0]!,
          items: [
            {
              ...fragment("Pay").sections[0]!.items[0]!,
              tests: [
                {
                  id: "check",
                  title: "Pay",
                  expected: "One charge",
                  outcome: "broken",
                  feedback: "Double charge",
                  evidence: [{ id: "screenshot", path: "evidence/pay.png" }],
                },
              ],
            },
          ],
        },
      ],
    };
    let combined = mergeRevdocBatch(null, fragment("Pay"), previous);
    combined = mergeRevdocBatch(combined, fragment("Retry", "One receipt"), previous);
    const result = reconcileRevdoc(previous, combined);
    expect(result.notes).toBe("Human note");
    expect(result.sections[0]!.items[0]!.tests).toHaveLength(2);
    expect(result.sections[0]!.items[0]!.tests.find((test) => test.id === "check")).toMatchObject({
      outcome: "broken",
      feedback: "Double charge",
      evidence: [{ id: "screenshot" }],
    });
  });

  it("bounds consolidation groups and retains every check omitted by the model", () => {
    const base = fragment("Pay");
    const review = {
      ...base,
      sections: [
        {
          ...base.sections[0]!,
          items: [
            {
              ...base.sections[0]!.items[0]!,
              tests: Array.from({ length: 100 }, (_, index) => ({
                id: `test-${index}`,
                title: `Pay ${index}`,
                expected: "Expected ".repeat(200),
              })),
            },
          ],
        },
      ],
    };
    const groups = revdocConsolidationGroups(review);
    expect(groups.length).toBeGreaterThan(1);
    expect(
      groups
        .flatMap((group) => group.sections.flatMap((s) => s.items.flatMap((i) => i.tests)))
        .map((test) => test.id),
    ).toEqual(review.sections[0]!.items[0]!.tests.map((test) => test.id));
    expect(
      groups.every(
        (group) =>
          Buffer.byteLength(revdocConsolidationPrompt(group, "Overview")) <=
          MAX_REVDOC_PROMPT_BYTES,
      ),
    ).toBe(true);
    expect(reconcileRevdoc(review, { ...base, sections: [] }).sections).toEqual(review.sections);
  });
});
