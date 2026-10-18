// @effect-diagnostics nodeBuiltinImport:off - Short random ids for reviews, items and passes.
import * as NodeCrypto from "node:crypto";

import {
  ProjectId,
  RevdocError,
  RevdocEvidence,
  RevdocOutcome,
  RevdocPassKind,
  RevdocPassReport,
  RevdocPassStatus,
  RevdocResult,
  NodeId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import type { ItemState, StoredResult } from "./RevdocReconcile.ts";

export interface ReviewKey {
  readonly projectId: ProjectId;
  readonly worktreePath: string;
}

export interface ReviewRecord extends ReviewKey {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly summary: string;
  readonly context: string;
  readonly partial: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly generatedAt: string | null;
  readonly refreshedAt: string | null;
  readonly worktreeStamp: string | null;
  readonly exportError: string | null;
}

const Basis = Schema.Struct({ check: Schema.String, code: Schema.String });
const StoredResultSchema = Schema.Struct({ ...RevdocResult.fields, basis: Basis });

export const ProposedItemSchema = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  area: Schema.String,
  check: Schema.String,
  expected: Schema.String,
  coveredPaths: Schema.Array(Schema.String),
});
export const UpsertSchema = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  context: Schema.String,
  items: Schema.Array(ProposedItemSchema),
});
export type Upsert = typeof UpsertSchema.Type;

/** Saved batch and combine results let an interrupted generation pass continue. */
const Checkpoint = Schema.Struct({
  sourceDigest: Schema.String,
  conversationDigest: Schema.String,
  batchDigests: Schema.Array(Schema.String),
  batches: Schema.Array(Schema.NullOr(UpsertSchema)),
  combined: Schema.Array(Schema.NullOr(UpsertSchema)),
});
export type Checkpoint = typeof Checkpoint.Type;

const TestSection = Schema.Struct({ area: Schema.String, itemIds: Schema.Array(Schema.String) });
export type TestSection = typeof TestSection.Type;

const PassData = Schema.Struct({
  requestedByThreadId: ThreadId,
  baseRevision: Schema.Number,
  lastCommittedRevision: Schema.Number,
  model: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  report: Schema.NullOr(RevdocPassReport),
  action: Schema.optionalKey(Schema.Literals(["generate", "generate-and-test"])),
  checkpoint: Schema.optionalKey(Checkpoint),
  origin: Schema.optionalKey(Schema.Literals(["ui", "agent"])),
  parentThreadId: Schema.optionalKey(ThreadId),
  /** Selected item ids with the check fingerprint each had when the pass was dispatched. */
  selection: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  sections: Schema.optionalKey(Schema.Array(TestSection)),
  sectionIndex: Schema.optionalKey(Schema.Number),
  /** The child run working on the current section; its end advances the pass. */
  currentRunId: Schema.optionalKey(RunId),
  /** The delegated task row of the current section on the parent. */
  currentTaskId: Schema.optionalKey(NodeId),
  recordedIds: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Screenshots captured per item, attached when the agent records the item's result. */
  evidence: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(RevdocEvidence))),
});
export type PassData = typeof PassData.Type;

export interface PassRecord extends ReviewKey {
  readonly id: string;
  readonly kind: RevdocPassKind;
  readonly status: RevdocPassStatus;
  readonly childThreadId: ThreadId | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly data: PassData;
}

export interface CommitChange {
  readonly header?: Partial<
    Pick<
      ReviewRecord,
      "title" | "summary" | "context" | "partial" | "generatedAt" | "refreshedAt" | "worktreeStamp"
    >
  >;
  readonly items?: ReadonlyArray<ItemState>;
  readonly removed?: ReadonlyArray<string>;
}

export interface Committed {
  readonly review: ReviewRecord;
  readonly items: ReadonlyArray<ItemState>;
  readonly removed: ReadonlyArray<string>;
}

export const newRevdocId = (prefix: string) =>
  `${prefix}-${NodeCrypto.randomBytes(6).toString("hex")}`;

export const revdocNow = Effect.map(DateTime.now, DateTime.formatIso);

