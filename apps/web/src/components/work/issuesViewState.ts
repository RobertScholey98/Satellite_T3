import {
  type IssueAttempt,
  type IssueBoardColumn,
  type IssueBoardItem,
  type IssueBoardMapping,
  type IssueBoardView,
  type IssueMove,
  type IssueRef,
  type IssueSummary,
  issueReadyColumnIds,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const PREFERENCES_KEY = "satellite:issues:view:v1:";

const Preferences = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(512)),
  issueState: Schema.String.check(Schema.isMaxLength(512)),
  issueHost: Schema.String.check(Schema.isMaxLength(512)),
});
export type IssuesPreferences = typeof Preferences.Type;
const decodePreferences = Schema.decodeUnknownOption(Preferences);

export const DEFAULT_ISSUES_PREFERENCES: IssuesPreferences = {
  query: "",
  issueState: "all",
  issueHost: "all",
};

function defaultStorage(): PreferenceStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** Search and filters, remembered per environment and project on this device. */
export function readIssuesPreferences(
  scopeKey: string,
  storage = defaultStorage(),
): IssuesPreferences {
  try {
    const raw = storage?.getItem(PREFERENCES_KEY + scopeKey);
    if (!raw) return DEFAULT_ISSUES_PREFERENCES;
    const decoded = decodePreferences(JSON.parse(raw));
    return decoded._tag === "Some" ? decoded.value : DEFAULT_ISSUES_PREFERENCES;
  } catch {
    return DEFAULT_ISSUES_PREFERENCES;
  }
}

export function writeIssuesPreferences(
  scopeKey: string,
  value: IssuesPreferences,
  storage = defaultStorage(),
) {
  try {
    storage?.setItem(PREFERENCES_KEY + scopeKey, JSON.stringify(value));
  } catch {
    // Browsing still works when storage is unavailable.
  }
}

// Recent board views paint instantly on return; the server's stored copy replaces them. Kept in
// memory only, so ticket bodies never reach browser storage.
const views = new Map<string, IssueBoardView>();
const MAX_CACHED_VIEWS = 12;

export function readCachedBoardView(key: string): IssueBoardView | undefined {
  return views.get(key);
}

export function writeCachedBoardView(key: string, view: IssueBoardView | null) {
  views.delete(key);
  if (view === null) return;
  views.set(key, view);
  while (views.size > MAX_CACHED_VIEWS) views.delete(views.keys().next().value!);
}

export function sameIssue(left: IssueRef, right: IssueRef): boolean {
  return left.host === right.host && left.repository === right.repository && left.id === right.id;
}

const issueKey = (ref: IssueRef) => `${ref.host}\n${ref.repository}\n${ref.id}`;

