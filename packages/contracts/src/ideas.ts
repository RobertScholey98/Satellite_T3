import * as Schema from "effect/Schema";
import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ThreadPurpose = Schema.Literals(["work", "idea"]);
export type ThreadPurpose = typeof ThreadPurpose.Type;
export const IdeaEntryId = TrimmedNonEmptyString.pipe(Schema.brand("IdeaEntryId"));
export type IdeaEntryId = typeof IdeaEntryId.Type;
export const IdeaCategoryId = TrimmedNonEmptyString.pipe(Schema.brand("IdeaCategoryId"));
export type IdeaCategoryId = typeof IdeaCategoryId.Type;
export const IdeaArtifactId = TrimmedNonEmptyString.pipe(Schema.brand("IdeaArtifactId"));
export type IdeaArtifactId = typeof IdeaArtifactId.Type;
const Markdown = Schema.String.check(Schema.isMaxLength(500_000));
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
export const IdeaSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("message"), messageId: MessageId }),
  Schema.Struct({ kind: Schema.Literal("artifact"), artifactId: IdeaArtifactId }),
  Schema.Struct({ kind: Schema.Literal("activity"), activityId: EventId }),
]);
export type IdeaSource = typeof IdeaSource.Type;
export const IdeaDocument = Schema.Struct({
  markdown: Markdown,
  revision: NonNegativeInt,
  author: Schema.Literals(["user", "updater"]),
  updatedAt: IsoDateTime,
});
export const IdeaCategory = Schema.Struct({
  id: IdeaCategoryId,
  name: Title,
  revision: NonNegativeInt,
});
export const IdeaEntry = Schema.Struct({
  id: IdeaEntryId,
  title: Title,
  categoryId: IdeaCategoryId,
  document: IdeaDocument,
  sources: Schema.Array(IdeaSource),
});
export type IdeaEntry = typeof IdeaEntry.Type;
export const IdeaArtifact = Schema.Struct({
  textStatus: Schema.optional(Schema.Literals(["available", "image", "unsupported"])),
  id: IdeaArtifactId,
  name: Title,
  mediaType: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  source: Schema.Literals(["upload", "agent"]),
});
export type IdeaArtifact = typeof IdeaArtifact.Type;

