import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
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
  IdeaArtifactId,
  DocumentFormat,
  type IdeaArtifact,
  type OpenWorkDocument,
  type OpenWorkOperationError,
  type OpenWorkPublicationStep,
  type OpenWorkStep,
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
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration-v2/SatelliteOrchestration.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration-v2/SatelliteOrchestration.ts";
import {
  OrchestratorCommandRejectedError,
  OrchestratorCommandPreviouslyRejectedError,
} from "../orchestration-v2/Orchestrator.ts";
import { makeGitReader, type WorktreeIdentity } from "../openWork/GitReader.ts";
import { WorktreeRegistry } from "./WorktreeRegistry.ts";
import { IdeaNotebookStore } from "../ideas/IdeaNotebookStore.ts";

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 20 * 1024 * 1024;
type Format = typeof DocumentFormat.Type;
const SNAPSHOT_EXTENSIONS = { html: "html", markdown: "md", text: "txt" } as const;
/** Binary media, such as images uploaded to an idea, keep their bytes and are never read as text. */
const BINARY_EXTENSION = "bin";
const FORMAT_MEDIA_TYPES = {
  html: "text/html",
  markdown: "text/markdown",
  text: "text/plain",
} as const;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const isTextMedia = (mediaType: string, name: string) =>
  mediaType.startsWith("text/") || /.(md|markdown|html?|txt|json|csv|svg)$/i.test(name);
/** The text format of a source named `name`, or null for binary media. */
const documentFormat = (mediaType: string | null, name: string): Format | null => {
  if (mediaType === "text/html" || /.html?$/i.test(name)) return "html";
  if (mediaType === "text/markdown" || /.(md|markdown)$/i.test(name)) return "markdown";
  if (mediaType === null ? /.txt$/i.test(name) : isTextMedia(mediaType, name)) return "text";
  return null;
};
const MAX_ANSWER_BYTES = 64 * 1024;
const error = (reason: DocumentOperationError["reason"], message: string) =>
  new DocumentOperationError({ reason, message });
const storageError = () => error("storage", "Could not read or save the managed document.");
const gitError = (cause: OpenWorkOperationError) =>
  error(cause.reason === "git" ? "storage" : cause.reason, cause.message);
const hashBytes = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const hash = (text: string) => hashBytes(new TextEncoder().encode(text));
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(storageError));
const decodeSummaryValue = Schema.decodeUnknownEffect(DocumentSummary);
const decodeRevisionValue = Schema.decodeUnknownEffect(DocumentRevision);
const decodeSubmissionValue = Schema.decodeUnknownEffect(DocumentSubmission);
const decodeHistoryValue = Schema.decodeUnknownEffect(DocumentHistoryEvent);
const isDocumentOperationError = Schema.is(DocumentOperationError);
const isPreviouslyRejected = Schema.is(OrchestratorCommandPreviouslyRejectedError);
const isOrchestrationCommandRejection = Schema.is(OrchestratorCommandRejectedError);

/** Where a publication appears besides its thread's Documents panel. */
type Placement =
  | { readonly kind: "thread" }
  | { readonly kind: "idea" }
  | { readonly kind: "worktree"; readonly worktree: WorktreeIdentity };

/** A publish from a file path or, for idea uploads and imports, from bytes with a media type. */
export interface IdeaDocumentInput {
  readonly threadId: ThreadId;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  /** A stable ID makes the publish idempotent, as for an imported attachment. */
  readonly id?: string;
}
export type PublishRequest = DocumentsPublishInput & {
  readonly content?: { readonly mediaType: string; readonly bytes: Uint8Array };
  /** Fixes the ID of a new document, such as an imported attachment the agent was told about. */
  readonly newDocumentId?: string;
};

