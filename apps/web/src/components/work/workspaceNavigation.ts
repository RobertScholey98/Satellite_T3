import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { PullRequestsSearch } from "~/routes/_chat.pull-requests";
import {
  PullRequestListPreferencesSchema,
  pullRequestListPreferences,
  readPullRequestListPreferences,
} from "../pullRequest/pullRequestListPreferences";

const ShortText = Schema.String.check(Schema.isMaxLength(512));
const WorkAreaSearch = Schema.Struct({
  ...PullRequestListPreferencesSchema.fields,
  tab: Schema.optional(Schema.Literals(["pull-requests", "issues", "open"])),
  boardId: Schema.optional(ShortText),
  boardEnvironmentId: Schema.optional(EnvironmentId),
  boardProjectId: Schema.optional(ProjectId),
  issueId: Schema.optional(ShortText),
  workEnvironmentId: Schema.optional(EnvironmentId),
  worktreePath: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  repository: Schema.optional(ShortText),
  number: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  selectedProjectId: Schema.optional(ProjectId),
  selectedHost: Schema.optional(ShortText),
  selectedEnvironmentId: Schema.optional(EnvironmentId),
});
const decodeSearch = Schema.decodeUnknownOption(WorkAreaSearch);
const STORAGE_KEY = "t3.workArea.navigation";
type NavigationStorage = Pick<Storage, "getItem" | "setItem">;
function navigationSearch(value: typeof WorkAreaSearch.Type): PullRequestsSearch {
  return {
    ...pullRequestListPreferences(value),
    ...(value.tab ? { tab: value.tab } : {}),
    ...(value.boardId ? { boardId: value.boardId } : {}),
    ...(value.boardEnvironmentId ? { boardEnvironmentId: value.boardEnvironmentId } : {}),
    ...(value.boardProjectId ? { boardProjectId: value.boardProjectId } : {}),
    ...(value.issueId ? { issueId: value.issueId } : {}),
    ...(value.workEnvironmentId ? { workEnvironmentId: value.workEnvironmentId } : {}),
    ...(value.worktreePath ? { worktreePath: value.worktreePath } : {}),
    ...(value.repository ? { repository: value.repository } : {}),
    ...(value.number ? { number: value.number } : {}),
    ...(value.selectedProjectId ? { selectedProjectId: value.selectedProjectId } : {}),
    ...(value.selectedHost ? { selectedHost: value.selectedHost } : {}),
    ...(value.selectedEnvironmentId ? { selectedEnvironmentId: value.selectedEnvironmentId } : {}),
  };
}

/** Used only for opening the workspace; explicit links keep their own selection. */
export function readWorkAreaSearch(storage?: NavigationStorage): PullRequestsSearch {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const raw = source?.getItem(STORAGE_KEY);
    if (raw) {
      const decoded = decodeSearch(JSON.parse(raw));
      if (decoded._tag === "Some") return navigationSearch(decoded.value);
    }
  } catch {
    // Invalid or unavailable storage should not prevent navigation.
  }
  return readPullRequestListPreferences(storage);
}

export function writeWorkAreaSearch(search: PullRequestsSearch, storage?: NavigationStorage) {
  try {
    const decoded = decodeSearch(search);
    if (decoded._tag === "None") return;
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(STORAGE_KEY, JSON.stringify(decoded.value));
  } catch {
    // The current URL remains usable when storage is full or denied.
  }
}
