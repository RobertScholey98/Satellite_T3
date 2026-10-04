import { describe, expect, it } from "vite-plus/test";
import type { RevdocReview } from "@t3tools/contracts";
import { reconcileRevdoc, type RevdocGenerationResult } from "./RevdocGeneration.ts";

const generated: RevdocGenerationResult = {
  title: "Checkout review",
  summary: "Payment flow",
  context: "Review the checkout",
  sections: [
    {
      id: "checkout",
      area: "Checkout",
      items: [
        {
          id: "payment",
          name: "Payment",
          status: "done",
          summary: "Card flow",
          prd: [],
          quirks: [],
          flags: [],
          endpoints: [],
          tests: [{ id: "pay", title: "Pay once", expected: "One charge" }],
        },
      ],
    },
  ],
};
const previous: RevdocReview = {
  ...generated,
  notes: "Keep this feedback",
  sections: [
    {
      ...generated.sections[0]!,
      note: "Section note",
      items: [
        {
          ...generated.sections[0]!.items[0]!,
          note: "Item note",
          tests: [
            {
              ...generated.sections[0]!.items[0]!.tests[0]!,
              outcome: "broken",
              feedback: "Double charge",
              evidence: [{ id: "capture", path: "evidence/card.png", sourceRevision: "old" }],
              verification: { result: "failed", by: "QA" },
            },
            { id: "retry", title: "Retry payment", outcome: "change", feedback: "Offer retry" },
          ],
        },
      ],
    },
  ],
};
describe("Revdoc reruns", () => {
  it("preserves human outcomes, notes, recorded checks, evidence and omitted tests", () => {
    const result = reconcileRevdoc(previous, generated);
    expect(result.notes).toBe("Keep this feedback");
    expect(result.sections[0]!.note).toBe("Section note");
    const item = result.sections[0]!.items[0]!;
    expect(item.note).toBe("Item note");
    expect(item.tests).toEqual(previous.sections[0]!.items[0]!.tests);
  });
  it("requires another review after expected behavior changes without erasing findings", () => {
    const next = {
      ...generated,
      sections: generated.sections.map((s) => ({
        ...s,
        items: s.items.map((i) => ({
          ...i,
          tests: i.tests.map((t) => ({ ...t, expected: "One charge and one receipt" })),
        })),
      })),
    };
    const test = reconcileRevdoc(previous, next).sections[0]!.items[0]!.tests[0]!;
    expect(test.outcome).toBe("untested");
    expect(test.feedback).toBe("Double charge");
    expect(test.evidence).toHaveLength(1);
    expect(test.verification?.result).toBe("failed");
  });
  it("does not duplicate test IDs when the model moves a test to another item", () => {
    const next = {
      ...generated,
      sections: generated.sections.map((s) => ({
        ...s,
        items: s.items.map((i) => ({ ...i, id: "new-item" })),
      })),
    };
    const result = reconcileRevdoc(previous, next);
    const ids = result.sections.flatMap((s) => s.items.flatMap((i) => i.tests.map((t) => t.id)));
    expect(ids).toEqual(["pay", "retry"]);
    expect(result.sections[0]!.items[0]!.tests[0]!.feedback).toBe("Double charge");
  });
  it("keeps section notes when an item moves to a new section", () => {
    const next = {
      ...generated,
      sections: generated.sections.map((s) => ({ ...s, id: "new-section" })),
    };
    const result = reconcileRevdoc(previous, next);
    const ids = result.sections.flatMap((s) => s.items.flatMap((i) => i.tests.map((t) => t.id)));
    expect(ids).toEqual(["pay", "retry"]);
    expect(result.sections.find((s) => s.id === "checkout")?.note).toBe("Section note");
  });
  it("never creates human approvals from an implementation claim", () => {
    const result = reconcileRevdoc(null, generated);
    expect(result.sections[0]!.items[0]!.tests[0]!.outcome).toBe("untested");
  });
});
