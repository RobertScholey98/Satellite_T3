import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  ThreadId,
  DocumentOperationError,
  DocumentSummary,
  DocumentRevision,
  DocumentSubmission,
  DocumentHistoryEvent,
  DocumentAnswers,
  DocumentChecklist,
  type DocumentDetail,
  type DocumentsPublishInput,
  type DocumentsSaveDraftInput,
  type DocumentsListInput,
  type DocumentsGetInput,
  type DocumentsHistoryInput,
  type DocumentsHistoryResult,
  type DocumentsRetryInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import {
  makePublicationRecorder,
  type PublicationInput,
} from "../openWork/PublicationRepository.ts";

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_ANSWER_BYTES = 64 * 1024;
const error = (reason: DocumentOperationError["reason"], message: string) =>
  new DocumentOperationError({ reason, message });
const storageError = () => error("storage", "Could not read or save the managed document.");
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const uuid = () => NodeCrypto.randomUUID();
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(storageError));
const decodeSummaryValue = Schema.decodeUnknownEffect(DocumentSummary);
const decodeRevisionValue = Schema.decodeUnknownEffect(DocumentRevision);
const decodeSubmissionValue = Schema.decodeUnknownEffect(DocumentSubmission);
const decodeHistoryValue = Schema.decodeUnknownEffect(DocumentHistoryEvent);
const isDocumentOperationError = Schema.is(DocumentOperationError);
const isPreviouslyRejected = Schema.is(OrchestrationCommandPreviouslyRejectedError);

interface DocumentRow {
  id: string;
  thread_id: string;
  title: string;
  kind: string;
  current_revision_id: string;
  revision_number: number;
  status: string;
  updated_at: string;
}
interface RevisionRow {
  id: string;
  document_id: string;
  number: number;
  format: string;
  content_hash: string;
  created_at: string;
  definition_json: string;
  snapshot_path: string;
  answers_json: string;
  answer_version: number;
}
interface SubmissionRow {
  id: string;
  document_id: string;
  revision_id: string;
  answer_version: number;
  answers_json: string;
  markdown: string;
  created_at: string;
  actor: string;
  delivery: string;
  delivery_error: string | null;
  delivery_attempt: number;
}
interface HistoryRow {
  id: string;
  document_id: string;
  revision_id: string;
  event: string;
  actor: string;
  created_at: string;
  detail: string;
  answer_version: number | null;
  answers_json: string | null;
}
const decodeSummary = (row: DocumentRow) =>
  decodeSummaryValue({
    id: row.id,
    threadId: row.thread_id,
    title: row.title,
    kind: row.kind,
    currentRevisionId: row.current_revision_id,
    revisionNumber: row.revision_number,
    status: row.status,
    updatedAt: row.updated_at,
  }).pipe(Effect.mapError(storageError));
const decodeRevision = Effect.fnUntraced(function* (row: RevisionRow) {
  const definition = yield* parse(Schema.NullOr(DocumentChecklist), row.definition_json);
  return yield* decodeRevisionValue({
    id: row.id,
    documentId: row.document_id,
    number: row.number,
    format: row.format,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    definition,
  }).pipe(Effect.mapError(storageError));
});
const decodeSubmission = Effect.fnUntraced(function* (row: SubmissionRow) {
  const answers = yield* parse(DocumentAnswers, row.answers_json);
  return yield* decodeSubmissionValue({
    id: row.id,
    documentId: row.document_id,
    revisionId: row.revision_id,
    answerVersion: row.answer_version,
    answers,
    markdown: row.markdown,
    createdAt: row.created_at,
    actor: row.actor,
    delivery: row.delivery,
    deliveryError: row.delivery_error,
  }).pipe(Effect.mapError(storageError));
});

export class DocumentService extends Context.Service<
  DocumentService,
  {
    readonly list: (
      input: DocumentsListInput,
    ) => Effect.Effect<ReadonlyArray<DocumentSummary>, DocumentOperationError>;
    readonly get: (
      input: DocumentsGetInput,
    ) => Effect.Effect<DocumentDetail, DocumentOperationError>;
    readonly publish: (
      input: DocumentsPublishInput,
      actor: string,
    ) => Effect.Effect<DocumentDetail, DocumentOperationError>;
    readonly saveDraft: (
      input: DocumentsSaveDraftInput,
      actor: string,
    ) => Effect.Effect<DocumentDetail, DocumentOperationError>;
    readonly submit: (
      input: DocumentsSaveDraftInput,
      actor: string,
    ) => Effect.Effect<DocumentSubmission, DocumentOperationError>;
    readonly retry: (
      input: DocumentsRetryInput,
      actor: string,
    ) => Effect.Effect<DocumentSubmission, DocumentOperationError>;
    readonly history: (
      input: DocumentsHistoryInput,
    ) => Effect.Effect<DocumentsHistoryResult, DocumentOperationError>;
  }
