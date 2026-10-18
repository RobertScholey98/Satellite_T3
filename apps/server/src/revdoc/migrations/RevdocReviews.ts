import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Satellite migration 100. One Review per project worktree, its items, and its passes. Passes are
 * keyed by worktree rather than Review so a first generation pass can run before the Review exists.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS revdoc_reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      context TEXT NOT NULL,
      partial INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      generated_at TEXT,
      refreshed_at TEXT,
      worktree_stamp TEXT,
      export_error TEXT,
      UNIQUE (project_id, worktree_path)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS revdoc_items (
      review_id TEXT NOT NULL REFERENCES revdoc_reviews (id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      position INTEGER NOT NULL,
      area TEXT NOT NULL,
      check_text TEXT NOT NULL,
      expected TEXT NOT NULL,
      covered_paths_json TEXT NOT NULL,
      check_fingerprint TEXT NOT NULL,
      code_fingerprint TEXT NOT NULL,
      outcome TEXT NOT NULL,
      outcome_basis_json TEXT,
      note TEXT NOT NULL,
      stale_pass_id TEXT,
      dismissed INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      PRIMARY KEY (review_id, id)
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS revdoc_passes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      child_thread_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      data_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS revdoc_passes_by_worktree
    ON revdoc_passes (project_id, worktree_path, started_at)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS revdoc_passes_one_running
    ON revdoc_passes (project_id, worktree_path) WHERE status = 'running'
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS revdoc_testing_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL
    )
  `;
});
