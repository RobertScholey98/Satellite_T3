import {
  IdeaNotebook,
  IdeaSummary,
  type OrchestrationEvent,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { applyIdeaMutation, createIdeaNotebook } from "./IdeaNotebook.ts";

const decodeNotebook = Schema.decodeEffect(Schema.fromJsonString(IdeaNotebook));
const encodeNotebook = Schema.encodeEffect(Schema.fromJsonString(IdeaNotebook));
const decodeSummaries = Schema.decodeUnknownEffect(Schema.Array(IdeaSummary));

export class IdeaStoreError extends Schema.TaggedError<IdeaStoreError>()("IdeaStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
export class IdeaNotebookStore extends Context.Service<
  IdeaNotebookStore,
  {
    get: (threadId: ThreadId) => Effect.Effect<IdeaNotebook | null, IdeaStoreError>;
    requireActive: (threadId: ThreadId) => Effect.Effect<IdeaNotebook, IdeaStoreError>;
    list: (projectId?: ProjectId) => Effect.Effect<readonly IdeaSummary[], IdeaStoreError>;
    pending: () => Effect.Effect<readonly IdeaNotebook[], IdeaStoreError>;
    isDeleted: (threadId: ThreadId) => Effect.Effect<boolean, IdeaStoreError>;
    project: (event: OrchestrationEvent) => Effect.Effect<void, IdeaStoreError>;
  }
>()("t3/ideas/IdeaNotebookStore") {
  static readonly layer = Layer.effect(
    IdeaNotebookStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const failure = (cause: unknown) =>
        new IdeaStoreError({ message: "Could not read or save the idea notebook.", cause });
      const get = Effect.fn("IdeaNotebookStore.get")(function* (threadId: ThreadId) {
        const rows = yield* sql<{
          notebookJson: string;
        }>`SELECT notebook_json AS "notebookJson" FROM projection_idea_notebooks WHERE thread_id = ${threadId}`;
        return rows[0] ? yield* decodeNotebook(rows[0].notebookJson) : null;
      }, Effect.mapError(failure));
      const isDeleted = Effect.fn("IdeaNotebookStore.isDeleted")(function* (threadId: ThreadId) {
        const rows =
          yield* sql`SELECT thread_id FROM idea_deletion_markers WHERE thread_id = ${threadId}`;
        return rows.length > 0;
      }, Effect.mapError(failure));
      const requireActive = Effect.fn("IdeaNotebookStore.requireActive")(function* (
        threadId: ThreadId,
      ) {
        if (yield* isDeleted(threadId))
          return yield* new IdeaStoreError({
            message: "This idea is being deleted or has been permanently deleted.",
          });
        const notebook = yield* get(threadId);
        if (!notebook || notebook.status === "deleting")
          return yield* new IdeaStoreError({ message: "This idea is not available." });
        return notebook;
      });
      const list = Effect.fn("IdeaNotebookStore.list")(function* (projectId?: ProjectId) {
        const rows = yield* sql`
        SELECT n.thread_id AS "threadId", t.project_id AS "projectId", t.title, n.status,
          n.updated_at AS "updatedAt", n.revision, n.excerpt, n.update_status AS "updateStatus", n.deletion_error AS "deletionError"
        FROM projection_idea_notebooks n JOIN projection_threads t ON t.thread_id = n.thread_id
        WHERE ${projectId === undefined ? sql`1 = 1` : sql`t.project_id = ${projectId}`}
        ORDER BY n.updated_at DESC`;
        return yield* decodeSummaries(rows);
      }, Effect.mapError(failure));
      const pending = Effect.fn("IdeaNotebookStore.pending")(function* () {
        const rows = yield* sql<{
          notebookJson: string;
        }>`SELECT notebook_json AS "notebookJson" FROM projection_idea_notebooks WHERE update_status IN ('pending', 'running', 'waiting') OR status = 'deleting'`;
        return yield* Effect.forEach(rows, (row) => decodeNotebook(row.notebookJson));
      }, Effect.mapError(failure));
      const save = Effect.fn("IdeaNotebookStore.save")(function* (notebook: IdeaNotebook) {
        const encoded = yield* encodeNotebook(notebook);
        yield* sql`INSERT INTO projection_idea_notebooks (thread_id, revision, status, updated_at, excerpt, update_status, deletion_error, notebook_json)
        VALUES (${notebook.threadId}, ${notebook.revision}, ${notebook.status}, ${notebook.updatedAt}, ${notebook.pitch.markdown.slice(0, 240)}, ${notebook.update.status}, ${notebook.deletionError}, ${encoded})
        ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision, status = excluded.status, updated_at = excluded.updated_at,
          excerpt = excluded.excerpt, update_status = excluded.update_status, deletion_error = excluded.deletion_error, notebook_json = excluded.notebook_json`;
        yield* sql`UPDATE projection_threads SET settled_at = CASE WHEN ${notebook.status} = 'settled' THEN COALESCE(settled_at, ${notebook.updatedAt}) ELSE NULL END,
        settled_override = ${notebook.status === "settled" ? "settled" : null}, updated_at = ${notebook.updatedAt}
        WHERE thread_id = ${notebook.threadId}`;
      });
      const project = Effect.fn("IdeaNotebookStore.project")(function* (event: OrchestrationEvent) {
        if (event.type === "thread.created" && event.payload.purpose === "idea") {
          const purged =
            yield* sql`SELECT thread_id FROM idea_deletion_markers WHERE thread_id = ${event.payload.threadId} AND completed_at IS NOT NULL`;
          if (!purged.length)
            yield* save(createIdeaNotebook(event.payload.threadId, event.occurredAt));
          return;
        }
        if (
          event.aggregateKind !== "thread" ||
          !(
            event.type === "idea.changed" ||
            event.type === "idea.purged" ||
            event.type === "thread.user-input-response-requested" ||
            (event.type === "thread.message-sent" && event.payload.role === "user") ||
            (event.type === "thread.session-set" && event.payload.turnSettled)
          )
        )
          return;
        if (event.type === "idea.purged") {
          yield* sql`DELETE FROM projection_idea_notebooks WHERE thread_id = ${event.payload.threadId}`;
          yield* sql`INSERT INTO idea_deletion_markers(thread_id, epoch, requested_at, completed_at)
          VALUES (${event.payload.threadId}, ${event.payload.deletionEpoch}, ${event.occurredAt}, ${event.occurredAt})
          ON CONFLICT(thread_id) DO UPDATE SET completed_at = excluded.completed_at`;
          return;
        }
        const notebook = yield* get(event.aggregateId as ThreadId);
        if (!notebook) return;
        if (event.type === "idea.changed") {
          const next = yield* Effect.try({
            try: () =>
              applyIdeaMutation(notebook, event.payload.mutation, event.occurredAt, event.sequence),
            catch: failure,
          });
          yield* save(next);
          if (next.status === "deleting")
            yield* sql`INSERT INTO idea_deletion_markers(thread_id, epoch, requested_at, completed_at)
          VALUES (${next.threadId}, ${next.deletionEpoch}, ${event.occurredAt}, NULL) ON CONFLICT(thread_id) DO NOTHING`;
        } else if (
          event.type === "thread.session-set" &&
          event.payload.turnSettled &&
          notebook.status !== "deleting"
        ) {
          yield* save(
            applyIdeaMutation(
              notebook,
              { kind: "update.request", sequence: event.sequence },
              event.occurredAt,
              event.sequence,
            ),
          );
        } else if (
          (event.type === "thread.user-input-response-requested" ||
            (event.type === "thread.message-sent" && event.payload.role === "user")) &&
          notebook.status !== "deleting"
        ) {
          yield* save({
            ...notebook,
            status: "active",
            revision: notebook.revision + 1,
            contentRevision: notebook.contentRevision + 1,
            updatedAt: event.occurredAt,
            update: {
              ...notebook.update,
              requestedSequence: Math.max(event.sequence, notebook.update.requestedSequence),
              status: "waiting",
              runId: null,
              error: null,
            },
          });
        }
      }, Effect.mapError(failure));
      return IdeaNotebookStore.of({ get, requireActive, list, pending, isDeleted, project });
    }),
  );
}