const storageError = (cause: unknown) =>
  Effect.logWarning("Revdoc storage failed", { cause }).pipe(
    Effect.andThen(
      Effect.fail(
        new RevdocError({ code: "storage", message: "Revdoc could not read or write its data." }),
      ),
    ),
  );

class CallerFailure<E> {
  readonly error: E;
  constructor(error: E) {
    this.error = error;
  }
}

const conflictAt = (revision: number) =>
  new RevdocError({
    code: "conflict",
    message: "The review changed while this pass ran. Run it again.",
    currentRevision: revision,
  });

export class RevdocStore extends Context.Service<
  RevdocStore,
  {
    readonly getReview: (key: ReviewKey) => Effect.Effect<Option.Option<ReviewRecord>, RevdocError>;
    readonly listReviews: (
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ReviewRecord>, RevdocError>;
    readonly listItems: (reviewId: string) => Effect.Effect<ReadonlyArray<ItemState>, RevdocError>;
    readonly getItems: (
      reviewId: string,
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<ItemState>, RevdocError>;
    /**
     * One transaction: checks the Review is still at `expectedRevision` (null skips the check for
     * item-scoped writes), applies the change, bumps the Review revision and returns the delta.
     * A change on a worktree with no Review creates it at revision 1. Returns none for no change.
     */
    readonly commit: <E, R>(
      key: ReviewKey,
      expectedRevision: number | null,
      apply: (review: ReviewRecord | null) => Effect.Effect<CommitChange | null, E, R>,
    ) => Effect.Effect<Option.Option<Committed>, E | RevdocError, R>;
    readonly setExportError: (
      reviewId: string,
      exportError: string | null,
    ) => Effect.Effect<void, RevdocError>;
    /** Records a refresh that changed nothing, without a revision. */
    readonly setWorktreeStamp: (
      reviewId: string,
      worktreeStamp: string,
      refreshedAt: string,
    ) => Effect.Effect<void, RevdocError>;
    /** Deletes the Review, its items and its passes. */
    readonly deleteReview: (key: ReviewKey) => Effect.Effect<void, RevdocError>;
    readonly listPasses: (key: ReviewKey) => Effect.Effect<ReadonlyArray<PassRecord>, RevdocError>;
    readonly getPass: (id: string) => Effect.Effect<Option.Option<PassRecord>, RevdocError>;
    readonly runningPasses: Effect.Effect<ReadonlyArray<PassRecord>, RevdocError>;
    /**
     * Testing children are remembered apart from their passes, which are pruned, so a child can
     * never start Revdoc passes. Rows go when the worktree is forgotten.
     */
    readonly addTestingThread: (
      key: ReviewKey,
      threadId: ThreadId,
    ) => Effect.Effect<void, RevdocError>;
    readonly isTestingThread: (threadId: ThreadId) => Effect.Effect<boolean, RevdocError>;
    readonly forgetTestingThreads: (
      match: { readonly worktreePath: string } | { readonly projectId: ProjectId },
    ) => Effect.Effect<void, RevdocError>;
    /** Inserts a running pass unless the worktree already has one, which it returns instead. */
    readonly startPass: (pass: PassRecord) => Effect.Effect<Option.Option<PassRecord>, RevdocError>;
    readonly putPass: (pass: PassRecord) => Effect.Effect<void, RevdocError>;
    readonly deletePasses: (ids: ReadonlyArray<string>) => Effect.Effect<void, RevdocError>;
    readonly transaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | RevdocError, R>;
  }
>()("t3/revdoc/RevdocStore") {}

interface ReviewRow {
  readonly id: string;
  readonly project_id: string;
  readonly worktree_path: string;
  readonly revision: number;
  readonly title: string;
  readonly summary: string;
  readonly context: string;
  readonly partial: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly generated_at: string | null;
  readonly refreshed_at: string | null;
  readonly worktree_stamp: string | null;
  readonly export_error: string | null;
}

interface ItemRow {
  readonly id: string;
  readonly revision: number;
  readonly position: number;
  readonly area: string;
  readonly check_text: string;
  readonly expected: string;
  readonly covered_paths_json: string;
  readonly check_fingerprint: string;
  readonly code_fingerprint: string;
  readonly outcome: string;
  readonly outcome_basis_json: string | null;
  readonly note: string;
  readonly stale_pass_id: string | null;
  readonly dismissed: number;
  readonly result_json: string | null;
}

interface PassRow {
  readonly id: string;
  readonly project_id: string;
  readonly worktree_path: string;
  readonly kind: string;
  readonly status: string;
  readonly child_thread_id: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly data_json: string;
}

const decodePaths = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeBasis = Schema.decodeUnknownSync(Schema.fromJsonString(Basis));
const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(StoredResultSchema));
const decodeOutcome = Schema.decodeUnknownSync(RevdocOutcome);
const decodePassData = Schema.decodeUnknownSync(Schema.fromJsonString(PassData));
const encodePassData = Schema.encodeSync(Schema.fromJsonString(PassData));
const decodePassKind = Schema.decodeUnknownSync(RevdocPassKind);
const decodePassStatus = Schema.decodeUnknownSync(RevdocPassStatus);

const toReview = (row: ReviewRow): ReviewRecord => ({
  id: row.id,
  projectId: ProjectId.make(row.project_id),
  worktreePath: row.worktree_path,
  revision: row.revision,
  title: row.title,
  summary: row.summary,
  context: row.context,
  partial: row.partial === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  generatedAt: row.generated_at,
  refreshedAt: row.refreshed_at,
  worktreeStamp: row.worktree_stamp,
  exportError: row.export_error,
});

const toItem = (row: ItemRow): ItemState => ({
  id: row.id,
  revision: row.revision,
  position: row.position,
  area: row.area,
  check: row.check_text,
  expected: row.expected,
  coveredPaths: decodePaths(row.covered_paths_json),
  checkFingerprint: row.check_fingerprint,
  codeFingerprint: row.code_fingerprint,
  outcome: decodeOutcome(row.outcome),
  outcomeBasis: row.outcome_basis_json === null ? null : decodeBasis(row.outcome_basis_json),
  note: row.note,
  stalePassId: row.stale_pass_id,
  dismissed: row.dismissed === 1,
  result: row.result_json === null ? null : (decodeResult(row.result_json) as StoredResult),
});

const toPass = (row: PassRow): PassRecord => ({
  id: row.id,
  projectId: ProjectId.make(row.project_id),
  worktreePath: row.worktree_path,
  kind: decodePassKind(row.kind),
  status: decodePassStatus(row.status),
  childThreadId: row.child_thread_id === null ? null : ThreadId.make(row.child_thread_id),
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  data: decodePassData(row.data_json),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const guard = <A, R>(effect: Effect.Effect<A, SqlError.SqlError, R>) =>
    effect.pipe(Effect.catch(storageError));

  const getReview = (key: ReviewKey) =>
    guard(
      sql<ReviewRow>`
        SELECT * FROM revdoc_reviews
        WHERE project_id = ${key.projectId} AND worktree_path = ${key.worktreePath}
      `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toReview)))),
    );

  const writeItems = (reviewId: string, items: ReadonlyArray<ItemState>) =>
    Effect.forEach(
      items,
      (item) => sql`
        INSERT INTO revdoc_items (review_id, id, revision, position, area, check_text, expected,
          covered_paths_json, check_fingerprint, code_fingerprint, outcome, outcome_basis_json,
          note, stale_pass_id, dismissed, result_json)
        VALUES (${reviewId}, ${item.id}, ${item.revision}, ${item.position}, ${item.area},
          ${item.check}, ${item.expected}, ${JSON.stringify(item.coveredPaths)},
          ${item.checkFingerprint}, ${item.codeFingerprint}, ${item.outcome},
          ${item.outcomeBasis === null ? null : JSON.stringify(item.outcomeBasis)}, ${item.note},
          ${item.stalePassId}, ${item.dismissed ? 1 : 0},
          ${item.result === null ? null : JSON.stringify(item.result)})
        ON CONFLICT (review_id, id) DO UPDATE SET
          revision = excluded.revision, position = excluded.position, area = excluded.area,
          check_text = excluded.check_text, expected = excluded.expected,
          covered_paths_json = excluded.covered_paths_json,
          check_fingerprint = excluded.check_fingerprint,
          code_fingerprint = excluded.code_fingerprint, outcome = excluded.outcome,
          outcome_basis_json = excluded.outcome_basis_json, note = excluded.note,
          stale_pass_id = excluded.stale_pass_id, dismissed = excluded.dismissed,
          result_json = excluded.result_json
      `,
      { discard: true },
    );

  const writeReview = (review: ReviewRecord) => sql`
    INSERT INTO revdoc_reviews (id, project_id, worktree_path, revision, title, summary, context,
      partial, created_at, updated_at, generated_at, refreshed_at, worktree_stamp, export_error)
    VALUES (${review.id}, ${review.projectId}, ${review.worktreePath}, ${review.revision},
      ${review.title}, ${review.summary}, ${review.context}, ${review.partial ? 1 : 0},
      ${review.createdAt}, ${review.updatedAt}, ${review.generatedAt}, ${review.refreshedAt},
      ${review.worktreeStamp}, ${review.exportError})
    ON CONFLICT (id) DO UPDATE SET
      revision = excluded.revision, title = excluded.title, summary = excluded.summary,
      context = excluded.context, partial = excluded.partial, updated_at = excluded.updated_at,
      generated_at = excluded.generated_at, refreshed_at = excluded.refreshed_at,
      worktree_stamp = excluded.worktree_stamp
  `;

  const putPass = (pass: PassRecord) =>
    guard(sql`
      INSERT INTO revdoc_passes (id, project_id, worktree_path, kind, status, child_thread_id,
        started_at, finished_at, data_json)
      VALUES (${pass.id}, ${pass.projectId}, ${pass.worktreePath}, ${pass.kind}, ${pass.status},
        ${pass.childThreadId}, ${pass.startedAt}, ${pass.finishedAt}, ${encodePassData(pass.data)})
      ON CONFLICT (id) DO UPDATE SET
        status = excluded.status, child_thread_id = excluded.child_thread_id,
        finished_at = excluded.finished_at, data_json = excluded.data_json
    `).pipe(Effect.asVoid);

  /** Rolls back on any failure; the caller's own errors come back unwrapped. */
  const transaction = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, Exclude<E, SqlError.SqlError> | RevdocError, R> =>
    sql
      .withTransaction(Effect.mapError(effect, (error) => new CallerFailure(error)))
      .pipe(
        Effect.catch(
          (
            cause: CallerFailure<E> | SqlError.SqlError,
          ): Effect.Effect<never, Exclude<E, SqlError.SqlError> | RevdocError> =>
            cause instanceof CallerFailure && !SqlError.isSqlError(cause.error)
              ? Effect.fail(cause.error as Exclude<E, SqlError.SqlError>)
              : storageError(cause instanceof CallerFailure ? cause.error : cause),
        ),
      );

  const listPasses = (key: ReviewKey) =>
    guard(
      sql<PassRow>`
        SELECT * FROM revdoc_passes
        WHERE project_id = ${key.projectId} AND worktree_path = ${key.worktreePath}
        ORDER BY started_at DESC
      `.pipe(Effect.map((rows) => rows.map(toPass))),
    );

  return RevdocStore.of({
    getReview,
    listReviews: (projectId) =>
      guard(
        (projectId === undefined
          ? sql<ReviewRow>`SELECT * FROM revdoc_reviews`
          : sql<ReviewRow>`SELECT * FROM revdoc_reviews WHERE project_id = ${projectId}`
        ).pipe(Effect.map((rows) => rows.map(toReview))),
      ),
    listItems: (reviewId) =>
      guard(
        sql<ItemRow>`
          SELECT * FROM revdoc_items WHERE review_id = ${reviewId} ORDER BY position
        `.pipe(Effect.map((rows) => rows.map(toItem))),
      ),
    getItems: (reviewId, ids) =>
      ids.length === 0
        ? Effect.succeed([])
        : guard(
            sql<ItemRow>`
              SELECT * FROM revdoc_items
              WHERE review_id = ${reviewId} AND ${sql.in("id", ids)}
              ORDER BY position
            `.pipe(Effect.map((rows) => rows.map(toItem))),
          ),
    commit: (key, expectedRevision, apply) =>
      transaction(
        Effect.gen(function* () {
          const current = Option.getOrNull(yield* getReview(key));
          if (expectedRevision !== null && (current?.revision ?? 0) !== expectedRevision) {
            return yield* conflictAt(current?.revision ?? 0);
          }
          const change = yield* apply(current);
          if (change === null) return Option.none<Committed>();
          const now = yield* revdocNow;
          const review: ReviewRecord = {
            ...(current ?? {
              ...key,
              id: newRevdocId("review"),
              revision: 0,
              title: "Review",
              summary: "",
              context: "",
              partial: false,
              createdAt: now,
              generatedAt: null,
              refreshedAt: null,
              worktreeStamp: null,
              exportError: null,
            }),
            ...change.header,
            revision: (current?.revision ?? 0) + 1,
            updatedAt: now,
          };
          yield* writeReview(review);
          const items = change.items ?? [];
          yield* writeItems(review.id, items);
          const removed = change.removed ?? [];
          if (removed.length > 0) {
            yield* sql`
              DELETE FROM revdoc_items WHERE review_id = ${review.id} AND ${sql.in("id", removed)}
            `;
          }
          return Option.some({ review, items, removed });
        }),
      ),
    setExportError: (reviewId, exportError) =>
      guard(
        sql`UPDATE revdoc_reviews SET export_error = ${exportError} WHERE id = ${reviewId}`,
      ).pipe(Effect.asVoid),
    setWorktreeStamp: (reviewId, worktreeStamp, refreshedAt) =>
      guard(
        sql`
          UPDATE revdoc_reviews SET worktree_stamp = ${worktreeStamp}, refreshed_at = ${refreshedAt}
          WHERE id = ${reviewId}
        `,
      ).pipe(Effect.asVoid),
    deleteReview: (key) =>
      transaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM revdoc_items WHERE review_id IN (
              SELECT id FROM revdoc_reviews
              WHERE project_id = ${key.projectId} AND worktree_path = ${key.worktreePath}
            )
          `;
          yield* sql`
            DELETE FROM revdoc_reviews
            WHERE project_id = ${key.projectId} AND worktree_path = ${key.worktreePath}
          `;
          yield* sql`
            DELETE FROM revdoc_passes
            WHERE project_id = ${key.projectId} AND worktree_path = ${key.worktreePath}
          `;
        }),
      ),
    listPasses,
    getPass: (id) =>
      guard(
        sql<PassRow>`SELECT * FROM revdoc_passes WHERE id = ${id}`.pipe(
          Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toPass))),
        ),
      ),
    runningPasses: guard(
      sql<PassRow>`SELECT * FROM revdoc_passes WHERE status = 'running'`.pipe(
        Effect.map((rows) => rows.map(toPass)),
      ),
    ),
    addTestingThread: (key, threadId) =>
      guard(sql`
        INSERT INTO revdoc_testing_threads (thread_id, project_id, worktree_path)
        VALUES (${threadId}, ${key.projectId}, ${key.worktreePath})
        ON CONFLICT (thread_id) DO NOTHING
      `).pipe(Effect.asVoid),
    isTestingThread: (threadId) =>
      guard(
        sql`SELECT 1 FROM revdoc_testing_threads WHERE thread_id = ${threadId}`.pipe(
          Effect.map((rows) => rows.length > 0),
        ),
      ),
    forgetTestingThreads: (match) =>
      guard(
        "worktreePath" in match
          ? sql`DELETE FROM revdoc_testing_threads WHERE worktree_path = ${match.worktreePath}`
          : sql`DELETE FROM revdoc_testing_threads WHERE project_id = ${match.projectId}`,
      ).pipe(Effect.asVoid),
    startPass: (pass) =>
      transaction(
        Effect.gen(function* () {
          const running = (yield* listPasses(pass)).find((other) => other.status === "running");
          if (running) return Option.some(running);
          yield* putPass(pass);
          return Option.none<PassRecord>();
        }),
      ),
    putPass,
    deletePasses: (ids) =>
      ids.length === 0
        ? Effect.void
        : guard(sql`DELETE FROM revdoc_passes WHERE ${sql.in("id", ids)}`).pipe(Effect.asVoid),
    transaction,
  });
});

export const layer = Layer.effect(RevdocStore, make);
