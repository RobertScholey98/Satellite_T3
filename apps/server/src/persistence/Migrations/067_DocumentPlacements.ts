import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Published Open work rows become worktree placements owned by the documents module. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS document_placements (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, revision_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL, worktree_id TEXT NOT NULL REFERENCES open_worktrees(id),
    title TEXT NOT NULL, commit_sha TEXT, anchor_head TEXT, observed_at TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0, unresolved TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS document_placements_worktree ON document_placements(worktree_id)`;
  yield* sql`INSERT OR IGNORE INTO document_placements (id,document_id,revision_id,thread_id,worktree_id,title,commit_sha,anchor_head,observed_at,favorite,unresolved)
    SELECT id,document_id,revision_id,thread_id,worktree_id,title,commit_sha,anchor_head,observed_at,favorite,unresolved
    FROM open_work_documents
    WHERE source='published' AND document_id IS NOT NULL AND revision_id IS NOT NULL AND thread_id IS NOT NULL
    ORDER BY rowid`;
  yield* sql`DELETE FROM open_work_documents WHERE id IN (SELECT id FROM document_placements)`;
});
