import type { IssueOperationError } from "@t3tools/contracts";

/**
 * What an automatic move does when it reaches the front of the board's move queue. Decided at move
 * time against a fresh read of the remote board, because a person may have moved the ticket on any
 * computer or on the host's own page since the attempt last moved it.
 */
export type AutomaticMoveDecision =
  | { readonly _tag: "Superseded" }
  | { readonly _tag: "Skipped"; readonly reason: string }
  | { readonly _tag: "AlreadyThere" }
  | { readonly _tag: "Write" };

export interface AutomaticMoveFacts {
  readonly attemptActive: boolean;
  /** This move belongs to the attempt's latest transition. */
  readonly latestTransition: boolean;
  /** This environment holds a manual move for the ticket that has not reached the remote board. */
  readonly pendingManualMove: boolean;
  readonly remoteColumn: string | null;
  readonly target: string;
  /** Where the attempt last put the ticket. Null before its first move, when any Ready column counts. */
  readonly baseline: string | null;
  readonly readyColumns: ReadonlyArray<string>;
  readonly columnTitle: (columnId: string | null) => string;
}

const MANUAL_MOVE_PENDING = "A manual move for this ticket has not reached the board yet.";

const movedByHand = (title: string) => `Moved by hand to ${title}.`;

const isAtBaseline = (
  column: string | null,
  baseline: string | null,
  readyColumns: ReadonlyArray<string>,
) => (baseline === null ? column !== null && readyColumns.includes(column) : column === baseline);

export const decideAutomaticMove = (facts: AutomaticMoveFacts): AutomaticMoveDecision => {
  if (!facts.attemptActive || !facts.latestTransition) return { _tag: "Superseded" };
  if (facts.pendingManualMove) return { _tag: "Skipped", reason: MANUAL_MOVE_PENDING };
  if (facts.remoteColumn === facts.target) return { _tag: "AlreadyThere" };
  if (isAtBaseline(facts.remoteColumn, facts.baseline, facts.readyColumns))
    return { _tag: "Write" };
  return { _tag: "Skipped", reason: movedByHand(facts.columnTitle(facts.remoteColumn)) };
};

export type ManualMoveDecision = "write" | "already-there" | "conflict";

/** A manual move is refused when the remote board no longer shows what the person saw. */
export const decideManualMove = (facts: {
  readonly expected: string | null | undefined;
  readonly remoteColumn: string | null;
  readonly target: string;
}): ManualMoveDecision => {
  if (facts.expected !== undefined && facts.expected !== facts.remoteColumn) return "conflict";
  return facts.remoteColumn === facts.target ? "already-there" : "write";
};

/**
 * Whether the stored copy shows the attempt still in charge of its ticket. Read without a remote
 * call; the move itself rechecks the remote board.
 */
export const automaticMovesState = (facts: {
  readonly active: boolean;
  readonly storedColumn: string | null | undefined;
  readonly baseline: string | null;
  readonly readyColumns: ReadonlyArray<string>;
  readonly pendingTarget: string | null;
}): "on" | "paused" => {
  if (!facts.active || facts.storedColumn === undefined) return "on";
  if (facts.pendingTarget !== null && facts.storedColumn === facts.pendingTarget) return "on";
  return isAtBaseline(facts.storedColumn, facts.baseline, facts.readyColumns) ? "on" : "paused";
};

/** Transient failures stay pending and are retried by the sweep; lasting ones wait for Retry. */
export const isTransientFailure = (error: IssueOperationError) => error.reason === "remote";

export const MOVE_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Backoff for a transient move failure. Waiting as long as the move has already waited doubles
 * the gap between tries without counting them. Between one minute and one hour.
 */
export const moveRetryDelayMs = (waitedMs: number) =>
  Math.min(Math.max(waitedMs, 60_000), 60 * 60_000);
