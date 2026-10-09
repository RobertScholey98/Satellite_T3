import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Replace only the constrained column; keep thread bodies, worktree links, and indexes intact.
  yield* sql`CREATE TEMP TABLE revdoc_thread_purposes AS SELECT thread_id, purpose FROM projection_threads`;
  yield* sql`DROP INDEX projection_threads_purpose`;
  yield* sql`ALTER TABLE projection_threads DROP COLUMN purpose`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN purpose TEXT NOT NULL DEFAULT 'work' CHECK (purpose IN ('work', 'idea', 'revdoc'))`;
  yield* sql`UPDATE projection_threads SET purpose = (SELECT purpose FROM revdoc_thread_purposes WHERE revdoc_thread_purposes.thread_id = projection_threads.thread_id)`;
  yield* sql`DROP TABLE revdoc_thread_purposes`;
  yield* sql`CREATE INDEX projection_threads_purpose ON projection_threads(purpose, archived_at, deleted_at)`;
});
