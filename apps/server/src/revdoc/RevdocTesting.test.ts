import { describe, expect, it } from "vite-plus/test";
import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
  type RevdocReview,
  type RevdocTest,
} from "@t3tools/contracts";
import {
  selectTests,
  staleTestIds,
  testDefinitionRevision,
  testingBatches,
  withTestAttempt,
} from "./RevdocTesting.ts";

const checked = (id: string, state: "passed" | "failed" | "blocked"): RevdocTest => {
  const definition = { id, title: `Check ${id}`, expected: "Expected behavior" };
  return {
    ...definition,
    attempts: [
      {
        runId: "run",
        state,
        by: "tester",
        sourceRevision: "current",
        definitionRevision: testDefinitionRevision(definition),
        startedAt: "2026-10-04T12:00:00Z",
        evidence: [],
      },
    ],
  };
};
const passed = checked("passed", "passed");
const changed = { ...checked("changed", "passed"), expected: "New requirement" };
const review: RevdocReview = {
  title: "Review",
  sections: [
    {
      id: "area",
      area: "Area",
      items: [
        {
          id: "feature",
          name: "Feature",
          tests: [
            passed,
            checked("failed", "failed"),
            checked("blocked", "blocked"),
            { id: "new", title: "New check" },
            changed,
          ],
        },
      ],
    },
  ],
};
const target = { threadId: ThreadId.make("original") };

describe("Revdoc retest selection", () => {
  it("reuses current passes while retrying blocked, failed, new, and changed checks", () => {
    expect(
      selectTests(review, { ...target, selection: "remaining" }, "current").map((test) => test.id),
    ).toEqual(["failed", "blocked", "new", "changed"]);
    expect(
      selectTests(review, { ...target, selection: "failed" }, "current").map((test) => test.id),
    ).toEqual(["failed"]);
    expect(selectTests(review, { ...target, selection: "remaining" }, "new-code")).toHaveLength(5);
  });

  it("can retest an individual passing check without including other failures", () => {
    expect(
      selectTests(review, { ...target, selection: "all", testIds: ["passed"] }, "current"),
    ).toEqual([passed]);
  });

  it("invalidates changed definitions or unknown code state while preserving human feedback", () => {
    expect(staleTestIds(review, "current")).toEqual(["changed"]);
    expect(staleTestIds(review, null)).toEqual(["passed", "failed", "blocked", "changed"]);
    expect(testDefinitionRevision({ ...passed, outcome: "change", feedback: "My decision" })).toBe(
      testDefinitionRevision(passed),
    );
  });
});

it("keeps standalone verification current while retaining previous evidence and human feedback", () => {
  const original: RevdocTest = {
    id: "test",
    title: "Check",
    outcome: "change",
    feedback: "Keep this",
    verification: {
      result: "passed",
      sourceRevision: "previous",
      testedAt: "2026-10-01T12:00:00Z",
    },
    evidence: [{ id: "old", path: "evidence/old.png" }],
  };
  const attempt = checked("test", "failed").attempts![0]!;
  const updated = withTestAttempt(original, {
    ...attempt,
    evidence: [{ id: "new", path: "evidence/new.png" }],
  });
  expect(updated).toMatchObject({
    outcome: "change",
    feedback: "Keep this",
    verification: { result: "failed", sourceRevision: "current" },
    evidence: [{ id: "new" }],
  });
  expect(updated.attempts).toHaveLength(2);
  expect(updated.attempts?.[0]).toMatchObject({
    state: "passed",
    sourceRevision: "previous",
    evidence: [{ id: "old" }],
  });
});

it("gives each review section its own testing batch, splitting only sections too large for one turn", () => {
  const check = (id: string): RevdocTest => ({
    id,
    title: `Check ${id}`,
    expected: "x".repeat(15_000),
  });
  const large = Array.from({ length: 12 }, (_, index) => check(`large-${index}`));
  const sections: RevdocReview = {
    title: "Review",
    sections: [
      {
        id: "small",
        area: "Small",
        items: [{ id: "one", name: "One", tests: [check("a"), check("b")] }],
      },
      { id: "large", area: "Large", items: [{ id: "two", name: "Two", tests: large }] },
    ],
  };
  const batches = testingBatches(sections, [check("a"), ...large], {
    runId: "run",
    cwd: "/worktree",
    title: "Review",
  });
  expect(batches.map((batch) => batch.section)).toEqual(["Small", "Large", "Large"]);
  expect(batches[0]!.tests.map((test) => test.id)).toEqual(["a"]);
  expect(batches.slice(1).flatMap((batch) => batch.tests)).toEqual(large);
  for (const batch of batches) {
    expect(batch.prompt.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(batch.prompt).toContain(batch.tests.at(-1)!.id);
  }
});
