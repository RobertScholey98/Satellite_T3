import type {
  IssueBoardView,
  IssueBoardSummary,
  IssueSummary,
  IssueBoardItem,
  IssueDetail,
} from "@t3tools/contracts";
import { Schema } from "effect";

const Preferences = Schema.Struct({
  mode: Schema.Literals(["board", "issues"]),
  query: Schema.String,
  issueState: Schema.String,
  issueHost: Schema.String,
});
const decodePreferences = Schema.decodeUnknownSync(Preferences);
export const defaultIssuesPreferences = {
  mode: "board",
  query: "",
  issueState: "all",
  issueHost: "all",
} as const;

export function readIssuesPreferences(key: string) {
  try {
    const raw = globalThis.localStorage?.getItem(`t3.issues.preferences.${key}`);
    return raw ? decodePreferences(JSON.parse(raw)) : defaultIssuesPreferences;
  } catch {
    return defaultIssuesPreferences;
  }
}
export function writeIssuesPreferences(key: string, value: typeof Preferences.Type) {
  try {
    globalThis.localStorage?.setItem(`t3.issues.preferences.${key}`, JSON.stringify(value));
  } catch {
    // Browsing still works when storage is unavailable.
  }
}

export interface IssuesSnapshot {
  boards: readonly IssueBoardSummary[];
  issueList: readonly IssueSummary[];
  nextCursor: string | null;
  view: IssueBoardView | null;
  selected: IssueBoardItem | null;
  detail: IssueDetail | null;
}
// Keep recent views during navigation without serializing potentially large issue bodies.
const snapshots = new Map<string, IssuesSnapshot>();
export function readIssuesSnapshot(key: string) {
  return snapshots.get(key);
}
export function writeIssuesSnapshot(key: string, snapshot: IssuesSnapshot) {
  snapshots.delete(key);
  // Store complete pages so the pagination cursor never skips truncated results.
  if (snapshot.issueList.length > 500 || (snapshot.view?.items.length ?? 0) > 1_000) return;
  snapshots.set(key, snapshot);
  while (snapshots.size > 12) snapshots.delete(snapshots.keys().next().value!);
}
export function clearIssuesSnapshots() {
  snapshots.clear();
}
