import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OpenWorkPublicationStep = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("wip") }),
  Schema.Struct({ kind: Schema.Literal("commit"), commitSha: TrimmedNonEmptyString }),
]);
export const OpenWorkStep = Schema.Union([
  OpenWorkPublicationStep,
  Schema.Struct({ kind: Schema.Literal("unassigned") }),
]);
export type OpenWorkPublicationStep = typeof OpenWorkPublicationStep.Type;
export type OpenWorkStep = typeof OpenWorkStep.Type;
export const OpenWorkFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "untracked",
    "conflicted",
  ]),
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OpenWorkFile = typeof OpenWorkFile.Type;
export const OpenWorkWipFile = Schema.Struct({
  ...OpenWorkFile.fields,
  layer: Schema.Literals(["staged", "unstaged", "untracked"]),
});
export type OpenWorkWipFile = typeof OpenWorkWipFile.Type;
export const OpenWorkWip = Schema.Struct({
  files: Schema.Array(OpenWorkWipFile),
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export const OpenWorktreeSummary = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  projectIds: Schema.Array(ProjectId),
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  baseRef: Schema.NullOr(Schema.String),
  ahead: Schema.NullOr(NonNegativeInt),
  behind: Schema.NullOr(NonNegativeInt),
  hasChanges: Schema.Boolean,
});
export type OpenWorktreeSummary = typeof OpenWorktreeSummary.Type;
export const OpenWorkCommit = Schema.Struct({
  sha: Schema.String,
  parents: Schema.Array(Schema.String),
  subject: Schema.String,
  committedAt: Schema.String,
  files: Schema.Array(OpenWorkFile),
});
export type OpenWorkCommit = typeof OpenWorkCommit.Type;
export const OpenWorkDocument = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  worktreeId: Schema.String,
  source: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("published"),
      documentId: Schema.String,
      revisionId: Schema.String,
      threadId: ThreadId,
    }),
    Schema.Struct({
      kind: Schema.Literal("linked"),
      folderLinkId: Schema.String,
      path: Schema.String,
    }),
  ]),
  step: OpenWorkStep,
  favorite: Schema.Boolean,
  available: Schema.Boolean,
  unresolved: Schema.NullOr(Schema.Literals(["history-diverged", "creation-time-unavailable"])),
});
export type OpenWorkDocument = typeof OpenWorkDocument.Type;
export const OpenWorkTimeLink = Schema.Literals(["none", "birthtime", "mtime"]);
export type OpenWorkTimeLink = typeof OpenWorkTimeLink.Type;
export const OpenWorkFolderLink = Schema.Struct({
  id: Schema.String,
  worktreeId: Schema.String,
  path: Schema.String,
  timeLink: OpenWorkTimeLink,
});
export type OpenWorkFolderLink = typeof OpenWorkFolderLink.Type;
export const OpenWorkListInput = Schema.Struct({
  projectIds: Schema.optional(Schema.Array(ProjectId)),
});
export const OpenWorkListResult = Schema.Struct({ worktrees: Schema.Array(OpenWorktreeSummary) });
export const OpenWorkTimelineInput = Schema.Struct({ worktreeId: TrimmedNonEmptyString });
export const OpenWorkTimelineResult = Schema.Struct({
  worktree: OpenWorktreeSummary,
  commits: Schema.Array(OpenWorkCommit),
  wip: OpenWorkWip,
  documents: Schema.Array(OpenWorkDocument),
  folderLinks: Schema.Array(OpenWorkFolderLink),
});
export const OpenWorkLinkFolderInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  worktreeId: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  timeLink: OpenWorkTimeLink,
});
export const OpenWorkUnlinkFolderInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  folderLinkId: TrimmedNonEmptyString,
});
export const OpenWorkAssignDocumentInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  documentId: TrimmedNonEmptyString,
  step: OpenWorkStep,
});
export const OpenWorkFavoriteInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  documentId: TrimmedNonEmptyString,
  favorite: Schema.Boolean,
});
export const OpenWorkFavoritesInput = Schema.Struct({});
export const OpenWorkFavoritesResult = Schema.Struct({ documents: Schema.Array(OpenWorkDocument) });
export const OpenWorkReadLinkedInput = Schema.Struct({ documentId: TrimmedNonEmptyString });
export const OpenWorkReadLinkedResult = Schema.Struct({
  format: Schema.Literals(["html", "markdown"]),
  content: Schema.String,
  truncated: Schema.Boolean,
});
export type OpenWorkTimelineResult = typeof OpenWorkTimelineResult.Type;
export type OpenWorkReadLinkedResult = typeof OpenWorkReadLinkedResult.Type;
export class OpenWorkOperationError extends Schema.TaggedError<OpenWorkOperationError>()(
  "OpenWorkOperationError",
  {
    reason: Schema.Literals(["not-found", "invalid", "storage", "git", "conflict"]),
    message: Schema.String,
  },
) {}
