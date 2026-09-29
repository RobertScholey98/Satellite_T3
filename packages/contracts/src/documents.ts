import * as Schema from "effect/Schema";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const DocumentId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const DocumentTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
export const DocumentKind = Schema.Literals(["plan", "review", "document"]);
export const DocumentFormat = Schema.Literals(["html", "markdown", "text"]);
export const DocumentChecklist = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: DocumentId,
      title: DocumentTitle,
      description: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
    }),
  ).check(Schema.isMaxLength(200)),
});
export type DocumentChecklist = typeof DocumentChecklist.Type;
export const DocumentAnswer = Schema.Struct({
  itemId: DocumentId,
  outcome: Schema.Literals(["pending", "complete", "broken", "change_requested", "skipped"]),
  notes: Schema.String.check(Schema.isMaxLength(8000)),
});
export type DocumentAnswer = typeof DocumentAnswer.Type;
export const DocumentAnswers = Schema.Array(DocumentAnswer).check(Schema.isMaxLength(200));
export const DocumentSummary = Schema.Struct({
  id: DocumentId,
  threadId: ThreadId,
  title: DocumentTitle,
  kind: DocumentKind,
  currentRevisionId: DocumentId,
  revisionNumber: NonNegativeInt,
  status: Schema.Literals(["draft", "submitted"]),
  updatedAt: Schema.String,
});
export type DocumentSummary = typeof DocumentSummary.Type;
export const DocumentRevision = Schema.Struct({
  id: DocumentId,
  documentId: DocumentId,
  number: NonNegativeInt,
  format: DocumentFormat,
  contentHash: Schema.String,
  createdAt: Schema.String,
  definition: Schema.NullOr(DocumentChecklist),
});
export type DocumentRevision = typeof DocumentRevision.Type;
export const DocumentSubmission = Schema.Struct({
  id: DocumentId,
  documentId: DocumentId,
  revisionId: DocumentId,
  answerVersion: NonNegativeInt,
  answers: DocumentAnswers,
  markdown: Schema.String,
  createdAt: Schema.String,
  actor: Schema.String,
  delivery: Schema.Literals(["pending", "failed", "delivered"]),
  deliveryError: Schema.NullOr(Schema.String),
});
export type DocumentSubmission = typeof DocumentSubmission.Type;
export const DocumentDetail = Schema.Struct({
  document: DocumentSummary,
  revision: DocumentRevision,
  content: Schema.String,
  answers: DocumentAnswers,
  answerVersion: NonNegativeInt,
  lastSubmission: Schema.NullOr(DocumentSubmission),
});
export type DocumentDetail = typeof DocumentDetail.Type;
export const DocumentHistoryEvent = Schema.Struct({
  id: DocumentId,
  documentId: DocumentId,
  revisionId: DocumentId,
  event: Schema.Literals(["published", "draft-saved", "submitted", "delivery"]),
  actor: Schema.String,
  createdAt: Schema.String,
  detail: Schema.String,
  answerVersion: Schema.NullOr(NonNegativeInt),
  answers: Schema.NullOr(DocumentAnswers),
});
export type DocumentHistoryEvent = typeof DocumentHistoryEvent.Type;
export const DocumentsListInput = Schema.Struct({ threadId: ThreadId });
export type DocumentsListInput = typeof DocumentsListInput.Type;
export const DocumentsGetInput = Schema.Struct({
  documentId: DocumentId,
  revisionId: Schema.optional(DocumentId),
});
export type DocumentsGetInput = typeof DocumentsGetInput.Type;
export const DocumentsPublishInput = Schema.Struct({
  requestId: DocumentId,
  threadId: ThreadId,
  documentId: Schema.optional(DocumentId),
  expectedCurrentRevisionId: Schema.optional(DocumentId),
  title: DocumentTitle,
  kind: DocumentKind,
  path: TrimmedNonEmptyString,
  definition: Schema.optional(Schema.NullOr(DocumentChecklist)),
});
export type DocumentsPublishInput = typeof DocumentsPublishInput.Type;
export const DocumentsSaveDraftInput = Schema.Struct({
  documentId: DocumentId,
  revisionId: DocumentId,
  expectedAnswerVersion: NonNegativeInt,
  requestId: DocumentId,
  answers: DocumentAnswers,
});
export type DocumentsSaveDraftInput = typeof DocumentsSaveDraftInput.Type;
export const DocumentsSubmitInput = DocumentsSaveDraftInput;
export type DocumentsSubmitInput = typeof DocumentsSubmitInput.Type;
export const DocumentsRetryInput = Schema.Struct({ submissionId: DocumentId });
export type DocumentsRetryInput = typeof DocumentsRetryInput.Type;
export const DocumentsHistoryInput = Schema.Struct({ documentId: DocumentId });
export type DocumentsHistoryInput = typeof DocumentsHistoryInput.Type;
export const DocumentsHistoryResult = Schema.Struct({
  revisions: Schema.Array(DocumentRevision),
  events: Schema.Array(DocumentHistoryEvent),
  submissions: Schema.Array(DocumentSubmission),
});
export type DocumentsHistoryResult = typeof DocumentsHistoryResult.Type;
export class DocumentOperationError extends Schema.TaggedError<DocumentOperationError>()(
  "DocumentOperationError",
  {
    reason: Schema.Literals(["not-found", "conflict", "invalid", "storage", "delivery"]),
    message: Schema.String,
  },
) {}
