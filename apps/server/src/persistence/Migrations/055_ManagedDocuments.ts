import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE managed_documents (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
    current_revision_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
    status TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX managed_documents_thread ON managed_documents(thread_id, updated_at)`;
  yield* sql`CREATE TABLE document_revisions (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES managed_documents(id),
    number INTEGER NOT NULL, format TEXT NOT NULL, content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, definition_json TEXT NOT NULL, snapshot_path TEXT NOT NULL,
    answers_json TEXT NOT NULL, answer_version INTEGER NOT NULL,
    UNIQUE(document_id, number)
  )`;
  yield* sql`CREATE TABLE document_submissions (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES managed_documents(id),
    revision_id TEXT NOT NULL REFERENCES document_revisions(id), answer_version INTEGER NOT NULL,
    answers_json TEXT NOT NULL, markdown TEXT NOT NULL, created_at TEXT NOT NULL,
    actor TEXT NOT NULL, delivery TEXT NOT NULL, delivery_attempt INTEGER NOT NULL DEFAULT 0, delivery_error TEXT
  )`;
  yield* sql`CREATE INDEX document_submissions_document ON document_submissions(document_id, created_at)`;
  yield* sql`CREATE TABLE document_history (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES managed_documents(id),
    revision_id TEXT NOT NULL, event TEXT NOT NULL, actor TEXT NOT NULL,
    created_at TEXT NOT NULL, detail TEXT NOT NULL, answer_version INTEGER, answers_json TEXT
  )`;
  yield* sql`CREATE INDEX document_history_document ON document_history(document_id, created_at)`;
  yield* sql`CREATE TABLE document_requests (
    actor TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
    result_json TEXT NOT NULL, PRIMARY KEY(actor, request_id)
  )`;
});
