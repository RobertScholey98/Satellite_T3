import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Satellite 102. The engineering factory's own tables. Threads, runs and pull requests stay in
 * upstream's projections and are referenced by id only, like issue attempts.
 */
export const FactoryV1 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // scope_key is 'environment' or 'project:<project id>'.
  yield* sql`CREATE TABLE IF NOT EXISTS factory_config (
    scope_key TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS factory_managers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    state TEXT NOT NULL,
    paused_from TEXT,
    thread_id TEXT,
    control_paths_json TEXT NOT NULL DEFAULT '[]',
    onboarding_notes TEXT NOT NULL DEFAULT '',
    onboarding_report_json TEXT,
    model_selection_json TEXT,
    runtime_mode TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS factory_managers_current
    ON factory_managers(project_id) WHERE state != 'retired'`;

  yield* sql`CREATE TABLE IF NOT EXISTS factory_assignments (
    id TEXT PRIMARY KEY,
    manager_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    completion_condition TEXT NOT NULL,
    source TEXT NOT NULL,
    issue_json TEXT,
    attempt_id TEXT,
    complexity TEXT NOT NULL,
    state TEXT NOT NULL,
    team_json TEXT NOT NULL,
    recovery_used INTEGER NOT NULL DEFAULT 0,
    waiting_reason TEXT,
    cancel_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_assignments_manager
    ON factory_assignments(manager_id, state)`;

  yield* sql`CREATE TABLE IF NOT EXISTS factory_members (
    thread_id TEXT PRIMARY KEY,
    manager_id TEXT NOT NULL,
    assignment_id TEXT,
    role TEXT NOT NULL,
    parent_thread_id TEXT,
    joined TEXT NOT NULL,
    taken_over INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    ended_at TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_members_assignment
    ON factory_members(assignment_id)`;

  // Wakes are rows first and messages second, so a restart redelivers undelivered ones.
  yield* sql`CREATE TABLE IF NOT EXISTS factory_log (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    manager_id TEXT NOT NULL,
    assignment_id TEXT,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    payload_json TEXT,
    at TEXT NOT NULL,
    delivered_at TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_log_manager ON factory_log(manager_id, sequence)`;

  yield* sql`CREATE TABLE IF NOT EXISTS factory_requests (
    request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL
  )`;
});
