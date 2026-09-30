import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN purpose TEXT NOT NULL DEFAULT 'work' CHECK (purpose IN ('work', 'idea'))`;
  yield* sql`CREATE TABLE projection_idea_notebooks (
    thread_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    update_status TEXT NOT NULL,
    deletion_error TEXT,
    notebook_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE idea_deletion_markers (
    thread_id TEXT PRIMARY KEY NOT NULL,
    epoch INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    completed_at TEXT
  )`;
  yield* sql`CREATE INDEX projection_threads_purpose ON projection_threads(purpose, archived_at, deleted_at)`;
});
