import { describe, expect, it } from "vite-plus/test";

import type { ItemState, StoredResult } from "./RevdocReconcile.ts";
import { selectItems } from "./RevdocTesting.ts";
import { itemFromFixture } from "./testing/revdocFixtures.test.helpers.ts";

const hashes = new Map([["src/a.ts", "h1"]]);
const resultFor = (
  item: ItemState,
  state: StoredResult["state"],
  code = item.codeFingerprint,
): ItemState => ({
  ...item,
  result: {
    passId: "pass-1",
    state,
    method: "command",
    steps: "",
    observed: "",
    model: "",
    recordedAt: "2026-10-17T00:00:00.000Z",
    evidence: [],
    basis: { check: item.checkFingerprint, code },
  },
});

describe("selectItems", () => {
  const base = (id: string, outcome: ItemState["outcome"] = "not_checked") =>
    itemFromFixture({ id, check: `Check ${id}`, coveredPaths: ["src/a.ts"], outcome }, 0, hashes);
  // The person rated these against older code, so their outcome needs retest.
  const ratedEarlier = (item: ItemState) => ({
    ...item,
    outcomeBasis: { check: item.checkFingerprint, code: "old" },
  });
  const items: ReadonlyArray<ItemState> = [
    base("untested"),
    ratedEarlier(resultFor(base("passed-now", "complete"), "passed")),
    resultFor(base("passed-earlier"), "passed", "old"),
    resultFor(base("failed"), "failed"),
    resultFor(base("blocked"), "blocked"),
    { ...base("stale"), stalePassId: "pass-0" },
    { ...base("dismissed"), stalePassId: "pass-0", dismissed: true },
  ];
  const ids = (selected: ReadonlyArray<ItemState>) => selected.map((item) => item.id);

  it("skips a check the AI passed at the current code, even when the person's outcome needs retest", () => {
    expect(ids(selectItems(items, "remaining"))).toEqual([
      "untested",
      "passed-earlier",
      "failed",
      "blocked",
    ]);
  });

  it("retries failed and blocked checks, or exactly the requested ones", () => {
    expect(ids(selectItems(items, "failed"))).toEqual(["failed", "blocked"]);
    expect(ids(selectItems(items, "items", ["passed-now", "stale"]))).toEqual(["passed-now"]);
  });
});
