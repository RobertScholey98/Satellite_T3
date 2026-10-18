import {
  IssueBoardMapping,
  IssuePullRequestRef,
  IssueRef,
  type IssueAttemptEndedReason,
  type IssueAttemptStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { stageColumn, type AttemptStage } from "../attemptStage.ts";

/** Satellite 1.x wrote this on an automatic move that lost to a manual one. */
const GENERATION_BARRIER_ERROR =
  "This lifecycle event arrived after a manual move without observing its synchronization barrier. Retry only to apply this event deliberately.";

const LEGACY_TABLES = [
  "issue_attempts",
  "issue_active_attempts",
  "issue_lifecycle_consumed",
  "issue_generations",
  "issue_lifecycle_outbox",
  "issue_pr_observations",
  "issue_delivery_peers",
  "issue_peer_grants",
] as const;

const LegacyLink = Schema.fromJsonString(
  Schema.Struct({
    sourceEnvironmentId: Schema.String,
    destinationEnvironmentId: Schema.String,
    sourceProjectId: Schema.String,
    issue: IssueRef,
  }),
);
const decodeLink = Schema.decodeUnknownOption(LegacyLink);
const decodeMapping = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(IssueBoardMapping)),
);
const encodeIssue = Schema.encodeSync(Schema.fromJsonString(IssueRef));
const decodePullRequest = Schema.decodeUnknownOption(IssuePullRequestRef);
const encodePullRequest = Schema.encodeSync(Schema.fromJsonString(IssuePullRequestRef));

interface LegacyAttemptRow {
  readonly id: string;
  readonly board_id: string;
  readonly issue_key: string;
  readonly link_json: string;
  readonly project_id: string | null;
  readonly thread_id: string | null;
  readonly worktree_path: string | null;
  readonly status: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly controlling_pr_key: string | null;
  readonly completed_at: string | null;
}

interface Carried {
  readonly status: IssueAttemptStatus;
  readonly active: boolean;
  readonly endedReason: IssueAttemptEndedReason | null;
}

/** Inverse of `pullRequestKey`: `host/owner/repo#12` as stored JSON, or null when malformed. */
const pullRequestJsonFromKey = (key: string) => {
  const slash = key.indexOf("/");
  const hash = key.lastIndexOf("#");
  const number = Number(key.slice(hash + 1));
  if (slash <= 0 || hash <= slash + 1 || !Number.isInteger(number) || number <= 0) return null;
  return decodePullRequest({
    host: key.slice(0, slash),
    repository: key.slice(slash + 1, hash),
    number,
  }).pipe(Option.map(encodePullRequest), Option.getOrNull);
};

/** Where the attempt last left its ticket, which is where its next automatic move expects it. */
const baselineColumn = (status: IssueAttemptStatus, mapping: IssueBoardMapping | null) => {
  if (mapping === null) return null;
  if (status !== "working" && status !== "in-pr" && status !== "merged") return null;
  const stage: AttemptStage = status;
  // Without moveOnMerge the merged ticket stays where the pull request put it.
  return stage === "merged" && !mapping.moveOnMerge
    ? mapping.inPullRequest
    : stageColumn(stage, mapping);
};

const startedStage = (observed: string | undefined, completedAt: string | null) => {
  if (completedAt !== null) return "merged";
  switch (observed) {
    case "open":
      return "in-pr";
    case "merged":
      return "merged";
    default:
      return "working";
  }
};

/**
 * Satellite 101. Carries 1.x and dev-build issue board data into the 2.0 attempt model and drops
 * the relay, lifecycle and delivery tables. Rows are classified from their own link and the local
 * board table only.
 */