>()("t3/documents/DocumentService") {
  static readonly layer = Layer.suspend(() =>
    Layer.effect(
      DocumentService,
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const engine = yield* OrchestrationEngineService;
        const projection = yield* ProjectionSnapshotQuery;
        const recordPublication = yield* makePublicationRecorder;
        return yield* makeDocumentService({
          stateDir: config.stateDir,
          dispatch: engine.dispatch,
          getThread: projection.getThreadShellById,
          recordPublication: (input) =>
            Effect.gen(function* () {
              const thread = yield* projection.getThreadShellById(input.threadId);
              if (Option.isNone(thread)) return;
              const project = yield* projection.getProjectShellById(thread.value.projectId);
              if (Option.isNone(project)) return;
              yield* recordPublication({
                ...input,
                worktreePath: thread.value.worktreePath ?? project.value.workspaceRoot,
              });
            }).pipe(Effect.mapError(storageError)),
        });
      }),
    ),
  );
}

export const makeDocumentService = (options: {
  readonly stateDir: string;
  readonly dispatch: OrchestrationEngineShape["dispatch"];
  readonly getThread: ProjectionSnapshotQueryShape["getThreadShellById"];
  readonly recordPublication?: (
    input: Omit<PublicationInput, "worktreePath">,
  ) => Effect.Effect<void, DocumentOperationError>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mutex = yield* Semaphore.make(1);
    const snapshotRoot = path.join(options.stateDir, "documents");
    yield* fs.makeDirectory(snapshotRoot, { recursive: true }).pipe(Effect.mapError(storageError));
    const preserveError = (cause: unknown) =>
      isDocumentOperationError(cause) ? cause : storageError();
    const protect = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError(preserveError));
    const transaction = <A, E>(effect: Effect.Effect<A, E>) => protect(sql.withTransaction(effect));

    const readDocument = Effect.fnUntraced(function* (id: string) {
      const rows = yield* sql<DocumentRow>`SELECT * FROM managed_documents WHERE id=${id}`.pipe(
        Effect.mapError(storageError),
      );
      if (!rows[0]) return yield* error("not-found", "Document not found.");
      return rows[0];
    });
    const readRevision = Effect.fnUntraced(function* (documentId: string, revisionId: string) {
      const rows =
        yield* sql<RevisionRow>`SELECT * FROM document_revisions WHERE document_id=${documentId} AND id=${revisionId}`.pipe(
          Effect.mapError(storageError),
        );
      if (!rows[0]) return yield* error("not-found", "Document revision not found.");
      return rows[0];
    });
    const readSubmission = Effect.fnUntraced(function* (id: string) {
      const rows =
        yield* sql<SubmissionRow>`SELECT * FROM document_submissions WHERE id=${id}`.pipe(
          Effect.mapError(storageError),
        );
      if (!rows[0]) return yield* error("not-found", "Submission not found.");
      return rows[0];
    });
    const requireThread = Effect.fnUntraced(function* (threadId: ThreadId) {
      const thread = yield* options.getThread(threadId).pipe(Effect.mapError(storageError));
      if (Option.isNone(thread))
        return yield* error("not-found", "The original thread is unavailable.");
      return thread.value;
    });
    const get = Effect.fn("DocumentService.get")(function* (
      input: DocumentsGetInput,
    ): Effect.fn.Return<DocumentDetail, DocumentOperationError> {
      const row = yield* readDocument(input.documentId);
      const revisionRow = yield* readRevision(row.id, input.revisionId ?? row.current_revision_id);
      const document = yield* decodeSummary(row);
      const revision = yield* decodeRevision(revisionRow);
      const answers = yield* parse(DocumentAnswers, revisionRow.answers_json);
      // Legacy snapshots stored absolute host paths. Resolve their basename below
      // the current home so restored data never reads from the previous location.
      const snapshotFilename = revisionRow.snapshot_path.split(/[\\/]/).at(-1) ?? "";
      if (!/^[a-f0-9-]{36}\.(?:html|md|txt)$/.test(snapshotFilename)) return yield* storageError();
      const content = yield* fs
        .readFileString(path.join(snapshotRoot, snapshotFilename))
        .pipe(Effect.mapError(storageError));
      if (hash(content) !== revisionRow.content_hash)
        return yield* error(
          "storage",
          "The managed document snapshot changed. Its revision cannot be displayed.",
        );
      const submissions =
        yield* sql<SubmissionRow>`SELECT * FROM document_submissions WHERE revision_id=${revisionRow.id} ORDER BY rowid DESC LIMIT 1`.pipe(
          Effect.mapError(storageError),
        );
      return {
        document,
        revision,
        content,
        answers,
        answerVersion: revisionRow.answer_version,
        lastSubmission: submissions[0] ? yield* decodeSubmission(submissions[0]) : null,
      };
    });
    const list = Effect.fn("DocumentService.list")(function* (input: DocumentsListInput) {
      const rows =
        yield* sql<DocumentRow>`SELECT * FROM managed_documents WHERE thread_id=${input.threadId} ORDER BY updated_at DESC`.pipe(
          Effect.mapError(storageError),
        );
      return yield* Effect.forEach(rows, decodeSummary);
    });
    const recordHistory = Effect.fnUntraced(function* (input: {
      documentId: string;
      revisionId: string;
      event: DocumentHistoryEvent["event"];
      actor: string;
      detail: string;
      answerVersion?: number;
      answers?: ReadonlyArray<(typeof DocumentAnswers.Type)[number]>;
    }) {
      const createdAt = yield* now;
      yield* sql`INSERT INTO document_history (id,document_id,revision_id,event,actor,created_at,detail,answer_version,answers_json)
      VALUES (${uuid()},${input.documentId},${input.revisionId},${input.event},${input.actor},${createdAt},${input.detail},${input.answerVersion ?? null},${input.answers ? json(input.answers) : null})`;
    });
    const findRequest = Effect.fnUntraced(function* (
      actor: string,
      requestId: string,
      payloadHash: string,
    ) {
      const rows = yield* sql<{
        payload_hash: string;
        result_json: string;
      }>`SELECT payload_hash,result_json FROM document_requests WHERE actor=${actor} AND request_id=${requestId}`;
      if (!rows[0]) return null;
      if (rows[0].payload_hash !== payloadHash)
        return yield* error("conflict", "This request ID was already used with different data.");
      return rows[0].result_json;
    });
    const saveRequest = (actor: string, requestId: string, payloadHash: string, result: unknown) =>
      sql`INSERT INTO document_requests (actor,request_id,payload_hash,result_json) VALUES (${actor},${requestId},${payloadHash},${json(result)})`;
    const normalizeAnswers = Effect.fnUntraced(function* (
      definition: DocumentChecklist | null,
      supplied: typeof DocumentAnswers.Type,
    ) {
      if (Buffer.byteLength(json(supplied), "utf8") > MAX_ANSWER_BYTES)
        return yield* error("invalid", "Answers exceed the 64 KB limit.");
      const itemIds = new Set(definition?.items.map((item) => item.id) ?? []);
      const answers = new Map<string, (typeof DocumentAnswers.Type)[number]>();
      for (const answer of supplied) {
        if (!itemIds.has(answer.itemId) || answers.has(answer.itemId))
          return yield* error("invalid", "Answers must name each checklist item at most once.");
        answers.set(answer.itemId, answer);
      }
      return (
        definition?.items.map(
          (item) =>
            answers.get(item.id) ?? { itemId: item.id, outcome: "pending" as const, notes: "" },
        ) ?? []
      );
    });
    const publishUnlocked = Effect.fn("DocumentService.publish")(function* (
      input: DocumentsPublishInput,
      actor: string,
    ) {
      const payloadHash = hash(json({ operation: "publish", ...input }));
      const receipt = yield* transaction(
        Effect.gen(function* () {
          const previous = yield* findRequest(actor, input.requestId, payloadHash);
          if (previous)
            return yield* parse(
              Schema.Struct({ documentId: Schema.String, revisionId: Schema.String }),
              previous,
            );
          yield* requireThread(input.threadId);
          const existing = input.documentId ? yield* readDocument(input.documentId) : null;
          if (
            existing &&
            (existing.thread_id !== input.threadId ||
              input.expectedCurrentRevisionId !== existing.current_revision_id)
          )
            return yield* error(
              "conflict",
              "The document revision changed. Reload before publishing.",
            );
          if (!path.isAbsolute(input.path))
            return yield* error("invalid", "Publish requires an absolute host file path.");
          const extension = path.extname(input.path).toLowerCase();
          const format =
            extension === ".html" || extension === ".htm"
              ? "html"
              : extension === ".md" || extension === ".markdown"
                ? "markdown"
                : extension === ".txt"
                  ? "text"
                  : null;
          if (!format)
            return yield* error(
              "invalid",
              "Only self-contained HTML, Markdown, and text documents are supported.",
            );
          const stat = yield* fs.stat(input.path).pipe(Effect.mapError(storageError));
          if (stat.type !== "File" || Number(stat.size) > MAX_SNAPSHOT_BYTES)
            return yield* error("invalid", "Document must be a regular file smaller than 2 MB.");
          const chunks = yield* fs
            .stream(input.path, { bytesToRead: MAX_SNAPSHOT_BYTES + 1 })
            .pipe(Stream.runCollect, Effect.mapError(storageError));
          const bytes = Buffer.concat(chunks);
          if (bytes.length > MAX_SNAPSHOT_BYTES)
            return yield* error("invalid", "Document exceeds the 2 MB limit.");
          const content = yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            catch: () => error("invalid", "Document must be UTF-8 text."),
          });
          if (
            format === "html" &&
            (/<(?:script|img|iframe|source|video|audio|link|object|embed)\b[^>]*\b(?:src|srcset|href|data)\s*=\s*(?:["'](?!data:|#)[^"']+["']|(?!["']|data:|#)[^\s>]+)/i.test(
              content,
            ) ||
              /\burl\(\s*["']?(?!data:|#)[^\s)"'][^)]*\)/i.test(content) ||
              /@import\s/i.test(content))
          )
            return yield* error(
              "invalid",
              "HTML snapshots must inline their scripts and resources.",
            );
          const definition = input.definition ?? null;
          if (
            definition &&
            new Set(definition.items.map((item) => item.id)).size !== definition.items.length
          )
            return yield* error("invalid", "Checklist item IDs must be unique.");
          const documentId = existing?.id ?? uuid();
          const revisionId = uuid();
          const number = (existing?.revision_number ?? 0) + 1;
          const createdAt = yield* now;
          const snapshotFilename = `${revisionId}.${format === "markdown" ? "md" : format === "html" ? "html" : "txt"}`;
          const snapshotPath = path.join(snapshotRoot, snapshotFilename);
          yield* fs
            .writeFileString(snapshotPath, content, { flag: "wx" })
            .pipe(Effect.mapError(storageError));
          const answers = yield* normalizeAnswers(definition, []);
          if (existing) {
            yield* sql`UPDATE managed_documents SET title=${input.title},kind=${input.kind},current_revision_id=${revisionId},revision_number=${number},status='draft',updated_at=${createdAt} WHERE id=${documentId}`;
          } else {
            yield* sql`INSERT INTO managed_documents (id,thread_id,title,kind,current_revision_id,revision_number,status,updated_at) VALUES (${documentId},${input.threadId},${input.title},${input.kind},${revisionId},${number},'draft',${createdAt})`;
          }
          yield* sql`INSERT INTO document_revisions (id,document_id,number,format,content_hash,created_at,definition_json,snapshot_path,answers_json,answer_version) VALUES (${revisionId},${documentId},${number},${format},${hash(content)},${createdAt},${json(definition)},${snapshotFilename},${json(answers)},0)`;
          if (options.recordPublication)
            yield* options.recordPublication({
              documentId,
              revisionId,
              threadId: input.threadId,
              title: input.title,
              ...(input.step ? { step: input.step } : {}),
            });
          yield* recordHistory({
            documentId,
            revisionId,
            event: "published",
            actor,
            detail: `Published revision ${number}`,
            answerVersion: 0,
            answers,
          });
          const result = { documentId, revisionId };
          yield* saveRequest(actor, input.requestId, payloadHash, result);
          return result;
        }),
      );
      return yield* get(receipt);
    });
    const updateAnswers = Effect.fnUntraced(function* (input: DocumentsSaveDraftInput) {
      const document = yield* readDocument(input.documentId);
      if (document.current_revision_id !== input.revisionId)
        return yield* error("conflict", "A newer document revision is available.");
      if (document.status === "submitted")
        return yield* error(
          "conflict",
          "This revision was submitted and is read-only. Publish a new revision to continue.",
        );
      const revision = yield* readRevision(document.id, input.revisionId);
      if (revision.answer_version !== input.expectedAnswerVersion)
        return yield* error("conflict", "Answers changed on another device. Reload before saving.");
      const definition = yield* parse(Schema.NullOr(DocumentChecklist), revision.definition_json);
      const answers = yield* normalizeAnswers(definition, input.answers);
      const answerVersion = revision.answer_version + 1;
      yield* sql`UPDATE document_revisions SET answers_json=${json(answers)},answer_version=${answerVersion} WHERE id=${revision.id}`;
      const updatedAt = yield* now;
      yield* sql`UPDATE managed_documents SET status='draft',updated_at=${updatedAt} WHERE id=${document.id}`;
      return { document, revision, definition, answers, answerVersion };
    });
    const draftReceiptSchema = Schema.Struct({
      revisionId: Schema.String,
      answers: DocumentAnswers,
      answerVersion: Schema.Number,
    });
    const saveDraftUnlocked = Effect.fn("DocumentService.saveDraft")(function* (
      input: DocumentsSaveDraftInput,
      actor: string,
    ) {
      const payloadHash = hash(json({ operation: "saveDraft", ...input }));
      const receipt = yield* transaction(
        Effect.gen(function* () {
          const previous = yield* findRequest(actor, input.requestId, payloadHash);
          if (previous) return yield* parse(draftReceiptSchema, previous);
          const updated = yield* updateAnswers(input);
          yield* recordHistory({
            documentId: input.documentId,
            revisionId: input.revisionId,
            event: "draft-saved",
            actor,
            detail: `Saved answer version ${updated.answerVersion}`,
            answerVersion: updated.answerVersion,
            answers: updated.answers,
          });
          const result = {
            revisionId: input.revisionId,
            answers: updated.answers,
            answerVersion: updated.answerVersion,
          };
          yield* saveRequest(actor, input.requestId, payloadHash, result);
          return result;
        }),
      );
      return {
        ...(yield* get({ documentId: input.documentId, revisionId: receipt.revisionId })),
        answers: receipt.answers,
        answerVersion: receipt.answerVersion,
      };
    });
    const deliver = Effect.fn("DocumentService.deliver")(function* (
      submissionId: string,
      actor: string,
    ) {
      const row = yield* readSubmission(submissionId);
      if (row.delivery === "delivered") return yield* decodeSubmission(row);
      const document = yield* readDocument(row.document_id);
      // Receipt is persisted before dispatch. Replaying this stable command after a crash cannot create a second turn.
      const result = yield* Effect.gen(function* () {
        const thread = yield* requireThread(ThreadId.make(document.thread_id));
        return yield* options.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`document-submit-${row.id}-${row.delivery_attempt}`),
          threadId: thread.id,
          message: {
            messageId: MessageId.make(`document-submit-${row.id}`),
            role: "user",
            text: row.markdown,
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: row.created_at,
        });
      }).pipe(Effect.result);
      const delivery = result._tag === "Success" ? "delivered" : "failed";
      // Only a definitive rejection proves this command cannot have started a turn.
      // All ambiguous failures retain the same ID so an accepted receipt is replayed safely.
      const nextAttempt =
        result._tag === "Failure" &&
        (isOrchestrationCommandRejection(result.failure) || isPreviouslyRejected(result.failure))
          ? row.delivery_attempt + 1
          : row.delivery_attempt;
      const deliveryError =
        result._tag === "Success"
          ? null
          : "Answers were saved, but could not be delivered to the original thread. Retry delivery.";
      yield* transaction(
        Effect.gen(function* () {
          yield* sql`UPDATE document_submissions SET delivery=${delivery},delivery_error=${deliveryError},delivery_attempt=${nextAttempt} WHERE id=${row.id}`;
          yield* recordHistory({
            documentId: row.document_id,
            revisionId: row.revision_id,
            event: "delivery",
            actor,
            detail: delivery,
            answerVersion: row.answer_version,
          });
        }),
      );
      return yield* decodeSubmission({ ...row, delivery, delivery_error: deliveryError });
    });
    const submitUnlocked = Effect.fn("DocumentService.submit")(function* (
      input: DocumentsSaveDraftInput,
      actor: string,
    ) {
      const payloadHash = hash(json({ operation: "submit", ...input }));
      const receipt = yield* transaction(
        Effect.gen(function* () {
          const previous = yield* findRequest(actor, input.requestId, payloadHash);
          if (previous)
            return yield* parse(Schema.Struct({ submissionId: Schema.String }), previous);
          const updated = yield* updateAnswers(input);
          const revision = yield* decodeRevision(updated.revision);
          const markdown = [
            `# Document feedback: ${updated.document.title}`,
            `Document: ${input.documentId}`,
            `Revision: ${revision.number} (${revision.id})`,
            `Content SHA-256: ${revision.contentHash}`,
            `Answer version: ${updated.answerVersion}`,
            "",
            "These are explicitly submitted review answers for this document revision.",
            "",
            ...updated.answers.flatMap((answer) => {
              const title =
                updated.definition?.items.find((item) => item.id === answer.itemId)?.title ??
                answer.itemId;
              return [
                `## ${title}`,
                `Outcome: ${answer.outcome}`,
                ...(answer.notes ? ["", answer.notes] : []),
                "",
              ];
            }),
          ].join("\n");
          const id = uuid();
          const createdAt = yield* now;
          yield* sql`INSERT INTO document_submissions (id,document_id,revision_id,answer_version,answers_json,markdown,created_at,actor,delivery,delivery_error,delivery_attempt) VALUES (${id},${input.documentId},${input.revisionId},${updated.answerVersion},${json(updated.answers)},${markdown},${createdAt},${actor},'pending',NULL,0)`;
          yield* sql`UPDATE managed_documents SET status='submitted',updated_at=${createdAt} WHERE id=${input.documentId}`;
          yield* recordHistory({
            documentId: input.documentId,
            revisionId: input.revisionId,
            event: "submitted",
            actor,
            detail: `Submitted ${id}`,
            answerVersion: updated.answerVersion,
            answers: updated.answers,
          });
          yield* saveRequest(actor, input.requestId, payloadHash, { submissionId: id });
          return { submissionId: id };
        }),
      );
      return yield* deliver(receipt.submissionId, actor);
    });
    const history = Effect.fn("DocumentService.history")(function* (input: DocumentsHistoryInput) {
      yield* readDocument(input.documentId);
      const revisionRows =
        yield* sql<RevisionRow>`SELECT * FROM document_revisions WHERE document_id=${input.documentId} ORDER BY number`;
      const historyRows =
        yield* sql<HistoryRow>`SELECT * FROM document_history WHERE document_id=${input.documentId} ORDER BY rowid`;
      const submissionRows =
        yield* sql<SubmissionRow>`SELECT * FROM document_submissions WHERE document_id=${input.documentId} ORDER BY rowid`;
      const events = yield* Effect.forEach(
        historyRows,
        Effect.fnUntraced(function* (row) {
          const answers = row.answers_json ? yield* parse(DocumentAnswers, row.answers_json) : null;
          return yield* decodeHistoryValue({
            id: row.id,
            documentId: row.document_id,
            revisionId: row.revision_id,
            event: row.event,
            actor: row.actor,
            createdAt: row.created_at,
            detail: row.detail,
            answerVersion: row.answer_version,
            answers,
          }).pipe(Effect.mapError(storageError));
        }),
      );
      return {
        revisions: yield* Effect.forEach(revisionRows, decodeRevision),
        events,
        submissions: yield* Effect.forEach(submissionRows, decodeSubmission),
      };
    });
    return DocumentService.of({
      list,
      get,
      publish: (input, actor) => protect(mutex.withPermits(1)(publishUnlocked(input, actor))),
      saveDraft: (input, actor) => protect(mutex.withPermits(1)(saveDraftUnlocked(input, actor))),
      submit: (input, actor) => protect(mutex.withPermits(1)(submitUnlocked(input, actor))),
      retry: (input, actor) => protect(mutex.withPermits(1)(deliver(input.submissionId, actor))),
      history: (input) => protect(history(input)),
    });
  });
