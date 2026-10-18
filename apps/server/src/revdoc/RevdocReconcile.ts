import { REVDOC_LIMITS, type RevdocOutcome, type RevdocResult } from "@t3tools/contracts";

import { checkFingerprint, codeFingerprint, type FingerprintBasis } from "./RevdocFingerprint.ts";

/** The latest AI result, with the fingerprints it was recorded against. */
export interface StoredResult extends RevdocResult {
  readonly basis: FingerprintBasis;
}

export interface ItemState {
  readonly id: string;
  readonly revision: number;
  readonly position: number;
  readonly area: string;
  readonly check: string;
  readonly expected: string;
  readonly coveredPaths: ReadonlyArray<string>;
  readonly checkFingerprint: string;
  readonly codeFingerprint: string;
  readonly outcome: RevdocOutcome;
  readonly outcomeBasis: FingerprintBasis | null;
  readonly note: string;
  readonly stalePassId: string | null;
  readonly dismissed: boolean;
  readonly result: StoredResult | null;
}

export interface ProposedItem {
  /** An existing item id to update, or empty for a new check. */
  readonly id: string | null;
  readonly area: string;
  readonly check: string;
  readonly expected: string;
  readonly coveredPaths: ReadonlyArray<string>;
}

export interface ReconcileReport {
  readonly added: number;
  readonly updated: number;
  readonly staled: number;
  readonly unstaled: number;
  readonly unknownIds: number;
  readonly dropped: number;
}

export interface ReconcileInput {
  readonly current: ReadonlyArray<ItemState>;
  readonly proposal: ReadonlyArray<ProposedItem>;
  /** A partial upsert (a finished batch of a running pass) adds and updates but never stales. */
  readonly mode: "full" | "partial";
  readonly passId: string;
  /** Current content hash per worktree-relative path, for every path the proposal names. */
  readonly contentHashes: ReadonlyMap<string, string>;
  readonly newId: () => string;
}

export interface ReconcileOutput {
  /** Every item of the Review in display order, dismissed ones last. */
  readonly items: ReadonlyArray<ItemState>;
  /** Items whose revision moved, new ones included. */
  readonly changed: ReadonlyArray<ItemState>;
  /** The id each proposed item ended up with, or null when it was dropped by the cap. */
  readonly assignedIds: ReadonlyArray<string | null>;
  readonly report: ReconcileReport;
}

/**
 * Repo-relative and inside the worktree. Deleted files are allowed and fingerprint as missing.
 * `.revdoc` is Revdoc's own export and never counts as covered code.
 */
export const normaliseCoveredPaths = (paths: ReadonlyArray<string>) => {
  const kept = new Set<string>();
  for (const raw of paths) {
    const path = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    const segments = path.split("/");
    if (
      path === "" ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      segments.includes("..") ||
      segments[0] === ".revdoc" ||
      segments[0] === ".git"
    ) {
      continue;
    }
    kept.add(segments.filter((segment) => segment !== "" && segment !== ".").join("/"));
    if (kept.size === REVDOC_LIMITS.coveredPaths) break;
  }
  return [...kept];
};

const clamp = (text: string, max: number) => text.trim().slice(0, max);

const sameContent = (a: ItemState, b: Omit<ItemState, "revision">) =>
  a.position === b.position &&
  a.area === b.area &&
  a.check === b.check &&
  a.expected === b.expected &&
  a.coveredPaths.join("\n") === b.coveredPaths.join("\n") &&
  a.checkFingerprint === b.checkFingerprint &&
  a.codeFingerprint === b.codeFingerprint &&
  a.stalePassId === b.stalePassId;

/**
 * Applies a generation pass's upsert. Id matches keep outcome, note and result; unknown or
 * dismissed ids become new; in full mode unmatched items go stale. Outcomes are never touched, so
 * needs retest falls out of `deriveRetest`.
 */
export const reconcile = (input: ReconcileInput): ReconcileOutput => {
  const live = new Map(
    input.current.filter((item) => !item.dismissed).map((item) => [item.id, item]),
  );
  const matched = new Set<string>();
  let capacity = REVDOC_LIMITS.items - input.current.length;
  let added = 0;
  let unknownIds = 0;
  let unstaled = 0;
  let dropped = 0;
  let updated = 0;
  const proposed: Array<Omit<ItemState, "revision" | "position">> = [];
  const previous = new Map<string, ItemState>();
  const assignedIds: Array<string | null> = [];

  for (const candidate of input.proposal) {
    const area = clamp(candidate.area, 200) || "General";
    const check = clamp(candidate.check, REVDOC_LIMITS.check);
    const expected = clamp(candidate.expected, REVDOC_LIMITS.expected);
    const coveredPaths = normaliseCoveredPaths(candidate.coveredPaths);
    const fingerprints = {
      checkFingerprint: checkFingerprint(check, expected),
      codeFingerprint: codeFingerprint(coveredPaths, input.contentHashes),
    };
    // A proposal without check text is not a check, even when it names an existing id.
    if (check === "") {
      assignedIds.push(null);
      continue;
    }
    const existing = candidate.id ? live.get(candidate.id) : undefined;
    if (existing && !matched.has(existing.id)) {
      matched.add(existing.id);
      if (existing.stalePassId !== null) unstaled++;
      if (
        existing.area !== area ||
        existing.check !== check ||
        existing.expected !== expected ||
        existing.coveredPaths.join("\n") !== coveredPaths.join("\n")
      ) {
        updated++;
      }
      previous.set(existing.id, existing);
      proposed.push({
        ...existing,
        area,
        check,
        expected,
        coveredPaths,
        ...fingerprints,
        stalePassId: null,
      });
      assignedIds.push(existing.id);
      continue;
    }
    if (capacity <= 0) {
      dropped++;
      assignedIds.push(null);
      continue;
    }
    capacity--;
    if (candidate.id) unknownIds++;
    added++;
    const id = input.newId();
    proposed.push({
      id,
      area,
      check,
      expected,
      coveredPaths,
      ...fingerprints,
      outcome: "not_checked",
      outcomeBasis: null,
      note: "",
      stalePassId: null,
      dismissed: false,
      result: null,
    });
    assignedIds.push(id);
  }

  let staled = 0;
  const unmatched = input.current
    .filter((item) => !item.dismissed && !matched.has(item.id))
    .toSorted((a, b) => a.position - b.position)
    .map((item) => {
      previous.set(item.id, item);
      if (input.mode === "partial" || item.stalePassId !== null) return item;
      staled++;
      return { ...item, stalePassId: input.passId };
    });
  const dismissed = input.current
    .filter((item) => item.dismissed)
    .toSorted((a, b) => a.position - b.position);
  for (const item of dismissed) previous.set(item.id, item);

  const items: ItemState[] = [];
  const changed: ItemState[] = [];
  for (const [position, next] of [...proposed, ...unmatched, ...dismissed].entries()) {
    const before = previous.get(next.id);
    const content = { ...next, position };
    if (before && sameContent(before, content)) {
      items.push(before);
      continue;
    }
    const item = { ...content, revision: (before?.revision ?? 0) + 1 };
    items.push(item);
    changed.push(item);
  }

  return {
    items,
    changed,
    assignedIds,
    report: { added, updated, staled, unstaled, unknownIds, dropped },
  };
};
