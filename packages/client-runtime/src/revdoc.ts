import {
  type EnvironmentId,
  type RevdocEvent,
  type RevdocItemDetail,
  type RevdocItemSummary,
  type RevdocOutcome,
  type RevdocPass,
  type RevdocReviewHeader,
  SATELLITE_WS_METHODS,
  type ThreadId,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "./connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./state/runtime.ts";
import { vcsRefsCacheStateAtom } from "./state/vcsRefInvalidation.ts";

/** A client's copy of one worktree's Review, built from a snapshot and the deltas after it. */
export interface RevdocState {
  readonly loaded: boolean;
  readonly worktreePath: string | null;
  readonly revision: number;
  readonly review: RevdocReviewHeader | null;
  /** In Review order. */
  readonly items: ReadonlyArray<RevdocItemSummary>;
  readonly activePass: RevdocPass | null;
  readonly latestPasses: ReadonlyArray<RevdocPass>;
  readonly testParentThreadId: ThreadId | null;
  /** A delta skipped a revision; the subscription must restart from a fresh snapshot. */
  readonly gap: boolean;
  /** Another device or a worktree removal deleted the Review this client was showing. */
  readonly deleted: boolean;
}

export const EMPTY_REVDOC_STATE: RevdocState = {
  loaded: false,
  worktreePath: null,
  revision: 0,
  review: null,
  items: [],
  activePass: null,
  latestPasses: [],
  testParentThreadId: null,
  gap: false,
  deleted: false,
};

const mergeItems = (
  current: ReadonlyArray<RevdocItemSummary>,
  changed: ReadonlyArray<RevdocItemSummary> = [],
  removed: ReadonlyArray<string> = [],
) => {
  if (changed.length === 0 && removed.length === 0) return current;
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const id of removed) byId.delete(id);
  for (const item of changed) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.position - b.position);
};

const withLatest = (passes: ReadonlyArray<RevdocPass>, pass: RevdocPass) => [
  pass,
  ...passes.filter((candidate) => candidate.kind !== pass.kind),
];

/**
 * Applies one `revdoc.subscribe` event. A delta at the current revision carries pass progress or a
 * header-only change; one revision ahead is the next commit; further ahead is a gap.
 */
export function applyRevdocEvent(state: RevdocState, event: RevdocEvent): RevdocState {
  switch (event._tag) {
    case "snapshot":
      return {
        loaded: true,
        worktreePath: event.snapshot.worktreePath,
        revision: event.snapshot.review?.revision ?? 0,
        review: event.snapshot.review,
        items: event.snapshot.items,
        activePass: event.snapshot.activePass,
        latestPasses: event.snapshot.latestPasses,
        testParentThreadId: event.snapshot.testParentThreadId,
        gap: false,
        deleted: false,
      };
    case "deleted":
      return {
        ...state,
        revision: 0,
        review: null,
        items: [],
        activePass: null,
        deleted: state.review !== null,
      };
    case "delta": {
      if (event.revision > state.revision + 1) return { ...state, gap: true };
      if (event.revision < state.revision) return state;
      return {
        ...state,
        revision: event.revision,
        review: event.review ?? state.review,
        items: mergeItems(state.items, event.items, event.removed),
        activePass: event.activePass === undefined ? state.activePass : event.activePass,
        latestPasses: event.latestPass
          ? withLatest(state.latestPasses, event.latestPass)
          : state.latestPasses,
        deleted: false,
      };
    }
  }
}

export interface RevdocSummary {
  readonly total: number;
  /** Checks with an outcome that does not need retest. */
  readonly reviewed: number;
  readonly findings: number;
  readonly needsRetest: number;
  readonly stale: number;
  readonly dismissed: number;
}

/** Counts over the visible checklist. A needs-retest check counts as not reviewed. */
export function summarizeRevdoc(items: ReadonlyArray<RevdocItemSummary>): RevdocSummary {
  let total = 0;
  let reviewed = 0;
  let findings = 0;
  let needsRetest = 0;
  let stale = 0;
  let dismissed = 0;
  for (const item of items) {
    if (item.dismissed) {
      dismissed++;
      continue;
    }
    total++;
    if (item.stale) stale++;
    if (item.retest !== null) needsRetest++;
    else if (item.outcome !== "not_checked") reviewed++;
    if (needsFix(item)) findings++;
  }
  return { total, reviewed, findings, needsRetest, stale, dismissed };
}

/** Broken, change requested, or failed by the AI. Stale and dismissed checks are left out. */
export const needsFix = (
  item: Pick<RevdocItemSummary, "stale" | "dismissed" | "outcome"> & {
    readonly result: { readonly state: string } | null;
  },
) =>
  !item.stale &&
  !item.dismissed &&
  (item.outcome === "broken" ||
    item.outcome === "change_requested" ||
    item.result?.state === "failed");

/** Needs a person's attention: a finding, a blocked result, or needs retest. */
export const needsAttention = (item: RevdocItemSummary) =>
  !item.dismissed && (needsFix(item) || item.retest !== null || item.result?.state === "blocked");

