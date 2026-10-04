import { describe, expect, it } from "vite-plus/test";
import { revdocEvidencePath, revdocSummary } from "./revdoc.ts";

describe("Revdoc review summaries", () => {
  it("reserves green for all complete without notes", () => {
    const complete = { id: "one", title: "Check", outcome: "complete" as const };
    expect(revdocSummary([complete]).good).toBe(true);
    expect(revdocSummary([complete], ["Follow up"]).good).toBe(false);
    expect(revdocSummary([{ ...complete, feedback: "Improve contrast" }]).good).toBe(false);
    expect(revdocSummary([{ ...complete, outcome: "na" }])).toMatchObject({
      reviewed: 1,
      good: false,
      findings: 0,
    });
    expect(revdocSummary([]).good).toBe(false);
  });
  it("does not count an agent verification as a human review", () => {
    expect(
      revdocSummary([{ id: "one", title: "Check", verification: { result: "passed" } }]),
    ).toMatchObject({ reviewed: 0, complete: 0, good: false });
  });
  it("only links image evidence inside the worktree evidence directory", () => {
    expect(revdocEvidencePath("evidence/screen.png")).toBe(".revdoc/evidence/screen.png");
    expect(revdocEvidencePath("evidence\\screen.webp")).toBe(".revdoc/evidence/screen.webp");
    for (const path of [
      "../screen.png",
      "evidence/../../secret.png",
      "C:/screen.png",
      "https://site/image.png",
      "evidence/page.html",
    ]) {
      expect(revdocEvidencePath(path)).toBeNull();
    }
  });
});