interface PlacementRow {
  id: string;
  document_id: string;
  revision_id: string;
  thread_id: string;
  worktree_id: string;
  title: string;
  commit_sha: string | null;
  anchor_head: string | null;
  observed_at: string;
  favorite: number;
  unresolved: "history-diverged" | null;
}
const decodePlacement = (row: PlacementRow): OpenWorkDocument => ({
  id: row.id,
  title: row.title,
  worktreeId: row.worktree_id,
  source: {
    kind: "published",
    documentId: row.document_id,
    revisionId: row.revision_id,
    threadId: ThreadId.make(row.thread_id),
  },
  step: row.commit_sha ? { kind: "commit", commitSha: row.commit_sha } : { kind: "wip" },
  favorite: row.favorite === 1,
  available: true,
  unresolved: row.unresolved,
});
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
  media_type: string | null;
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
      input: PublishRequest,
      actor: string,
    ) => Effect.Effect<DocumentDetail, DocumentOperationError>;
    /** Publishes an upload or import into an idea and returns its notebook entry. */
    readonly publishIdeaDocument: (
      input: IdeaDocumentInput,
      actor: string,
    ) => Effect.Effect<IdeaArtifact, DocumentOperationError>;
    readonly readIdeaDocument: (input: {
      readonly threadId: ThreadId;
      readonly artifactId: IdeaArtifactId;
    }) => Effect.Effect<
      { readonly artifact: IdeaArtifact; readonly contentBase64: string },
      DocumentOperationError
    >;
    readonly remove: (
      threadId: ThreadId,
      documentId: string,
    ) => Effect.Effect<void, DocumentOperationError>;
    readonly removeThread: (threadId: ThreadId) => Effect.Effect<void, DocumentOperationError>;
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
    /** Publications placed on a worktree, after moving WIP placements onto new commits. */
    readonly worktreeDocuments: (
      worktreeId: string,
      head: string | null,
    ) => Effect.Effect<
      ReadonlyArray<OpenWorkDocument & { readonly observedAt: string }>,
      DocumentOperationError
    >;
    readonly assignPlacement: (
      id: string,
      step: OpenWorkStep,
    ) => Effect.Effect<OpenWorkDocument, DocumentOperationError>;
    readonly favoritePlacement: (
      id: string,
      favorite: boolean,
    ) => Effect.Effect<OpenWorkDocument, DocumentOperationError>;
    readonly favoritePlacements: () => Effect.Effect<
      ReadonlyArray<OpenWorkDocument>,
      DocumentOperationError
    >;
  }
>()("t3/documents/DocumentService") {
  static readonly layer = Layer.suspend(() =>
    Layer.effect(
      DocumentService,
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const engine = yield* OrchestrationEngineService;
        const projection = yield* ProjectionSnapshotQuery;
        return yield* makeDocumentService({
          stateDir: config.stateDir,
          dispatch: engine.dispatch,
          projection,
          ideas: yield* IdeaNotebookStore,
        });
      }),
    ),
  );
}

