import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE issue_boards (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, locator_key TEXT NOT NULL,
    title TEXT NOT NULL, locator_json TEXT NOT NULL, mapping_json TEXT NOT NULL,
    UNIQUE(project_id, locator_key)
  )`;
  yield* sql`CREATE TABLE issue_attempts (
    id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL, board_id TEXT NOT NULL,
    issue_key TEXT NOT NULL, link_json TEXT NOT NULL, launch_order INTEGER NOT NULL,
    project_id TEXT, thread_id TEXT, worktree_path TEXT, status TEXT NOT NULL,
    created_at TEXT NOT NULL, started_at TEXT, source_generation INTEGER NOT NULL DEFAULT 0,
    controlling_pr_key TEXT
  )`;
  yield* sql`CREATE INDEX issue_attempts_thread ON issue_attempts(thread_id)`;
  yield* sql`CREATE INDEX issue_attempts_issue ON issue_attempts(board_id, issue_key)`;
  yield* sql`CREATE TABLE issue_active_attempts (
    issue_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, launch_order INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE issue_lifecycle_consumed (event_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL)`;
  yield* sql`CREATE TABLE issue_generations (issue_key TEXT PRIMARY KEY, generation INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE issue_lifecycle_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
    receipt_json TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE issue_pr_observations (
    attempt_id TEXT NOT NULL, pr_key TEXT NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY(attempt_id, pr_key)
  )`;
  yield* sql`CREATE TABLE issue_moves (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    request_key TEXT NOT NULL UNIQUE, board_id TEXT NOT NULL, issue_key TEXT NOT NULL,
    issue_json TEXT NOT NULL, column_id TEXT NOT NULL, attempt_id TEXT,
    status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX issue_moves_pending ON issue_moves(status, sequence)`;
  yield* sql`CREATE INDEX issue_moves_issue ON issue_moves(board_id, issue_key, sequence)`;
  yield* sql`CREATE TABLE issue_requests (
    request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL
  )`;
});