function issueMatchesQuery(issue: IssueSummary, query: string): boolean {
  const needle = query.trim().replace(/^#/, "").toLowerCase();
  if (!needle) return true;
  return `${issue.ref.number} ${issue.title} ${issue.labels.join(" ")}`
    .toLowerCase()
    .includes(needle);
}

export function issueMatchesFilters(issue: IssueSummary, preferences: IssuesPreferences): boolean {
  return (
    (preferences.issueState === "all" || issue.state === preferences.issueState) &&
    (preferences.issueHost === "all" || issue.ref.host === preferences.issueHost) &&
    issueMatchesQuery(issue, preferences.query)
  );
}

export interface BoardColumnGroup {
  readonly column: IssueBoardColumn;
  readonly items: ReadonlyArray<IssueBoardItem>;
}

/** Items by column, in board order. Items in no known column land in `unassigned`. */
export function groupBoardColumns(
  view: Pick<IssueBoardView, "columns" | "items">,
  query: string,
): { columns: ReadonlyArray<BoardColumnGroup>; unassigned: ReadonlyArray<IssueBoardItem> } {
  const byColumn = new Map<string, IssueBoardItem[]>(view.columns.map((column) => [column.id, []]));
  const unassigned: IssueBoardItem[] = [];
  for (const item of view.items) {
    if (!issueMatchesQuery(item.issue, query)) continue;
    const bucket = item.columnId === null ? undefined : byColumn.get(item.columnId);
    if (bucket) bucket.push(item);
    else unassigned.push(item);
  }
  return {
    columns: view.columns.map((column) => ({ column, items: byColumn.get(column.id) ?? [] })),
    unassigned,
  };
}

export interface MoveBanner {
  readonly move: IssueMove;
  readonly message: string;
}

const sentence = (text: string) => text.trim().replace(/[.\s]+$/, "");

/**
 * Skipped and failed moves need a person: a skipped automatic move waits for Retry, and so does a
 * move that failed for a lasting reason. Only each ticket's latest move counts; a later move
 * settles earlier ones.
 */
export function selectMoveBanners(
  moves: ReadonlyArray<IssueMove>,
  columnTitle: (columnId: string) => string,
): ReadonlyArray<MoveBanner> {
  const latest = new Map<string, IssueMove>();
  for (const move of moves) {
    const key = issueKey(move.issue);
    const current = latest.get(key);
    if (!current || move.createdAt >= current.createdAt) latest.set(key, move);
  }
  return [...latest.values()].flatMap((move): MoveBanner[] => {
    const target = columnTitle(move.columnId);
    if (move.status === "skipped") {
      return [
        {
          move,
          message: `Automatic move to ${target} skipped: ${sentence(move.error ?? "moved by hand")}.`,
        },
      ];
    }
    if (move.status === "failed") {
      return [
        {
          move,
          message: `Move to ${target} failed: ${sentence(move.error ?? "the board refused it")}.`,
        },
      ];
    }
    return [];
  });
}

export function issueCanStart(
  item: Pick<IssueBoardItem, "columnId">,
  mapping: IssueBoardMapping | null,
): boolean {
  return (
    mapping !== null &&
    item.columnId !== null &&
    issueReadyColumnIds(mapping).includes(item.columnId)
  );
}

/** A ticket's attempts on this environment, active first, earlier ones newest first. */
export function issueAttemptGroups(
  attempts: ReadonlyArray<IssueAttempt>,
  issue: IssueRef,
): { active: ReadonlyArray<IssueAttempt>; earlier: ReadonlyArray<IssueAttempt> } {
  const own = attempts
    .filter((attempt) => sameIssue(attempt.issue, issue))
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  return {
    active: own.filter((attempt) => attempt.active),
    earlier: own.filter((attempt) => !attempt.active),
  };
}

/** Resume is the way back from Stop, so it is offered only while nothing else works the ticket. */
export function canResumeAttempt(
  attempt: IssueAttempt,
  attempts: ReadonlyArray<IssueAttempt>,
): boolean {
  return (
    !attempt.active &&
    attempt.status === "ended" &&
    attempt.endedReason === "user" &&
    !attempts.some((other) => other.active && sameIssue(other.issue, attempt.issue))
  );
}

const ATTEMPT_STATUS_LABELS: Record<IssueAttempt["status"], string> = {
  launching: "Starting",
  working: "Working",
  "in-pr": "In PR",
  merged: "Merged",
  failed: "Failed to start",
  ended: "Stopped",
};

export function attemptStatusLabel(attempt: IssueAttempt): string {
  if (attempt.status === "ended" && attempt.endedReason !== "user") {
    return attempt.endedReason === "superseded"
      ? "Replaced by a newer attempt"
      : attempt.endedReason === "thread-deleted"
        ? "Thread deleted"
        : "Linked from an earlier version";
  }
  return ATTEMPT_STATUS_LABELS[attempt.status];
}

/** Why a worktree branch name would be refused by git, following `git check-ref-format`. */
export function branchNameProblem(name: string): string | null {
  const branch = name.trim();
  if (!branch) return "Enter a branch name.";
  if (branch.length > 200) return "Use at most 200 characters.";
  if (/[\s~^:?*[\\]/.test(branch) || [...branch].some((character) => character < " ")) {
    return "Branch names cannot contain spaces or any of ~ ^ : ? * [ \\.";
  }
  if (
    branch === "@" ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.split("/").some((part) => part.startsWith("."))
  ) {
    return "That is not a valid git branch name.";
  }
  return null;
}