export const makeDocumentService = (options: {
  readonly stateDir: string;
  readonly dispatch: OrchestrationEngineShape["dispatch"];
  readonly projection: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getProjectShellById"
  >;
  readonly ideas: Pick<IdeaNotebookStore["Service"], "requireActive">;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* makeGitReader;
    const worktrees = yield* WorktreeRegistry;
    const mutex = yield* Semaphore.make(1);
    const snapshotRoot = path.join(options.stateDir, "documents");
    // Ideas stored artifacts here before they used this module. Those bytes stay in place.
    const legacyIdeaPath = (threadId: ThreadId, documentId: string) =>
      path.join(
        options.stateDir,
        "ideas",
        Buffer.from(threadId).toString("base64url"),
        "documents",
        encodeURIComponent(documentId),
      );
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
      const thread = yield* options.projection
        .getThreadShellById(threadId)
        .pipe(Effect.mapError(storageError));
      if (Option.isNone(thread))
        return yield* error("not-found", "The original thread is unavailable.");
      return thread.value;
    });
    const requireIdea = (threadId: ThreadId) =>
      options.ideas
        .requireActive(threadId)
        .pipe(Effect.mapError(() => error("not-found", "The idea is unavailable.")));
    const resolvePlacement = Effect.fnUntraced(function* (
      thread: Effect.Success<ReturnType<typeof requireThread>>,
      step: OpenWorkPublicationStep | undefined,
    ) {
      if (thread.purpose === "idea") {
        if (step) return yield* error("invalid", "Ideas have no worktree steps.");
        yield* requireIdea(thread.id);
        return { kind: "idea" } satisfies Placement;
      }
      const project = yield* options.projection
        .getProjectShellById(thread.projectId)
        .pipe(Effect.mapError(storageError));
      if (Option.isNone(project))
        return yield* error("not-found", "The thread's project is unavailable.");
      const worktree = yield* git
        .findIdentity(thread.worktreePath ?? project.value.workspaceRoot)
        .pipe(Effect.mapError(gitError));
      if (worktree) return { kind: "worktree", worktree } satisfies Placement;
      if (step) return yield* error("invalid", "Choosing a step requires a Git worktree.");
      return { kind: "thread" } satisfies Placement;
    });
    const place = Effect.fnUntraced(function* (
      placement: Placement,
      publication: {
        readonly documentId: string;
        readonly revisionId: string;
        readonly threadId: ThreadId;
        readonly title: string;
        readonly step: OpenWorkPublicationStep | undefined;
      },
    ) {
      if (placement.kind !== "worktree") return;
      const { worktree } = placement;
      yield* worktrees.record(worktree).pipe(Effect.mapError(gitError));
      const state = yield* git.state(worktree.path).pipe(Effect.mapError(gitError));
      yield* reconcilePlacements(worktree.id, state.head);
      const sha =
        publication.step?.kind === "commit"
          ? yield* git
              .validateCommit(worktree.path, publication.step.commitSha)
              .pipe(Effect.mapError(gitError))
          : null;
      yield* sql`INSERT INTO document_placements (id,document_id,revision_id,thread_id,worktree_id,title,commit_sha,anchor_head,observed_at)
        VALUES (${`publication:${publication.revisionId}`},${publication.documentId},${publication.revisionId},${publication.threadId},${worktree.id},${publication.title},${sha},${state.head},${yield* now})`;
    });
    /** A WIP placement follows the first commit made after it was placed. */
    const reconcilePlacements = Effect.fnUntraced(function* (
      worktreeId: string,
      head: string | null,
    ) {
      const pending =
        yield* sql<PlacementRow>`SELECT * FROM document_placements WHERE worktree_id=${worktreeId} AND commit_sha IS NULL`;
      const commitAfter = git.commitAfter(worktreeId, head);
      for (const row of pending) {
        const next = yield* commitAfter(row.anchor_head).pipe(Effect.mapError(gitError));
        yield* next.sha
          ? sql`UPDATE document_placements SET commit_sha=${next.sha},unresolved=NULL WHERE id=${row.id}`
          : sql`UPDATE document_placements SET unresolved=${next.diverged ? "history-diverged" : null} WHERE id=${row.id}`;
      }
    });
    const readPlacement = Effect.fnUntraced(function* (id: string) {
      const rows = yield* sql<PlacementRow>`SELECT * FROM document_placements WHERE id=${id}`;
      if (!rows[0]) return yield* error("not-found", "Document link is unavailable.");
      return rows[0];
    });
    const worktreeDocuments = Effect.fn("DocumentService.worktreeDocuments")(function* (
      worktreeId: string,
      head: string | null,
    ) {
      yield* sql.withTransaction(reconcilePlacements(worktreeId, head));
      const rows =
        yield* sql<PlacementRow>`SELECT * FROM document_placements WHERE worktree_id=${worktreeId} ORDER BY observed_at,rowid`;
      return rows.map((row) => ({ ...decodePlacement(row), observedAt: row.observed_at }));
    });
    const assignPlacement = Effect.fn("DocumentService.assignPlacement")(function* (
      id: string,
      step: OpenWorkStep,
    ) {
      if (step.kind === "unassigned")
        return yield* error("invalid", "Published documents belong to WIP or a saved commit.");
      const row = yield* readPlacement(id);
      const worktree = yield* worktrees.require(row.worktree_id).pipe(Effect.mapError(gitError));
      const state = yield* git.state(worktree.path).pipe(Effect.mapError(gitError));
      const sha =
        step.kind === "commit"
          ? yield* git.validateCommit(worktree.path, step.commitSha).pipe(Effect.mapError(gitError))
          : null;
      yield* sql`UPDATE document_placements SET commit_sha=${sha},anchor_head=${state.head},unresolved=NULL WHERE id=${id}`;
      return decodePlacement(yield* readPlacement(id));
    });
    const favoritePlacement = Effect.fn("DocumentService.favoritePlacement")(function* (
      id: string,
      favorite: boolean,
    ) {
      yield* readPlacement(id);
      yield* sql`UPDATE document_placements SET favorite=${favorite ? 1 : 0} WHERE id=${id}`;
      return decodePlacement(yield* readPlacement(id));
    });
    const favoritePlacements = Effect.fn("DocumentService.favoritePlacements")(function* () {
      const rows = yield* sql<PlacementRow>`SELECT * FROM document_placements WHERE favorite=1`;
      return rows.map(decodePlacement);
    });
    const snapshotName = (revision: RevisionRow) => {
      // Legacy snapshots stored absolute host paths. Resolve their basename below
      // the current home so restored data never reads from the previous location.
      const filename = revision.snapshot_path.split(/[\\/]/).at(-1) ?? "";
      return /^[a-f0-9-]{36}\.(?:html|md|txt|bin)$/.test(filename)
        ? Effect.succeed(filename)
        : Effect.fail(storageError());
    };
    const get = Effect.fn("DocumentService.get")(function* (
      input: DocumentsGetInput,
    ): Effect.fn.Return<DocumentDetail, DocumentOperationError> {
      const row = yield* readDocument(input.documentId);
      const revisionRow = yield* readRevision(row.id, input.revisionId ?? row.current_revision_id);
      const document = yield* decodeSummary(row);
      const revision = yield* decodeRevision(revisionRow);
      const answers = yield* parse(DocumentAnswers, revisionRow.answers_json);
      const snapshotFilename = yield* snapshotName(revisionRow);
      if (snapshotFilename.endsWith(`.${BINARY_EXTENSION}`))
        return yield* error(
          "invalid",
          "This document is binary media and cannot be read as text. Use idea_read_image for PNG, JPEG, GIF or WebP images.",
        );
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
      VALUES (${yield* randomUuidV4},${input.documentId},${input.revisionId},${input.event},${input.actor},${createdAt},${input.detail},${input.answerVersion ?? null},${input.answers ? json(input.answers) : null})`;
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
    const readSource = Effect.fnUntraced(function* (input: PublishRequest) {
      if (input.content) return { name: input.title, ...input.content };
      if (!input.path || !path.isAbsolute(input.path))
        return yield* error("invalid", "Publish requires an absolute host file path.");
      const stat = yield* fs.stat(input.path).pipe(Effect.mapError(storageError));
      if (stat.type !== "File" || Number(stat.size) > MAX_SNAPSHOT_BYTES)
        return yield* error("invalid", "Document must be a regular file smaller than 2 MB.");
      const chunks = yield* fs
        .stream(input.path, { bytesToRead: MAX_SNAPSHOT_BYTES + 1 })
        .pipe(Stream.runCollect, Effect.mapError(storageError));
      return { name: input.path, mediaType: null, bytes: Buffer.concat(chunks) };
    });
    /** Validated snapshot content: text in one of the document formats, or binary media. */
    const readSnapshot = Effect.fnUntraced(function* (input: PublishRequest) {
      const source = yield* readSource(input);
      const format = documentFormat(source.mediaType, source.name);
      if (!format) {
        if (!source.mediaType)
          return yield* error(
            "invalid",
            "Only self-contained HTML, Markdown, and text documents are supported.",
          );
        if (source.bytes.byteLength > MAX_BINARY_BYTES)
          return yield* error("invalid", "Documents must be 20 MB or smaller.");
        return { format: null, mediaType: source.mediaType, bytes: source.bytes } as const;
      }
      if (source.bytes.byteLength > MAX_SNAPSHOT_BYTES)
        return yield* error("invalid", "Document exceeds the 2 MB limit.");
      const content = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(source.bytes),
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
        return yield* error("invalid", "HTML snapshots must inline their scripts and resources.");
      return { format, mediaType: source.mediaType ?? FORMAT_MEDIA_TYPES[format], content };
    });
    const publishUnlocked = Effect.fn("DocumentService.publish")(function* (
      input: PublishRequest,
      actor: string,
    ) {
      const payloadHash = hash(
        json({
          operation: "publish",
          ...input,
          content: input.content && {
            mediaType: input.content.mediaType,
            hash: hashBytes(input.content.bytes),
          },
        }),
      );
      const receipt = yield* transaction(
        Effect.gen(function* () {
          const previous = yield* findRequest(actor, input.requestId, payloadHash);
          if (previous)
            return {
              ...(yield* parse(
                Schema.Struct({ documentId: Schema.String, revisionId: Schema.String }),
                previous,
              )),
              replayed: true,
            };
          const thread = yield* requireThread(input.threadId);
          const placement = yield* resolvePlacement(thread, input.step);
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
          const snapshot = yield* readSnapshot(input);
          const definition = input.definition ?? null;
          if (
            definition &&
            new Set(definition.items.map((item) => item.id)).size !== definition.items.length
          )
            return yield* error("invalid", "Checklist item IDs must be unique.");
          const documentId = existing?.id ?? input.newDocumentId ?? (yield* randomUuidV4);
          const revisionId = yield* randomUuidV4;
          const number = (existing?.revision_number ?? 0) + 1;
          const createdAt = yield* now;
          const snapshotFilename = `${revisionId}.${snapshot.format ? SNAPSHOT_EXTENSIONS[snapshot.format] : BINARY_EXTENSION}`;
          const snapshotPath = path.join(snapshotRoot, snapshotFilename);
          yield* (
            snapshot.format
              ? fs.writeFileString(snapshotPath, snapshot.content, { flag: "wx" })
              : fs.writeFile(snapshotPath, snapshot.bytes, { flag: "wx" })
          ).pipe(Effect.mapError(storageError));
          const answers = yield* normalizeAnswers(definition, []);
          if (existing) {
            yield* sql`UPDATE managed_documents SET title=${input.title},kind=${input.kind},current_revision_id=${revisionId},revision_number=${number},status='draft',updated_at=${createdAt} WHERE id=${documentId}`;
          } else {
            yield* sql`INSERT INTO managed_documents (id,thread_id,title,kind,current_revision_id,revision_number,status,updated_at) VALUES (${documentId},${input.threadId},${input.title},${input.kind},${revisionId},${number},'draft',${createdAt})`;
          }
          yield* sql`INSERT INTO document_revisions (id,document_id,number,format,content_hash,created_at,definition_json,snapshot_path,answers_json,answer_version,media_type) VALUES (${revisionId},${documentId},${number},${snapshot.format ?? "text"},${snapshot.format ? hash(snapshot.content) : hashBytes(snapshot.bytes)},${createdAt},${json(definition)},${snapshotFilename},${json(answers)},0,${snapshot.mediaType})`;
          yield* place(placement, {
            documentId,
            revisionId,
            threadId: input.threadId,
            title: input.title,
            step: input.step,
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
          return { ...result, replayed: false };
        }),
      );
      const artifact = yield* registerOnIdea(input.threadId, receipt, actor).pipe(
        Effect.tapError(() =>
          receipt.replayed ? Effect.void : discardPublish(receipt, actor, input.requestId),
        ),
      );
      return { receipt, artifact };
    });
    /** The notebook entry for a document placed on an idea, or null outside ideas. */
    const registerOnIdea = Effect.fnUntraced(function* (
      threadId: ThreadId,
      receipt: { readonly documentId: string; readonly revisionId: string },
      actor: string,
    ) {
      const thread = yield* requireThread(threadId);
      if (thread.purpose !== "idea") return null;
      const notebook = yield* requireIdea(threadId);
      const document = yield* readDocument(receipt.documentId);
      const revision = yield* readRevision(receipt.documentId, receipt.revisionId);
      const size = yield* fs
        .stat(path.join(snapshotRoot, revision.snapshot_path))
        .pipe(Effect.mapError(storageError));
      const mediaType = revision.media_type ?? FORMAT_MEDIA_TYPES[revision.format as Format];
      const artifact: IdeaArtifact = {
        id: IdeaArtifactId.make(document.id),
        name: document.title,
        mediaType,
        sizeBytes: Number(size.size),
        textStatus: isTextMedia(mediaType, document.title)
          ? "available"
          : IMAGE_MEDIA_TYPES.has(mediaType)
            ? "image"
            : "unsupported",
        revision: revision.number,
        createdAt: revision.created_at,
        source: actor.startsWith("agent:") ? "agent" : "upload",
      };
      yield* options
        .dispatch({
          type: "idea.apply",
          commandId: CommandId.make(`document-placement-${revision.id}`),
          threadId,
          deletionEpoch: notebook.deletionEpoch,
          mutation: { kind: "artifact.register", artifact },
        })
        .pipe(
          Effect.mapError((cause) =>
            isOrchestrationCommandRejection(cause) || isPreviouslyRejected(cause)
              ? error("not-found", "The idea is unavailable. Its document was not saved.")
              : storageError(),
          ),
        );
      return artifact;
    });
    /** Undoes a fresh publish whose idea placement failed, so it never appears in one place only. */
    const discardPublish = (
      receipt: { readonly documentId: string; readonly revisionId: string },
      actor: string,
      requestId: string,
    ) =>
      transaction(
        Effect.gen(function* () {
          const revision = yield* readRevision(receipt.documentId, receipt.revisionId);
          yield* sql`DELETE FROM document_history WHERE revision_id=${revision.id}`;
          yield* sql`DELETE FROM document_revisions WHERE id=${revision.id}`;
          yield* sql`DELETE FROM document_requests WHERE actor=${actor} AND request_id=${requestId}`;
          const previous =
            yield* sql<RevisionRow>`SELECT * FROM document_revisions WHERE document_id=${receipt.documentId} ORDER BY number DESC LIMIT 1`;
          yield* previous[0]
            ? sql`UPDATE managed_documents SET current_revision_id=${previous[0].id},revision_number=${previous[0].number} WHERE id=${receipt.documentId}`
            : sql`DELETE FROM managed_documents WHERE id=${receipt.documentId}`;
          yield* fs
            .remove(path.join(snapshotRoot, revision.snapshot_path), { force: true })
            .pipe(Effect.ignore);
        }),
      ).pipe(Effect.ignore);
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
      const rejectedReceipt =
        result._tag === "Failure"
          ? yield* sql<{
              readonly status: string;
            }>`SELECT status FROM orchestration_command_receipts WHERE command_id = ${`document-submit-${row.id}-${row.delivery_attempt}`} LIMIT 1`.pipe(
              Effect.map((receipts) => receipts[0]?.status === "rejected"),
              Effect.orElseSucceed(() => false),
            )
          : false;
      const nextAttempt =
        result._tag === "Failure" &&
        (rejectedReceipt ||
          isOrchestrationCommandRejection(result.failure) ||
          isPreviouslyRejected(result.failure))
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
          const id = yield* randomUuidV4;
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
    const publishIdeaDocument = Effect.fn("DocumentService.publishIdeaDocument")(function* (
      input: IdeaDocumentInput,
      actor: string,
    ) {
      const { artifact } = yield* publishUnlocked(
        {
          requestId: input.id ?? (yield* randomUuidV4),
          threadId: input.threadId,
          title: input.name,
          kind: "document",
          content: { mediaType: input.mediaType, bytes: input.bytes },
          ...(input.id ? { newDocumentId: input.id } : {}),
        },
        actor,
      );
      if (!artifact) return yield* error("invalid", "This thread is not an idea.");
      return artifact;
    });
    /** Current bytes of an idea document, including artifacts saved before ideas used this module. */
    const readBytes = Effect.fnUntraced(function* (threadId: ThreadId, documentId: string) {
      const rows =
        yield* sql<RevisionRow>`SELECT r.* FROM managed_documents d JOIN document_revisions r ON r.id=d.current_revision_id WHERE d.id=${documentId} AND d.thread_id=${threadId}`.pipe(
          Effect.mapError(storageError),
        );
      if (rows[0]) {
        const bytes = yield* fs
          .readFile(path.join(snapshotRoot, yield* snapshotName(rows[0])))
          .pipe(Effect.mapError(storageError));
        if (hashBytes(bytes) !== rows[0].content_hash)
          return yield* error("storage", "The managed document snapshot changed.");
        return bytes;
      }
      const legacy = legacyIdeaPath(threadId, documentId);
      const real = yield* fs.realPath(legacy).pipe(Effect.orElseSucceed(() => null));
      const expected = path.join(
        yield* fs.realPath(options.stateDir).pipe(Effect.mapError(storageError)),
        path.relative(options.stateDir, legacy),
      );
      if (real !== expected) return yield* error("not-found", "This document is unavailable.");
      return yield* fs.readFile(real).pipe(Effect.mapError(storageError));
    });
    const readIdeaDocument = Effect.fn("DocumentService.readIdeaDocument")(function* (input: {
      readonly threadId: ThreadId;
      readonly artifactId: IdeaArtifactId;
    }) {
      const notebook = yield* requireIdea(input.threadId);
      const artifact = notebook.artifacts.find((entry) => entry.id === input.artifactId);
      if (!artifact) return yield* error("not-found", "This document is unavailable.");
      const bytes = yield* readBytes(input.threadId, artifact.id);
      return { artifact, contentBase64: Buffer.from(bytes).toString("base64") };
    });
    /** Removes documents with their history, placements and snapshots, plus legacy idea bytes. */
    const removeDocuments = Effect.fnUntraced(function* (
      threadId: ThreadId,
      documentId: string | null,
    ) {
      const documents =
        yield* sql<DocumentRow>`SELECT * FROM managed_documents WHERE thread_id=${threadId} AND (${documentId} IS NULL OR id=${documentId})`;
      const snapshots: string[] = [];
      yield* sql.withTransaction(
        Effect.forEach(documents, (document) =>
          Effect.gen(function* () {
            const revisions =
              yield* sql<RevisionRow>`SELECT * FROM document_revisions WHERE document_id=${document.id}`;
            snapshots.push(...revisions.map((revision) => revision.snapshot_path));
            yield* sql`DELETE FROM document_submissions WHERE document_id=${document.id}`;
            yield* sql`DELETE FROM document_history WHERE document_id=${document.id}`;
            yield* sql`DELETE FROM document_placements WHERE document_id=${document.id}`;
            yield* sql`DELETE FROM document_revisions WHERE document_id=${document.id}`;
            yield* sql`DELETE FROM managed_documents WHERE id=${document.id}`;
          }),
        ),
      );
      for (const snapshot of snapshots)
        yield* fs.remove(path.join(snapshotRoot, path.basename(snapshot)), { force: true });
      if (documentId) yield* fs.remove(legacyIdeaPath(threadId, documentId), { force: true });
    });
    return DocumentService.of({
      list,
      get,
      publish: (input, actor) =>
        protect(
          mutex.withPermits(1)(
            publishUnlocked(input, actor).pipe(Effect.flatMap(({ receipt }) => get(receipt))),
          ),
        ),
      publishIdeaDocument: (input, actor) =>
        protect(mutex.withPermits(1)(publishIdeaDocument(input, actor))),
      readIdeaDocument: (input) => protect(readIdeaDocument(input)),
      remove: (threadId, documentId) =>
        protect(mutex.withPermits(1)(removeDocuments(threadId, documentId))),
      removeThread: (threadId) => protect(mutex.withPermits(1)(removeDocuments(threadId, null))),
      saveDraft: (input, actor) => protect(mutex.withPermits(1)(saveDraftUnlocked(input, actor))),
      submit: (input, actor) => protect(mutex.withPermits(1)(submitUnlocked(input, actor))),
      retry: (input, actor) => protect(mutex.withPermits(1)(deliver(input.submissionId, actor))),
      history: (input) => protect(history(input)),
      worktreeDocuments: (worktreeId, head) => protect(worktreeDocuments(worktreeId, head)),
      assignPlacement: (id, step) => protect(assignPlacement(id, step)),
      favoritePlacement: (id, favorite) => protect(favoritePlacement(id, favorite)),
      favoritePlacements: () => protect(favoritePlacements()),
    });
  });
