import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type RevdocReview, type RevdocTest } from "@t3tools/contracts";
import {
  selectTests,
  staleTestIds,
  testDefinitionRevision,
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

it("retains every result and capture through repeated runs and same-run progress updates", () => {
  let test: RevdocTest = {
    id: "test",
    title: "Check",
    outcome: "change",
    feedback: "Keep this",
    verification: { result: "passed", sourceRevision: "previous" },
    evidence: [{ id: "original", path: "evidence/original.png" }],
  };
  const completed = checked("test", "passed").attempts![0]!;
  for (let index = 0; index < 12; index++) {
    const attempt = { ...completed, runId: `run-${index}` };
    test = withTestAttempt(test, { ...attempt, state: "queued", evidence: [] });
    const evidence = [{ id: `capture-${index}`, path: `evidence/${index}.png` }];
    test = withTestAttempt(test, { ...attempt, state: "running", evidence });
    test = withTestAttempt(test, {
      ...attempt,
      finishedAt: "2026-10-04T12:01:00Z",
      observed: `Observation ${index}`,
      evidence,
    });
  }

  expect(test.attempts).toHaveLength(13);
  expect(test.attempts?.[0]).toMatchObject({
    runId: "imported-test",
    evidence: [{ id: "original", path: "evidence/original.png" }],
  });
  expect(
    test.attempts?.slice(1).map(({ runId, state, observed, evidence }) => ({
      runId,
      state,
      observed,
      evidence,
    })),
  ).toEqual(
    Array.from({ length: 12 }, (_, index) => ({
      runId: `run-${index}`,
      state: "passed",
      observed: `Observation ${index}`,
      evidence: [{ id: `capture-${index}`, path: `evidence/${index}.png` }],
    })),
  );
  expect(test).toMatchObject({
    outcome: "change",
    feedback: "Keep this",
    verification: { result: "passed", sourceRevision: "current" },
    evidence: [{ id: "capture-11" }],
  });
});
