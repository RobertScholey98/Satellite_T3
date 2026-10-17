import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ReviewDiffFileStat } from "./review.ts";

export const OPEN_WORK_WS_METHODS = {
  openWorkList: "openWork.list",
  openWorkTimeline: "openWork.timeline",
  openWorkDiff: "openWork.diff",
} as const;

/** Server-side payload caps. */
export const OPEN_WORK_MAX_COMMITS = 200;
export const OPEN_WORK_MAX_FILES_PER_COMMIT = 200;
export const OPEN_WORK_MAX_WIP_FILES = 500;

export const OpenWorkFileStatus = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "conflicted",
]);
export type OpenWorkFileStatus = typeof OpenWorkFileStatus.Type;

export const OpenWorkFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  status: OpenWorkFileStatus,
  /** Binary files and untracked files count zero lines. */
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OpenWorkFile = typeof OpenWorkFile.Type;

export const OpenWorkWipLayer = Schema.Literals(["staged", "unstaged", "untracked"]);
export type OpenWorkWipLayer = typeof OpenWorkWipLayer.Type;

/** A file staged and then edited again appears once per layer. */
export const OpenWorkWipFile = Schema.Struct({
  ...OpenWorkFile.fields,
  layer: OpenWorkWipLayer,
});
export type OpenWorkWipFile = typeof OpenWorkWipFile.Type;

export const OpenWorkWip = Schema.Struct({
  files: Schema.Array(OpenWorkWipFile),
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type OpenWorkWip = typeof OpenWorkWip.Type;

export const OpenWorktreeSummary = Schema.Struct({
  /** Canonical worktree path. It is the worktree's identity. */
  path: Schema.String,
  projectIds: Schema.Array(ProjectId),
  /** Null for a detached HEAD. */
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  /** The ref ahead and behind count against, or null when no main was found. */
  baseRef: Schema.NullOr(Schema.String),
  ahead: Schema.NullOr(NonNegativeInt),
  behind: Schema.NullOr(NonNegativeInt),
  hasChanges: Schema.Boolean,
  /** The repository's main checkout rather than a linked worktree. */
  primary: Schema.Boolean,
});
export type OpenWorktreeSummary = typeof OpenWorktreeSummary.Type;

export const OpenWorkCommit = Schema.Struct({
  sha: Schema.String,
  parents: Schema.Array(Schema.String),
  subject: Schema.String,
  committedAt: Schema.String,
  /** Compared with the first parent, so a merge lists what it brought in. */
  files: Schema.Array(OpenWorkFile),
  filesTruncated: Schema.Boolean,
});
export type OpenWorkCommit = typeof OpenWorkCommit.Type;

export const OpenWorkListInput = Schema.Struct({
  projectIds: Schema.optionalKey(Schema.Array(ProjectId)),
});
export type OpenWorkListInput = typeof OpenWorkListInput.Type;

export const OpenWorkListResult = Schema.Struct({
  worktrees: Schema.Array(OpenWorktreeSummary),
});
export type OpenWorkListResult = typeof OpenWorkListResult.Type;

export const OpenWorkTimelineInput = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type OpenWorkTimelineInput = typeof OpenWorkTimelineInput.Type;

export const OpenWorkTimelineResult = Schema.Struct({
  worktree: OpenWorktreeSummary,
  /** Commits beyond main, oldest first. Empty when no main was found. */
  commits: Schema.Array(OpenWorkCommit),
  commitsTruncated: Schema.Boolean,
  wip: OpenWorkWip,
});
export type OpenWorkTimelineResult = typeof OpenWorkTimelineResult.Type;

export const OpenWorkStep = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("commit"),
    sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{4,64}$/i)),
  }),
  Schema.Struct({ kind: Schema.Literal("wip") }),
]);
export type OpenWorkStep = typeof OpenWorkStep.Type;

export const OpenWorkDiffInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  step: OpenWorkStep,
  file: Schema.Struct({
    path: Schema.NonEmptyString,
    previousPath: Schema.NullOr(Schema.NonEmptyString),
  }),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type OpenWorkDiffInput = typeof OpenWorkDiffInput.Type;

export const OpenWorkDiffResult = Schema.Struct({
  title: Schema.String,
  baseRef: Schema.NullOr(Schema.String),
  headRef: Schema.NullOr(Schema.String),
  diff: Schema.String,
  truncated: Schema.Boolean,
  files: Schema.Array(ReviewDiffFileStat),
});
export type OpenWorkDiffResult = typeof OpenWorkDiffResult.Type;

/** The path is gone, is not a worktree, or belongs to no registered project's repository. */
export class OpenWorkWorktreeNotFoundError extends Schema.TaggedError<OpenWorkWorktreeNotFoundError>()(
  "OpenWorkWorktreeNotFoundError",
  { path: Schema.String },
) {
  override get message(): string {
    return `No worktree of a registered project is at ${this.path}.`;
  }
}

export class OpenWorkGitError extends Schema.TaggedError<OpenWorkGitError>()("OpenWorkGitError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Git could not complete ${this.operation}.`;
  }
}

export const OpenWorkError = Schema.Union([
  OpenWorkWorktreeNotFoundError,
  OpenWorkGitError,
  EnvironmentAuthorizationError,
]);

export const WsOpenWorkListRpc = Rpc.make(OPEN_WORK_WS_METHODS.openWorkList, {
  payload: OpenWorkListInput,
  success: OpenWorkListResult,
  error: OpenWorkError,
});

export const WsOpenWorkTimelineRpc = Rpc.make(OPEN_WORK_WS_METHODS.openWorkTimeline, {
  payload: OpenWorkTimelineInput,
  success: OpenWorkTimelineResult,
  error: OpenWorkError,
});

export const WsOpenWorkDiffRpc = Rpc.make(OPEN_WORK_WS_METHODS.openWorkDiff, {
  payload: OpenWorkDiffInput,
  success: OpenWorkDiffResult,
  error: OpenWorkError,
});
