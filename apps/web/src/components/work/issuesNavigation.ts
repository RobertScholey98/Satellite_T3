import { EnvironmentId, type IssueRef, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type IssuesMode = "board" | "list";

/** The `/issues` search parameters. `connect` opens the board configuration dialog once. */
export interface IssuesSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly boardId?: string;
  readonly ticket?: string;
  readonly mode?: IssuesMode;
  readonly connect?: true;
}

type NavigationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const NAVIGATION_KEY = "satellite:issues:navigation:v1";
/** Satellite 1.x kept issue start reservations here; they mean nothing to 2.0 servers. */
const LEGACY_ISSUE_DRAFTS_KEY = "t3code:issue-drafts";
const MAX_TEXT = 512;

const ShortText = Schema.String.check(Schema.isMaxLength(MAX_TEXT));
const StoredNavigation = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  projectId: Schema.optionalKey(ProjectId),
  boardId: Schema.optionalKey(ShortText),
  ticket: Schema.optionalKey(ShortText),
  mode: Schema.optionalKey(Schema.Literals(["board", "list"])),
});
const decodeStoredNavigation = Schema.decodeUnknownOption(StoredNavigation);

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" && value.length <= MAX_TEXT
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;

export function validateIssuesSearch(raw: Record<string, unknown>): IssuesSearch {
  const environmentId = text(raw.environmentId);
  const projectId = text(raw.projectId);
  const boardId = text(raw.boardId);
  const ticket = text(raw.ticket);
  return {
    ...(environmentId ? { environmentId: EnvironmentId.make(environmentId) } : {}),
    ...(projectId ? { projectId: ProjectId.make(projectId) } : {}),
    ...(boardId ? { boardId } : {}),
    ...(ticket ? { ticket } : {}),
    ...(raw.mode === "board" || raw.mode === "list" ? { mode: raw.mode } : {}),
    ...(raw.connect === true || raw.connect === 1 || raw.connect === "1" ? { connect: true } : {}),
  };
}

function defaultStorage(): NavigationStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** This device's last Issues selection. Also drops Satellite 1.x's issue draft store. */
export function readIssuesNavigation(storage = defaultStorage()): IssuesSearch {
  try {
    storage?.removeItem(LEGACY_ISSUE_DRAFTS_KEY);
    const raw = storage?.getItem(NAVIGATION_KEY);
    if (!raw) return {};
    const decoded = decodeStoredNavigation(JSON.parse(raw));
    return decoded._tag === "Some" ? decoded.value : {};
  } catch {
    return {};
  }
}

export function writeIssuesNavigation(search: IssuesSearch, storage = defaultStorage()) {
  const { connect: _connect, ...stored } = search;
  try {
    storage?.setItem(NAVIGATION_KEY, JSON.stringify(stored));
  } catch {
    // The URL stays usable when storage is full or denied.
  }
}

const HIERARCHY = ["environmentId", "projectId", "boardId", "ticket"] as const;

/**
 * Opening Issues fills what the link left out from the stored selection. Explicit fields always
 * win, and the stored selection fills nothing below a level the link points somewhere else.
 */
export function resolveIssuesSearch(explicit: IssuesSearch, stored: IssuesSearch): IssuesSearch {
  const consistent = HIERARCHY.every(
    (level) => explicit[level] === undefined || explicit[level] === stored[level],
  );
  const filled = consistent
    ? Object.fromEntries(
        HIERARCHY.flatMap((level) =>
          explicit[level] === undefined && stored[level] !== undefined
            ? [[level, stored[level]]]
            : [],
        ),
      )
    : {};
  return {
    ...filled,
    ...explicit,
    ...(explicit.mode === undefined && stored.mode ? { mode: stored.mode } : {}),
  };
}

/**
 * A ticket's URL key: its number, or `repository#number` when another ticket on the board shares
 * the number (a GitHub Project can span repositories).
 */
export function formatTicketParam(ref: IssueRef, others: ReadonlyArray<IssueRef>): string {
  const shared = others.some(
    (other) => other.number === ref.number && other.repository !== ref.repository,
  );
  return shared ? `${ref.repository}#${ref.number}` : String(ref.number);
}

export function matchesTicketParam(param: string, ref: IssueRef): boolean {
  const separator = param.lastIndexOf("#");
  if (separator < 0) return param === String(ref.number);
  return (
    param.slice(0, separator) === ref.repository &&
    param.slice(separator + 1) === String(ref.number)
  );
}
