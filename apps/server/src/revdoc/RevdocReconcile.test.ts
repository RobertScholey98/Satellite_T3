// @effect-diagnostics nodeBuiltinImport:off - Loads the literal JSON fixtures beside this test.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { REVDOC_LIMITS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reconcile, type ProposedItem } from "./RevdocReconcile.ts";
import {
  type FixtureItem,
  itemFromFixture,
  largeReview,
  type ReconcileView,
  sequentialIds,
  viewOutput,
} from "./testing/revdocFixtures.test.helpers.ts";

interface ReconcileFixture {
  readonly name: string;
  readonly description: string;
  readonly mode: "full" | "partial";
  readonly hashesBefore: Record<string, string>;
  readonly hashesNow: Record<string, string>;
  readonly current: ReadonlyArray<FixtureItem>;
  readonly proposal: ReadonlyArray<ProposedItem>;
  readonly expected: {
    readonly items: ReadonlyArray<ReconcileView>;
    readonly report: Record<string, number>;
  };
}

const fixtureDirectory = NodePath.join(import.meta.dirname, "fixtures/reconcile");
const fixtures: ReadonlyArray<ReconcileFixture> = NodeFS.readdirSync(fixtureDirectory)
  .filter((file) => file.endsWith(".json"))
  .toSorted()
  .map((file) => JSON.parse(NodeFS.readFileSync(NodePath.join(fixtureDirectory, file), "utf8")));

describe("reconcile", () => {
  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
    const before = new Map(Object.entries(fixture.hashesBefore));
    const output = reconcile({
      current: fixture.current.map((item, position) => itemFromFixture(item, position, before)),
      proposal: fixture.proposal,
      mode: fixture.mode,
      passId: "pass-now",
      contentHashes: new Map(Object.entries(fixture.hashesNow)),
      newId: sequentialIds(),
    });
    expect(viewOutput(output)).toEqual(fixture.expected);
  });

  it("bumps the revision of changed items only", () => {
    const hashes = new Map([["src/a.ts", "h1"]]);
    const current = [
      itemFromFixture({ id: "a", check: "A", coveredPaths: ["src/a.ts"] }, 0, hashes),
      itemFromFixture({ id: "b", check: "B" }, 1, hashes),
    ];
    const output = reconcile({
      current,
      proposal: [
        { id: "a", area: "General", check: "A", expected: "", coveredPaths: ["src/a.ts"] },
        { id: "b", area: "General", check: "B, reworded", expected: "", coveredPaths: [] },
      ],
      mode: "full",
      passId: "pass-now",
      contentHashes: hashes,
      newId: sequentialIds(),
    });
    expect(output.items.map((item) => [item.id, item.revision])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(output.changed.map((item) => item.id)).toEqual(["b"]);
    expect(output.assignedIds).toEqual(["a", "b"]);
  });

  it("drops new checks past the item cap and counts them", () => {
    const hashes = new Map<string, string>();
    const current = Array.from({ length: REVDOC_LIMITS.items - 1 }, (_, index) =>
      itemFromFixture({ id: `item-${index}`, check: `Check ${index}` }, index, hashes),
    );
    const output = reconcile({
      current,
      proposal: [
        ...current.map((item) => ({ ...item, id: item.id })),
        { id: null, area: "General", check: "Fits", expected: "", coveredPaths: [] },
        { id: null, area: "General", check: "Over one", expected: "", coveredPaths: [] },
        { id: null, area: "General", check: "Over two", expected: "", coveredPaths: [] },
      ],
      mode: "full",
      passId: "pass-now",
      contentHashes: hashes,
      newId: sequentialIds(),
    });
    expect(output.items).toHaveLength(REVDOC_LIMITS.items);
    expect(output.report).toEqual({
      added: 1,
      updated: 0,
      staled: 0,
      unstaled: 0,
      unknownIds: 0,
      dropped: 2,
    });
    expect(output.assignedIds.slice(-3)).toEqual(["new-1", null, null]);
  });

  it.each([200, 2_000])("reconciles a %i-item Review against a mixed proposal", (size) => {
    const { current, proposal, contentHashes } = largeReview(size);
    const output = reconcile({
      current,
      proposal,
      mode: "full",
      passId: "pass-now",
      contentHashes,
      newId: sequentialIds(),
    });
    const quarter = size / 4;
    expect(output.report).toEqual({
      added: quarter,
      updated: quarter,
      staled: quarter,
      unstaled: 0,
      unknownIds: 0,
      dropped: 0,
    });
    const view = viewOutput(output).items;
    expect(view.filter((item) => item.retest === "check")).toHaveLength(quarter / 2);
    expect(view.filter((item) => item.retest === "code")).toHaveLength(quarter / 2);
    expect(view.slice(-quarter).every((item) => item.stale)).toBe(true);
    expect(view.filter((item) => item.note !== "")).toHaveLength(
      current.filter((item) => item.note !== "").length,
    );
  });
});
