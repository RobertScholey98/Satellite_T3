import {
  DocumentAnswers,
  DocumentOperationError,
  DocumentRevision,
  DocumentSubmission,
  DocumentSummary,
  DocumentsPublishInput,
  McpCapabilityUnavailableError,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { DocumentService } from "../../../documents/DocumentService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext, DocumentService];
const failure = Schema.Union([DocumentOperationError, McpCapabilityUnavailableError]);
const { threadId: _threadId, ...publishFields } = DocumentsPublishInput.fields;
export const PublishDocumentInput = Schema.Struct(publishFields);

export const AgentDocumentDetail = Schema.Struct({
  document: DocumentSummary,
  revision: DocumentRevision,
  content: Schema.String,
  contentTruncated: Schema.Boolean,
  answers: DocumentAnswers,
  answerVersion: NonNegativeInt,
  lastSubmission: Schema.NullOr(DocumentSubmission),
});

const PublishDocument = Tool.make("publish_document", {
  description:
    "Publish an existing self-contained HTML, Markdown, or text file to this thread's Documents panel. Use this for plans, reports, and manual verification checklists the user should retain or review. T3 preserves a snapshot and its revision history independently of your working file. Supply a fresh requestId; reuse the exact request when retrying. For a replacement pass documentId and expectedCurrentRevisionId from list_documents. Optional definition.items gives the review items stable IDs and enables Complete/Broken/Request change/Skipped answers with notes. This does not approve the document or start a turn. New revisions never inherit previous answers. User review results arrive in this thread after explicit submission.",
  parameters: PublishDocumentInput,
  success: DocumentSummary,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Publish document to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListDocuments = Tool.make("list_documents", {
  description:
    "List this thread's retained plans, review checklists, and other published documents, including the current revision and submission status. Read a document before revising it so you retain its identity and use the current revision. A submitted review records the user's results; it does not mean every verification item passed.",
  success: Schema.Struct({ documents: Schema.Array(DocumentSummary) }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List thread documents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadDocument = Tool.make("read_document", {
  description:
    "Read a published document from this thread, its checklist, current saved answers, and last submitted review. An optional revisionId reads a retained historical revision. Content is limited to 20,000 characters and contentTruncated reports that limit. Saved draft answers are not a submitted decision; only lastSubmission is a frozen user submission.",
  parameters: Schema.Struct({
    documentId: TrimmedNonEmptyString,
    revisionId: Schema.optional(TrimmedNonEmptyString),
  }),
  success: AgentDocumentDetail,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Read thread document")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DocumentsToolkit = Toolkit.make(PublishDocument, ListDocuments, ReadDocument);
