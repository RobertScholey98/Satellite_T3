import { checkFingerprint, codeFingerprint, deriveRetest } from "../RevdocFingerprint.ts";
import type { ItemState, ProposedItem, ReconcileOutput } from "../RevdocReconcile.ts";

export interface FixtureItem {
  readonly id: string;
  readonly check: string;
  readonly area?: string;
  readonly expected?: string;
  readonly coveredPaths?: ReadonlyArray<string>;
  readonly outcome?: ItemState["outcome"];
  readonly note?: string;
  readonly stale?: boolean;
  readonly dismissed?: boolean;
}

/** A stored item whose outcome was set against `hashes`, as a person would have left it. */
export const itemFromFixture = (
  fixture: FixtureItem,
  position: number,
  hashes: ReadonlyMap<string, string>,
): ItemState => {
  const expected = fixture.expected ?? "";
  const coveredPaths = fixture.coveredPaths ?? [];
  const fingerprints = {
    check: checkFingerprint(fixture.check, expected),
    code: codeFingerprint(coveredPaths, hashes),
  };
  const outcome = fixture.outcome ?? "not_checked";
  return {
    id: fixture.id,
    revision: 1,
    position,
    area: fixture.area ?? "General",
    check: fixture.check,
    expected,
    coveredPaths,
    checkFingerprint: fingerprints.check,
    codeFingerprint: fingerprints.code,
    outcome,
    outcomeBasis: outcome === "not_checked" ? null : fingerprints,
    note: fixture.note ?? "",
    stalePassId: fixture.stale ? "pass-earlier" : null,
    dismissed: fixture.dismissed ?? false,
    result: null,
  };
};

/** What a person sees of an item after a pass. */
const viewItem = (item: ItemState) => ({
  id: item.id,
  position: item.position,
  area: item.area,
  check: item.check,
  coveredPaths: item.coveredPaths,
  outcome: item.outcome,
  note: item.note,
  stale: item.stalePassId !== null,
  dismissed: item.dismissed,
  retest: deriveRetest(item),
});

export const sequentialIds = () => {
  let next = 0;
  return () => `new-${++next}`;
};

/**
 * A Review of `size` items and a proposal against it: the first quarter unchanged, the second
 * reworded, the third left out (goes stale), the fourth with changed code, plus a quarter new.
 */
export const largeReview = (size: number) => {
  const quarter = size / 4;
  const before = new Map<string, string>();
  const now = new Map<string, string>();
  const current: ItemState[] = [];
  const proposal: ProposedItem[] = [];
  for (let index = 0; index < size; index++) {
    const path = `src/feature-${index}.ts`;
    before.set(path, "before");
    now.set(path, index >= 3 * quarter ? "after" : "before");
    const fixture: FixtureItem = {
      id: `item-${index}`,
      area: `Area ${index % 12}`,
      check: `Check behaviour ${index}`,
      expected: `Behaviour ${index} works`,
      coveredPaths: [path],
      outcome: index % 2 === 0 ? "complete" : "not_checked",
      note: index % 3 === 0 ? `Note ${index}` : "",
    };
    current.push(itemFromFixture(fixture, index, before));
    if (index >= 2 * quarter && index < 3 * quarter) continue;
    proposal.push({
      id: fixture.id,
      area: fixture.area!,
      check: index >= quarter && index < 2 * quarter ? `${fixture.check}, reworded` : fixture.check,
      expected: fixture.expected!,
      coveredPaths: [path],
    });
  }
  for (let index = 0; index < quarter; index++) {
    proposal.push({
      id: null,
      area: `Area ${index % 12}`,
      check: `New check ${index}`,
      expected: "Works",
      coveredPaths: [`src/new-${index}.ts`],
    });
  }
  return { current, proposal, contentHashes: now };
};

export type ReconcileView = ReturnType<typeof viewItem>;
export const viewOutput = (output: ReconcileOutput) => ({
  items: output.items.map(viewItem),
  report: output.report,
});