export const REVDOC_OUTCOME_LABELS: Record<RevdocOutcome, string> = {
  not_checked: "Not checked",
  complete: "Complete",
  broken: "Broken",
  change_requested: "Change requested",
  skipped: "Skipped",
};

/**
 * The composer text for Draft fix request: each finding with its id, check, expected and observed
 * behaviour, and the person's note, pointing the agent at `revdoc_read`.
 */
export function draftFixRequest(items: ReadonlyArray<RevdocItemDetail>): string {
  const findings = items.filter(needsFix);
  if (findings.length === 0) return "";
  return [
    "Please fix these findings from the Revdoc review of this worktree. Read the full review with the revdoc_read tool (or .revdoc/review.json) before changing code, and keep each fix scoped to its check.",
    ...findings.map((item) =>
      [
        `- [${item.id}] ${item.check}`,
        `  Expected: ${item.expected || "Not stated."}`,
        ...(item.result?.state === "failed" ? [`  Observed: ${item.result.observed}`] : []),
        ...(item.outcome !== "not_checked"
          ? [`  Outcome: ${REVDOC_OUTCOME_LABELS[item.outcome]}`]
          : []),
        ...(item.note.trim() ? [`  Note: ${item.note.trim()}`] : []),
      ].join("\n"),
    ),
  ].join("\n\n");
}

export const appendToDraft = (draft: string, addition: string) =>
  draft.trim() === "" ? addition : `${draft.replace(/\s+$/, "")}\n\n${addition}`;

/**
 * A note being edited on one device. The save is based on the item revision the edit began at,
 * not the live one, so another device's save in between is refused rather than overwritten.
 */
export interface RevdocNoteDraft {
  readonly text: string;
  /** The note when the edit began. */
  readonly original: string;
  readonly baseRevision: number;
  /** The other device's note after a refused save; saving again replaces that version. */
  readonly conflict: { readonly note: string; readonly revision: number } | null;
}

export const startNoteDraft = (note: string, revision: number): RevdocNoteDraft => ({
  text: note,
  original: note,
  baseRevision: revision,
  conflict: null,
});

export const noteDraftSaveRevision = (draft: RevdocNoteDraft) =>
  draft.conflict?.revision ?? draft.baseRevision;

/**
 * After a refused save: when only something other than the note moved the item on (an outcome,
 * an AI result), save again at the current revision; when the note itself changed, show it.
 */
export const resolveNoteConflict = (
  draft: RevdocNoteDraft,
  current: { readonly note: string; readonly revision: number },
):
  | { readonly _tag: "retry"; readonly draft: RevdocNoteDraft }
  | { readonly _tag: "conflict"; readonly draft: RevdocNoteDraft } =>
  current.note === (draft.conflict?.note ?? draft.original)
    ? { _tag: "retry", draft: { ...draft, baseRevision: current.revision, conflict: null } }
    : {
        _tag: "conflict",
        draft: { ...draft, conflict: { note: current.note, revision: current.revision } },
      };

export function createRevdocEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    review: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:revdoc:review",
      tag: SATELLITE_WS_METHODS.revdocSubscribe,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(() => EMPTY_REVDOC_STATE, applyRevdocEvent),
          Stream.drop(1),
        ),
    }),
    worktrees: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:revdoc:worktrees",
      tag: SATELLITE_WS_METHODS.revdocWorktrees,
      staleTimeMs: 30_000,
    }),
    getItems: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:revdoc:get-items",
      tag: SATELLITE_WS_METHODS.revdocGetItems,
    }),
    generate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:revdoc:generate",
      tag: SATELLITE_WS_METHODS.revdocGenerate,
    }),
    test: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:revdoc:test",
      tag: SATELLITE_WS_METHODS.revdocTest,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:revdoc:cancel",
      tag: SATELLITE_WS_METHODS.revdocCancel,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:revdoc:refresh",
      tag: SATELLITE_WS_METHODS.revdocRefresh,
    }),
    editItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:revdoc:edit-item",
      tag: SATELLITE_WS_METHODS.revdocEditItem,
    }),
    deleteReview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:revdoc:delete",
      tag: SATELLITE_WS_METHODS.revdocDelete,
    }),
  };
}

/**
 * Changes when a thread gains or drops a worktree, which is how worktrees the server creates
 * arrive, and when this client's own worktree create or remove settles. Worktree lists refetch on
 * it.
 */
export const createRevdocWorktreeChangesAtom = (
  threadsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<{ readonly worktreePath: string | null }>>,
) =>
  Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const paths = new Set<string>();
      for (const thread of get(threadsAtom(environmentId))) {
        if (thread.worktreePath) paths.add(thread.worktreePath);
      }
      const { revision } = get(vcsRefsCacheStateAtom({ environmentId }));
      return [revision, ...[...paths].sort()].join("\n");
    }).pipe(Atom.withLabel(`environment-data:revdoc:worktree-changes:${environmentId}`)),
  );
