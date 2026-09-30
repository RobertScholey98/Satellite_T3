import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE open_worktrees (id TEXT PRIMARY KEY, common_dir TEXT NOT NULL, path TEXT NOT NULL)`;
  yield* sql`CREATE TABLE open_work_folders (
    id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES open_worktrees(id),
    path TEXT NOT NULL, time_link TEXT NOT NULL, UNIQUE(worktree_id,path)
  )`;
  yield* sql`CREATE TABLE open_work_documents (
    id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES open_worktrees(id),
    title TEXT NOT NULL, source TEXT NOT NULL, document_id TEXT, revision_id TEXT UNIQUE,
    thread_id TEXT, folder_id TEXT, path TEXT, commit_sha TEXT, anchor_head TEXT,
    observed_at TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
    available INTEGER NOT NULL DEFAULT 1, unresolved TEXT, association_mode TEXT NOT NULL DEFAULT 'pending',
    UNIQUE(worktree_id,path)
  )`;
  yield* sql`CREATE INDEX open_work_documents_worktree ON open_work_documents(worktree_id)`;
  yield* sql`CREATE TABLE open_work_requests (
    request_id TEXT PRIMARY KEY, payload TEXT NOT NULL, result_json TEXT NOT NULL
  )`;
});
