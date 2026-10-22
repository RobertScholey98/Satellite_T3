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
    lead_thread_id TEXT,
    board_id TEXT,
    branch TEXT,
    complexity TEXT NOT NULL,
    state TEXT NOT NULL,
    team_json TEXT NOT NULL,
    recovery_used INTEGER NOT NULL DEFAULT 0,
    waiting_reason TEXT,
    waiting_kind TEXT,
    stall_reason TEXT,
    cancel_reason TEXT,
    claim_json TEXT,
    team_verdict_json TEXT,
    checklist_json TEXT NOT NULL DEFAULT '[]',
    digest_text TEXT,
    digest_generated_at TEXT,
    digest_activity_at TEXT,
    control_violations_json TEXT NOT NULL DEFAULT '[]',
    -- Pull request key to the snapshot updatedAt its files were last checked at.
    control_checked_json TEXT NOT NULL DEFAULT '{}',
    team_retro_at TEXT,
    manager_retro_at TEXT,
    -- Time spent in waiting-user so far, plus when the current wait began.
    waiting_user_ms INTEGER NOT NULL DEFAULT 0,
    waiting_since TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_assignments_manager
    ON factory_assignments(manager_id, state)`;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_assignments_lead
    ON factory_assignments(lead_thread_id)`;

  yield* sql`CREATE TABLE IF NOT EXISTS factory_members (
    thread_id TEXT PRIMARY KEY,
    manager_id TEXT NOT NULL,
    assignment_id TEXT,
    role TEXT NOT NULL,
    parent_thread_id TEXT,
    joined TEXT NOT NULL,
    taken_over INTEGER NOT NULL DEFAULT 0,
    off_pool INTEGER NOT NULL DEFAULT 0,
    model_selection_json TEXT,
    created_at TEXT NOT NULL,
    ended_at TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_members_assignment
    ON factory_members(assignment_id)`;

  yield* sql`CREATE TABLE IF NOT EXISTS factory_dependencies (
    id TEXT PRIMARY KEY,
    blocked_assignment_id TEXT NOT NULL,
    delivering_assignment_id TEXT,
    title TEXT NOT NULL,
    unblock_condition TEXT NOT NULL,
    brief TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_dependencies_blocked
    ON factory_dependencies(blocked_assignment_id)`;

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
  yield* sql`CREATE INDEX IF NOT EXISTS factory_log_kind
    ON factory_log(manager_id, kind, delivered_at)`;

  yield* sql`CREATE TABLE IF NOT EXISTS factory_findings (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL,
    manager_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    class TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence TEXT NOT NULL,
    uncertainty TEXT,
    workaround TEXT,
    escalated INTEGER NOT NULL DEFAULT 0,
    draft_id TEXT,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_findings_assignment
    ON factory_findings(assignment_id)`;

  // marker is hidden in the filed ticket's body, so a retried approval finds it instead of filing again.
  yield* sql`CREATE TABLE IF NOT EXISTS factory_ticket_drafts (
    id TEXT PRIMARY KEY,
    manager_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    assignment_id TEXT,
    scope TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    acceptance_json TEXT NOT NULL,
    finding_ids_json TEXT NOT NULL,
    state TEXT NOT NULL,
    issue_json TEXT,
    proposed_change_json TEXT,
    marker TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_ticket_drafts_project
    ON factory_ticket_drafts(project_id, state)`;

  // One row per ended assignment, written when it ends, so team stats never rescan threads.
  yield* sql`CREATE TABLE IF NOT EXISTS factory_assignment_stats (
    assignment_id TEXT PRIMARY KEY,
    manager_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    team TEXT NOT NULL,
    complexity TEXT NOT NULL,
    outcome TEXT NOT NULL,
    team_verdict TEXT,
    input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL,
    agent_ms INTEGER NOT NULL,
    wall_ms INTEGER NOT NULL,
    waiting_user_ms INTEGER NOT NULL,
    recoveries INTEGER NOT NULL,
    pull_requests INTEGER NOT NULL,
    review_rounds INTEGER NOT NULL,
    by_role_json TEXT NOT NULL,
    by_model_json TEXT NOT NULL,
    ended_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_assignment_stats_project
    ON factory_assignment_stats(project_id, ended_at)`;

  yield* sql`CREATE TABLE IF NOT EXISTS factory_requests (
    request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL
  )`;
});
