import { describe, expect, test } from "vite-plus/test";

import { reconcile } from "./RevdocReconcile.ts";
import { largeReview, sequentialIds } from "./testing/revdocFixtures.test.helpers.ts";

// Budgets in milliseconds. p99 stands in for the p95 budget because it is stricter.
const budgets = [
  { size: 200, p50: 10, p99: 25 },
  { size: 2_000, p50: 150, p99: 150 },
];

describe("reconcile performance", () => {
  for (const budget of budgets) {
    test(`${budget.size} items against a ${budget.size}-item proposal`, async ({ bench }) => {
      const { current, proposal, contentHashes } = largeReview(budget.size);
      const { latency } = await bench(`reconcile ${budget.size}`, () => {
        reconcile({
          current,
          proposal,
          mode: "full",
          passId: "pass-bench",
          contentHashes,
          newId: sequentialIds(),
        });
      }).run();
      expect(latency.p50).toBeLessThan(budget.p50);
      expect(latency.p99).toBeLessThan(budget.p99);
    });
  }
});