const PitchSave = Schema.Struct({
  kind: Schema.Literal("pitch.save"),
  baseRevision: NonNegativeInt,
  markdown: Markdown,
});
const EntrySave = Schema.Struct({
  kind: Schema.Literal("entry.save"),
  id: IdeaEntryId,
  baseRevision: NonNegativeInt,
  title: Title,
  categoryId: IdeaCategoryId,
  markdown: Markdown,
  sources: Schema.Array(IdeaSource),
  restore: Schema.optional(Schema.Boolean),
});
const CategorySave = Schema.Struct({
  kind: Schema.Literal("category.save"),
  id: IdeaCategoryId,
  name: Title,
  baseRevision: NonNegativeInt,
});
const CategoryMerge = Schema.Struct({
  kind: Schema.Literal("category.merge"),
  id: IdeaCategoryId,
  targetId: IdeaCategoryId,
  baseRevision: NonNegativeInt,
  targetRevision: NonNegativeInt,
});
const EntryDelete = Schema.Struct({
  kind: Schema.Literal("entry.delete"),
  id: IdeaEntryId,
  baseRevision: NonNegativeInt,
});
const EntryMerge = Schema.Struct({
  kind: Schema.Literal("entry.merge"),
  id: IdeaEntryId,
  targetId: IdeaEntryId,
  baseRevision: NonNegativeInt,
  targetRevision: NonNegativeInt,
  markdown: Markdown,
});
export const IdeaContentEdit = Schema.Union([
  PitchSave,
  EntrySave,
  CategorySave,
  CategoryMerge,
  Schema.Struct({
    kind: Schema.Literal("category.delete"),
    id: IdeaCategoryId,
    baseRevision: NonNegativeInt,
  }),
  EntryDelete,
  EntryMerge,
]);
export type IdeaContentEdit = typeof IdeaContentEdit.Type;
export const IdeaProposal = Schema.Struct({
  id: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  edits: Schema.Array(IdeaContentEdit),
  reason: Schema.String,
  createdAt: IsoDateTime,
});
export const IdeaUpdate = Schema.Struct({
  status: Schema.Literals(["current", "waiting", "pending", "running", "failed"]),
  processedSequence: NonNegativeInt,
  requestedSequence: NonNegativeInt,
  runId: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(Schema.String),
});
export const IdeaUpdateHistory = Schema.Struct({
  id: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  summary: Schema.String,
  inverse: Schema.Array(IdeaContentEdit),
  undone: Schema.Boolean,
});
export const IdeaIssueDraft = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Title,
  body: Markdown,
  labels: Schema.Array(TrimmedNonEmptyString),
});
export type IdeaIssueDraft = typeof IdeaIssueDraft.Type;
export const IdeaPublishedIssue = Schema.Struct({
  draftId: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  number: NonNegativeInt,
  title: Title,
  publishedAt: IsoDateTime,
});
export const IdeaPromotion = Schema.Struct({
  target: Schema.Struct({ host: TrimmedNonEmptyString, repository: TrimmedNonEmptyString }),
  id: TrimmedNonEmptyString,
  sourceRevision: NonNegativeInt,
  status: Schema.Literals(["review", "approved", "publishing", "partial", "complete", "failed"]),
  drafts: Schema.Array(IdeaIssueDraft),
  issues: Schema.Array(IdeaPublishedIssue),
  remainingScope: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type IdeaPromotion = typeof IdeaPromotion.Type;
export const IdeaNotebook = Schema.Struct({
  threadId: ThreadId,
  revision: NonNegativeInt,
  contentRevision: NonNegativeInt,
  deletionEpoch: NonNegativeInt,
  status: Schema.Literals(["active", "settled", "deleting"]),
  updatedAt: IsoDateTime,
  editLeases: Schema.Array(
    Schema.Struct({
      resource: TrimmedNonEmptyString,
      leaseId: TrimmedNonEmptyString,
      expiresAt: IsoDateTime,
    }),
  ),
  pitch: IdeaDocument,
  categories: Schema.Array(IdeaCategory),
  entries: Schema.Array(IdeaEntry),
  aliases: Schema.Array(Schema.Struct({ from: IdeaEntryId, to: IdeaEntryId })),
  deletedEntries: Schema.Array(Schema.Struct({ id: IdeaEntryId, throughSequence: NonNegativeInt })),
  artifacts: Schema.Array(IdeaArtifact),
  update: IdeaUpdate,
  proposals: Schema.Array(IdeaProposal),
  history: Schema.Array(IdeaUpdateHistory),
  promotionHistory: Schema.Array(IdeaPromotion),
  promotion: Schema.NullOr(IdeaPromotion),
  deletionError: Schema.NullOr(Schema.String),
});
export type IdeaNotebook = typeof IdeaNotebook.Type;
export const IdeaSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Title,
  status: Schema.Literals(["active", "settled", "deleting"]),
  updatedAt: IsoDateTime,
  revision: NonNegativeInt,
  excerpt: Schema.String,
  updateStatus: IdeaUpdate.fields.status,
  deletionError: Schema.NullOr(Schema.String),
});
export type IdeaSummary = typeof IdeaSummary.Type;
export const IdeaEdit = Schema.Union([
  IdeaContentEdit,
  Schema.Struct({
    kind: Schema.Literal("edit.begin"),
    resource: TrimmedNonEmptyString,
    leaseId: TrimmedNonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal("edit.end"), leaseId: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("artifact.delete"), id: IdeaArtifactId }),
  Schema.Struct({
    kind: Schema.Literal("proposal.accept"),
    id: TrimmedNonEmptyString,
    reviewedContentRevision: NonNegativeInt,
  }),
  Schema.Struct({ kind: Schema.Literal("proposal.reject"), id: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("update.undo"), id: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("update.retry") }),
  Schema.Struct({
    kind: Schema.Literal("promotion.approve"),
    id: TrimmedNonEmptyString,
    sourceRevision: NonNegativeInt,
  }),
  Schema.Struct({ kind: Schema.Literal("promotion.reject"), id: TrimmedNonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("promotion.retry"),
    id: TrimmedNonEmptyString,
    sourceRevision: NonNegativeInt,
  }),
  Schema.Struct({ kind: Schema.Literal("idea.settle"), reviewedContentRevision: NonNegativeInt }),
  Schema.Struct({ kind: Schema.Literal("idea.reopen"), reviewedContentRevision: NonNegativeInt }),
]);
export type IdeaEdit = typeof IdeaEdit.Type;
export const IdeaSystemMutation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("update.request"), sequence: NonNegativeInt }),
  Schema.Struct({ kind: Schema.Literal("update.start"), runId: TrimmedNonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("update.apply"),
    runId: TrimmedNonEmptyString,
    throughSequence: NonNegativeInt,
    edits: Schema.Array(IdeaContentEdit),
    summary: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("update.fail"),
    runId: TrimmedNonEmptyString,
    error: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("artifact.register"), artifact: IdeaArtifact }),
  Schema.Struct({ kind: Schema.Literal("promotion.propose"), promotion: IdeaPromotion }),
  Schema.Struct({ kind: Schema.Literal("promotion.record"), promotion: IdeaPromotion }),
  Schema.Struct({ kind: Schema.Literal("delete.request") }),
  Schema.Struct({ kind: Schema.Literal("delete.fail"), error: Schema.String }),
]);
export type IdeaSystemMutation = typeof IdeaSystemMutation.Type;
export const IdeaMutation = Schema.Union([IdeaEdit, IdeaSystemMutation]);
export type IdeaMutation = typeof IdeaMutation.Type;
export const IdeaEditCommand = Schema.Struct({
  type: Schema.Literal("idea.edit"),
  commandId: CommandId,
  threadId: ThreadId,
  edit: IdeaEdit,
});
export const IdeaDeleteCommand = Schema.Struct({
  type: Schema.Literal("idea.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});
export const IdeaApplyCommand = Schema.Struct({
  type: Schema.Literal("idea.apply"),
  commandId: CommandId,
  threadId: ThreadId,
  deletionEpoch: NonNegativeInt,
  mutation: IdeaSystemMutation,
});
export const IdeaPurgeCommand = Schema.Struct({
  type: Schema.Literal("idea.purge"),
  commandId: CommandId,
  threadId: ThreadId,
  deletionEpoch: NonNegativeInt,
});
export const IdeaChangedPayload = Schema.Struct({
  threadId: ThreadId,
  mutation: IdeaMutation,
  updatedAt: IsoDateTime,
});
export const IdeaPurgedPayload = Schema.Struct({
  threadId: ThreadId,
  deletionEpoch: NonNegativeInt,
  deletedAt: IsoDateTime,
});
export const IdeaGetInput = Schema.Struct({ threadId: ThreadId });
export const IdeaListInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export const IdeaListResult = Schema.Struct({ ideas: Schema.Array(IdeaSummary) });
export const IdeaGetResult = Schema.Struct({ notebook: Schema.NullOr(IdeaNotebook) });
export const IdeaArtifactReadInput = Schema.Struct({
  threadId: ThreadId,
  artifactId: IdeaArtifactId,
});
export const IdeaArtifactReadResult = Schema.Struct({
  artifact: IdeaArtifact,
  contentBase64: Schema.String,
});
export const IdeaArtifactWriteInput = Schema.Struct({
  threadId: ThreadId,
  name: Title,
  mediaType: TrimmedNonEmptyString,
  contentBase64: Schema.String.check(Schema.isMaxLength(28_000_000)),
});
export const IDEA_WS_METHODS = {
  subscribeChanges: "ideas.subscribeChanges",
  list: "ideas.list",
  get: "ideas.get",
} as const;

export const IdeaChange = Schema.Struct({
  threadId: ThreadId,
  revision: NonNegativeInt,
  purged: Schema.Boolean,
});

export class IdeaOperationError extends Schema.TaggedError<IdeaOperationError>()(
  "IdeaOperationError",
  { message: Schema.String },
) {}
export const IdeaArtifactWriteResult = Schema.Struct({ artifact: IdeaArtifact });
