import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import migrateManagedDocuments from "./055_ManagedDocuments.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const legacyIdeas = yield* sql`
    SELECT migration_id FROM effect_sql_migrations
    WHERE migration_id = 55 AND name = 'IdeaNotebooks'
  `;
  if (legacyIdeas.length > 0) {
    // The initial Ideas branch used 55 before joining the fork's Documents history.
    // This runs in the migrator's transaction, preserving notebooks and repairing the skipped schema.
    yield* sql`SELECT purpose FROM projection_threads LIMIT 0`;
    yield* sql`SELECT thread_id, revision, status, updated_at, excerpt, update_status,
      deletion_error, notebook_json FROM projection_idea_notebooks LIMIT 0`;
    yield* sql`SELECT thread_id, epoch, requested_at, completed_at FROM idea_deletion_markers LIMIT 0`;
    yield* migrateManagedDocuments;
    yield* sql`UPDATE effect_sql_migrations SET name = 'ManagedDocuments' WHERE migration_id = 55`;
    return;
  }
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