export const IssueBoardsV2 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tableExists = (name: string) =>
    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${name}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  const columnExists = (table: string, column: string) =>
    sql`SELECT 1 FROM pragma_table_info(${table}) WHERE name = ${column}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  yield* sql`CREATE TABLE IF NOT EXISTS issue_boards (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, locator_key TEXT NOT NULL,
    title TEXT NOT NULL, locator_json TEXT NOT NULL, mapping_json TEXT NOT NULL,
    UNIQUE(project_id, locator_key)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS issue_board_snapshots (
    board_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    board_json TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    failed_at TEXT,
    failure TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS issue_requests (
    request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL
  )`;

  const legacyMoves =
    (yield* tableExists("issue_moves")) && !(yield* columnExists("issue_moves", "origin"));
  yield* sql`CREATE TABLE IF NOT EXISTS issue_moves (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    request_key TEXT NOT NULL UNIQUE, board_id TEXT NOT NULL, issue_key TEXT NOT NULL,
    issue_json TEXT NOT NULL, column_id TEXT NOT NULL, attempt_id TEXT,
    status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'manual', retry_at TEXT, expected_json TEXT
  )`;
  if (!(yield* columnExists("issue_moves", "origin"))) {
    yield* sql`ALTER TABLE issue_moves ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'`;
  }
  if (!(yield* columnExists("issue_moves", "retry_at"))) {
    yield* sql`ALTER TABLE issue_moves ADD COLUMN retry_at TEXT`;
  }
  if (!(yield* columnExists("issue_moves", "expected_json"))) {
    yield* sql`ALTER TABLE issue_moves ADD COLUMN expected_json TEXT`;
  }
  yield* sql`CREATE INDEX IF NOT EXISTS issue_moves_pending ON issue_moves(status, sequence)`;
  yield* sql`CREATE INDEX IF NOT EXISTS issue_moves_issue ON issue_moves(board_id, issue_key, sequence)`;

  yield* sql`CREATE TABLE IF NOT EXISTS issue_board_attempts (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    issue_key TEXT NOT NULL,
    issue_json TEXT NOT NULL,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    worktree_path TEXT,
    status TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    ended_reason TEXT,
    baseline_column_id TEXT,
    start_column_id TEXT,
    transition_index INTEGER NOT NULL DEFAULT 0,
    controlling_pr_key TEXT,
    controlling_pr_json TEXT,
    launch_request_id TEXT UNIQUE,
    launch_json TEXT,
    failure TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS issue_board_attempts_active
    ON issue_board_attempts(board_id, issue_key) WHERE active = 1`;
  yield* sql`CREATE INDEX IF NOT EXISTS issue_board_attempts_thread ON issue_board_attempts(thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS issue_board_attempts_issue ON issue_board_attempts(board_id, issue_key)`;

  yield* sql`CREATE TABLE IF NOT EXISTS issue_maintenance (
    name TEXT PRIMARY KEY, completed_at TEXT NOT NULL
  )`;

  if (legacyMoves) {
    yield* sql`UPDATE issue_moves SET origin = 'automatic' WHERE request_key LIKE 'event:%'`;
    // The sweep recomputes automatic moves from current pull request state.
    yield* sql`UPDATE issue_moves SET status = 'superseded'
      WHERE origin = 'automatic' AND status = 'pending'`;
    yield* sql`UPDATE issue_moves SET status = 'skipped', error = 'Moved by hand.'
      WHERE origin = 'automatic' AND status = 'failed' AND error = ${GENERATION_BARRIER_ERROR}`;
  }

  if (yield* tableExists("issue_attempts")) {
    const completedAt = (yield* columnExists("issue_attempts", "completed_at"))
      ? sql.literal("completed_at")
      : sql.literal("NULL");
    const attempts = yield* sql<LegacyAttemptRow>`
      SELECT id, board_id, issue_key, link_json, project_id, thread_id, worktree_path, status,
        created_at, started_at, controlling_pr_key, ${completedAt} AS completed_at
      FROM issue_attempts ORDER BY launch_order, created_at, id
    `;
    const boards = new Map(
      (yield* sql<{ readonly id: string; readonly mapping_json: string }>`
        SELECT id, mapping_json FROM issue_boards
      `).map((board) => [board.id, Option.getOrNull(decodeMapping(board.mapping_json))]),
    );
    const activeIds = new Set(
      (yield* tableExists("issue_active_attempts"))
        ? (yield* sql<{ readonly attempt_id: string }>`
            SELECT attempt_id FROM issue_active_attempts
          `).map((row) => row.attempt_id)
        : [],
    );
    const observations = new Map(
      (yield* tableExists("issue_pr_observations"))
        ? (yield* sql<{
            readonly attempt_id: string;
            readonly pr_key: string;
            readonly state: string;
          }>`
            SELECT attempt_id, pr_key, state FROM issue_pr_observations
          `).map((row) => [`${row.attempt_id}\n${row.pr_key}`, row.state])
        : [],
    );

    const classify = (
      row: LegacyAttemptRow,
      sameEnvironment: boolean,
      boardLocal: boolean,
    ): Carried | null => {
      // The source of a cross-environment attempt has no thread to link and no longer owns it.
      if (!sameEnvironment && boardLocal) return null;
      if (!boardLocal) {
        return { status: "ended", active: false, endedReason: "migrated-without-board" };
      }
      switch (row.status) {
        case "reserved":
        case "attached":
          return { status: "launching", active: false, endedReason: null };
        case "failed":
          return { status: "failed", active: false, endedReason: null };
        case "started": {
          if (!activeIds.has(row.id)) {
            return { status: "ended", active: false, endedReason: "superseded" };
          }
          const observed =
            row.controlling_pr_key === null
              ? undefined
              : observations.get(`${row.id}\n${row.controlling_pr_key}`);
          const stage = startedStage(observed, row.completed_at);
          // A merged attempt is finished; it neither moves its ticket again nor holds the ticket.
          return stage === "merged"
            ? { status: stage, active: false, endedReason: "completed" }
            : { status: stage, active: true, endedReason: null };
        }
        default:
          return null;
      }
    };

    for (const row of attempts) {
      if (row.thread_id === null) continue;
      const link = decodeLink(row.link_json);
      if (Option.isNone(link)) continue;
      const boardLocal = boards.has(row.board_id);
      const carried = classify(
        row,
        link.value.sourceEnvironmentId === link.value.destinationEnvironmentId,
        boardLocal,
      );
      if (carried === null) continue;
      yield* sql`INSERT OR IGNORE INTO issue_board_attempts ${sql.insert({
        id: row.id,
        board_id: row.board_id,
        issue_key: row.issue_key,
        issue_json: encodeIssue(link.value.issue),
        project_id: row.project_id ?? link.value.sourceProjectId,
        thread_id: row.thread_id,
        worktree_path: row.worktree_path,
        status: carried.status,
        active: carried.active ? 1 : 0,
        ended_reason: carried.endedReason,
        baseline_column_id: baselineColumn(carried.status, boards.get(row.board_id) ?? null),
        start_column_id: null,
        transition_index: 0,
        controlling_pr_key: row.controlling_pr_key,
        controlling_pr_json:
          row.controlling_pr_key === null ? null : pullRequestJsonFromKey(row.controlling_pr_key),
        launch_request_id: null,
        created_at: row.created_at,
        started_at: row.started_at,
      })}`;
    }
    // Old request ids mean nothing to 2.0 clients.
    yield* sql`DELETE FROM issue_requests`;
  }

  for (const table of LEGACY_TABLES) {
    yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
  }
});
