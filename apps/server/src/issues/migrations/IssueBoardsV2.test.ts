import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { IssueBoardsV2 } from "./IssueBoardsV2.ts";

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

// Verbatim from Satellite 1.x migrations 056 IssueBoards, 059 IssueBoardSnapshots and 069
// IssueDeliveryPeers.
const satellite056 = Effect.gen(function* () {
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

const satellite059 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_board_snapshots (
      board_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      board_json TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      failed_at TEXT,
      failure TEXT
    )
  `;
});

const satellite069 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE issue_delivery_peers (
    destination_environment_id TEXT PRIMARY KEY, endpoints_json TEXT NOT NULL,
    public_key TEXT NOT NULL, credential_expires_at TEXT NOT NULL,
    preferred_endpoint TEXT, state TEXT NOT NULL, last_error TEXT, last_attempt_at TEXT,
    last_delivered_at TEXT, failures INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0, registered_at TEXT NOT NULL
  )`;
  yield* sql`ALTER TABLE issue_attempts ADD COLUMN completed_at TEXT`;
  yield* sql`CREATE TABLE issue_peer_grants (
    source_environment_id TEXT PRIMARY KEY, public_key TEXT NOT NULL
  )`;
});

const HERE = "env-here";
const ELSEWHERE = "env-elsewhere";
const BARRIER =
  "This lifecycle event arrived after a manual move without observing its synchronization barrier. Retry only to apply this event deliberately.";

const issue = (number: number) => ({
  hostKind: "github",
  host: "github.com",
  repository: "acme/app",
  id: `I_${number}`,
  number,
  url: `https://github.com/acme/app/issues/${number}`,
});
const issueKey = (number: number) => `github:github.com:acme/app:I_${number}`;
const issueJson = (number: number) =>
  `{"hostKind":"github","host":"github.com","repository":"acme/app","id":"I_${number}","number":${number},"url":"https://github.com/acme/app/issues/${number}"}`;

interface LegacyAttempt {
  readonly id: string;
  readonly board: string;
  readonly issue: number;
  readonly source?: string;
  readonly destination?: string;
  readonly launchOrder: number;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly status: "reserved" | "attached" | "started" | "failed";
  readonly prKey?: string;
}

const LEGACY_ATTEMPTS: ReadonlyArray<LegacyAttempt> = [
  // Superseded by att-open on the same ticket.
  {
    id: "att-old",
    board: "board-1",
    issue: 1,
    launchOrder: 1,
    projectId: "project-1",
    threadId: "thread-old",
    status: "started",
  },
  {
    id: "att-open",
    board: "board-1",
    issue: 1,
    launchOrder: 2,
    projectId: "project-1",
    threadId: "thread-open",
    status: "started",
    prKey: "github.com/acme/app#11",
  },
  {
    id: "att-attached",
    board: "board-1",
    issue: 2,
    launchOrder: 3,
    projectId: "project-1",
    threadId: "thread-attached",
    status: "attached",
  },
  {
    id: "att-reserved",
    board: "board-1",
    issue: 3,
    launchOrder: 4,
    projectId: null,
    threadId: null,
    status: "reserved",
  },
  {
    id: "att-failed",
    board: "board-1",
    issue: 4,
    launchOrder: 5,
    projectId: "project-1",
    threadId: "thread-failed",
    status: "failed",
  },
  {
    id: "att-working",
    board: "board-1",
    issue: 5,
    launchOrder: 6,
    projectId: null,
    threadId: "thread-working",
    status: "started",
  },
  {
    id: "att-closed",
    board: "board-1",
    issue: 6,
    launchOrder: 7,
    projectId: "project-1",
    threadId: "thread-closed",
    status: "started",
    prKey: "github.com/acme/app#16",
  },
  // The board is here and the thread ran on another computer.
  {
    id: "att-source",
    board: "board-1",
    issue: 8,
    destination: ELSEWHERE,
    launchOrder: 8,
    projectId: "project-remote",
    threadId: "thread-remote",
    status: "started",
  },
  // The thread is here and the board is on another computer.
  {
    id: "att-destination",
    board: "board-remote",
    issue: 9,
    source: ELSEWHERE,
    launchOrder: 0,
    projectId: "project-1",
    threadId: "thread-destination",
    status: "started",
    prKey: "github.com/acme/app#19",
  },
  {
    id: "att-disconnected",
    board: "board-gone",
    issue: 10,
    launchOrder: 9,
    projectId: "project-1",
    threadId: "thread-disconnected",
    status: "started",
  },
];

const seedShapeA = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* satellite056;
  yield* satellite059;
  const mapping = (suffix: string, moveOnMerge: boolean) =>
    JSON.stringify({
      ready: [`ready${suffix}`],
      inProgress: `progress${suffix}`,
      inPullRequest: `pr${suffix}`,
      completed: `done${suffix}`,
      moveOnMerge,
    });
  yield* sql`INSERT INTO issue_boards VALUES
    ('board-1', 'project-1', 'gh:acme/1', 'Acme', '{"kind":"github-project"}', ${mapping("", true)}),
    ('board-2', 'project-1', 'gh:acme/2', 'Acme 2', '{"kind":"github-project"}', ${mapping("-2", false)})`;
  yield* sql`INSERT INTO issue_board_snapshots VALUES
    ('board-1', 3, 'hash-1', '{"columns":[]}', '2026-10-01T00:00:00.000Z', NULL, NULL)`;
  for (const attempt of LEGACY_ATTEMPTS) {
    const source = attempt.source ?? HERE;
    yield* sql`INSERT INTO issue_attempts ${sql.insert({
      id: attempt.id,
      reservation_id: `res-${attempt.id}`,
      board_id: attempt.board,
      issue_key: issueKey(attempt.issue),
      link_json: JSON.stringify({
        attemptId: attempt.id,
        reservationId: `res-${attempt.id}`,
        sourceEnvironmentId: source,
        sourceProjectId: source === HERE ? "project-1" : "project-source",
        boardId: attempt.board,
        issue: issue(attempt.issue),
        destinationEnvironmentId: attempt.destination ?? HERE,
        sourceGeneration: 2,
      }),
      launch_order: attempt.launchOrder,
      project_id: attempt.projectId,
      thread_id: attempt.threadId,
      worktree_path: attempt.threadId === null ? null : `/work/${attempt.id}`,
      status: attempt.status,
      created_at: `2026-10-0${(attempt.launchOrder % 9) + 1}T00:00:00.000Z`,
      started_at: attempt.status === "started" ? "2026-10-10T00:00:00.000Z" : null,
      source_generation: 2,
      controlling_pr_key: attempt.prKey ?? null,
    })}`;
  }
  yield* sql`INSERT INTO issue_active_attempts VALUES
    (${issueKey(1)}, 'att-open', 2),
    (${issueKey(5)}, 'att-working', 6),
    (${issueKey(6)}, 'att-closed', 7),
    (${issueKey(8)}, 'att-source', 8),
    (${issueKey(10)}, 'att-disconnected', 9)`;
  yield* sql`INSERT INTO issue_pr_observations VALUES
    ('att-open', 'github.com/acme/app#11', 'open'),
    ('att-closed', 'github.com/acme/app#16', 'closed'),
    ('att-destination', 'github.com/acme/app#19', 'open')`;
  yield* sql`INSERT INTO issue_lifecycle_consumed VALUES ('event-1', 'att-open')`;
  yield* sql`INSERT INTO issue_generations VALUES (${issueKey(1)}, 2)`;
  yield* sql`INSERT INTO issue_lifecycle_outbox (event_key, receipt_json) VALUES ('event-1', '{}')`;
  const moves = [
    ["move-manual-pending", "manual:req-1", "pending", null],
    ["move-manual-failed", "manual:req-2", "failed", "The board could not be reached."],
    ["move-event-pending", "event:ev-1", "pending", null],
    ["move-event-barrier", "event:ev-2", "failed", BARRIER],
    ["move-event-failed", "event:ev-3", "failed", "The item no longer exists."],
    ["move-event-applied", "event:ev-4", "applied", null],
    ["move-event-superseded", "event:ev-5", "superseded", null],
  ] as const;
  for (const [id, requestKey, status, error] of moves) {
    yield* sql`INSERT INTO issue_moves ${sql.insert({
      id,
      request_key: requestKey,
      board_id: "board-1",
      issue_key: issueKey(1),
      issue_json: issueJson(1),
      column_id: "pr",
      attempt_id: "att-open",
      status,
      error,
      created_at: "2026-10-11T00:00:00.000Z",
    })}`;
  }
  yield* sql`INSERT INTO issue_requests VALUES ('req-1', 'hash', '"move-manual-pending"')`;
});

/** A dev build with 069, plus an attempt whose merge is known only from completed_at. */
const seedShapeB = (deliveryTables: "present" | "dropped by repair") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedShapeA;
    yield* satellite069;
    yield* sql`INSERT INTO issue_attempts ${sql.insert({
      id: "att-merged",
      reservation_id: "res-att-merged",
      board_id: "board-2",
      issue_key: issueKey(7),
      link_json: JSON.stringify({
        attemptId: "att-merged",
        reservationId: "res-att-merged",
        sourceEnvironmentId: HERE,
        sourceProjectId: "project-1",
        boardId: "board-2",
        issue: issue(7),
        destinationEnvironmentId: HERE,
        sourceGeneration: 0,
      }),
      launch_order: 10,
      project_id: "project-1",
      thread_id: "thread-merged",
      worktree_path: "/work/att-merged",
      status: "started",
      created_at: "2026-10-09T00:00:00.000Z",
      started_at: "2026-10-10T00:00:00.000Z",
      source_generation: 0,
      controlling_pr_key: "github.com/acme/app#17",
      completed_at: "2026-10-12T00:00:00.000Z",
    })}`;
    yield* sql`INSERT INTO issue_active_attempts VALUES (${issueKey(7)}, 'att-merged', 10)`;
    yield* sql`INSERT INTO issue_pr_observations VALUES ('att-merged', 'github.com/acme/app#17', 'open')`;
    if (deliveryTables === "present") {
      yield* sql`INSERT INTO issue_delivery_peers (destination_environment_id, endpoints_json,
          public_key, credential_expires_at, state, registered_at)
        VALUES (${ELSEWHERE}, '[]', 'pk', '2026-11-01', 'ready', '2026-10-10')`;
      yield* sql`INSERT INTO issue_peer_grants VALUES (${ELSEWHERE}, 'pk')`;
    } else {
      yield* sql`DROP TABLE issue_delivery_peers`;
      yield* sql`DROP TABLE issue_peer_grants`;
    }
  });

const listTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

const listColumns = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_info(${table})`;
    return rows.map((row) => row.name);
  });

const listIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

/** Schema and every row of every table, for asserting a second run changed nothing. */
const dumpDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const schema = yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
  const rows: Record<string, ReadonlyArray<unknown>> = {};
  for (const table of yield* listTables) {
    rows[table] = yield* sql.unsafe(`SELECT * FROM "${table}" ORDER BY rowid`);
  }
  return { schema, rows };
});

const readAttempts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM issue_board_attempts ORDER BY id`;
});

const readMoves = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT id, origin, status, error, retry_at FROM issue_moves ORDER BY sequence`;
});

const NEW_TABLES = [
  "issue_board_attempts",
  "issue_board_snapshots",
  "issue_boards",
  "issue_maintenance",
  "issue_moves",
  "issue_requests",
];

const NEW_INDEXES = [
  "issue_board_attempts_active",
  "issue_board_attempts_issue",
  "issue_board_attempts_thread",
  "issue_moves_issue",
  "issue_moves_pending",
];

const carried = (
  id: string,
  fields: {
    readonly issue: number;
    readonly board?: string;
    readonly projectId?: string;
    readonly status: string;
    readonly active?: 0 | 1;
    readonly endedReason?: string | null;
    readonly baseline?: string | null;
    readonly prKey?: string | null;
    readonly prJson?: string | null;
    readonly createdAt: string;
    readonly startedAt: string | null;
  },
) => ({
  id,
  board_id: fields.board ?? "board-1",
  issue_key: issueKey(fields.issue),
  issue_json: issueJson(fields.issue),
  project_id: fields.projectId ?? "project-1",
  thread_id: id.replace("att-", "thread-"),
  worktree_path: `/work/${id}`,
  status: fields.status,
  active: fields.active ?? 0,
  ended_reason: fields.endedReason ?? null,
  baseline_column_id: fields.baseline ?? null,
  start_column_id: null,
  transition_index: 0,
  controlling_pr_key: fields.prKey ?? null,
  controlling_pr_json: fields.prJson ?? null,
  launch_request_id: null,
  launch_json: null,
  failure: null,
  created_at: fields.createdAt,
  started_at: fields.startedAt,
});

const SHAPE_A_ATTEMPTS = [
  carried("att-attached", {
    issue: 2,
    status: "launching",
    createdAt: "2026-10-04T00:00:00.000Z",
    startedAt: null,
  }),
  carried("att-closed", {
    issue: 6,
    status: "working",
    active: 1,
    baseline: "progress",
    prKey: "github.com/acme/app#16",
    prJson: '{"host":"github.com","repository":"acme/app","number":16}',
    createdAt: "2026-10-08T00:00:00.000Z",
    startedAt: "2026-10-10T00:00:00.000Z",
  }),
  carried("att-destination", {
    issue: 9,
    board: "board-remote",
    status: "ended",
    endedReason: "migrated-without-board",
    prKey: "github.com/acme/app#19",
    prJson: '{"host":"github.com","repository":"acme/app","number":19}',
    createdAt: "2026-10-01T00:00:00.000Z",
    startedAt: "2026-10-10T00:00:00.000Z",
  }),
  carried("att-disconnected", {
    issue: 10,
    board: "board-gone",
    status: "ended",
    endedReason: "migrated-without-board",
    createdAt: "2026-10-01T00:00:00.000Z",
    startedAt: "2026-10-10T00:00:00.000Z",
  }),
  carried("att-failed", {
    issue: 4,
    status: "failed",
    createdAt: "2026-10-06T00:00:00.000Z",
    startedAt: null,
  }),
  carried("att-old", {
    issue: 1,
    status: "ended",
    endedReason: "superseded",
    createdAt: "2026-10-02T00:00:00.000Z",
    startedAt: "2026-10-10T00:00:00.000Z",
  }),
  carried("att-open", {
    issue: 1,
    status: "in-pr",
    active: 1,
    baseline: "pr",
    prKey: "github.com/acme/app#11",
    prJson: '{"host":"github.com","repository":"acme/app","number":11}',
    createdAt: "2026-10-03T00:00:00.000Z",
    startedAt: "2026-10-10T00:00:00.000Z",
  }),
  // Its row had no project, so the link's source project stands in.
  carried("att-working", {
    issue: 5,
    status: "working",
    active: 1,
    baseline: "progress",
    createdAt: "2026-10-07T00:00:00.000Z",
    startedAt: "2026-10-10T00:00:00.000Z",
  }),
];

// Merged while board-2 had moveOnMerge off, so the ticket was left in the pull request column.
const MERGED_ATTEMPT = carried("att-merged", {
  issue: 7,
  board: "board-2",
  status: "merged",
  endedReason: "completed",
  baseline: "pr-2",
  prKey: "github.com/acme/app#17",
  prJson: '{"host":"github.com","repository":"acme/app","number":17}',
  createdAt: "2026-10-09T00:00:00.000Z",
  startedAt: "2026-10-10T00:00:00.000Z",
});

const TRANSLATED_MOVES = [
  { id: "move-manual-pending", origin: "manual", status: "pending", error: null, retry_at: null },
  {
    id: "move-manual-failed",
    origin: "manual",
    status: "failed",
    error: "The board could not be reached.",
    retry_at: null,
  },
  {
    id: "move-event-pending",
    origin: "automatic",
    status: "superseded",
    error: null,
    retry_at: null,
  },
  {
    id: "move-event-barrier",
    origin: "automatic",
    status: "skipped",
    error: "Moved by hand.",
    retry_at: null,
  },
  {
    id: "move-event-failed",
    origin: "automatic",
    status: "failed",
    error: "The item no longer exists.",
    retry_at: null,
  },
  {
    id: "move-event-applied",
    origin: "automatic",
    status: "applied",
    error: null,
    retry_at: null,
  },
  {
    id: "move-event-superseded",
    origin: "automatic",
    status: "superseded",
    error: null,
    retry_at: null,
  },
];

const assertTranslated = (expectedAttempts: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assert.deepStrictEqual(yield* listTables, NEW_TABLES);
    assert.deepStrictEqual(yield* listIndexes, NEW_INDEXES);
    assert.deepStrictEqual(yield* readAttempts, expectedAttempts);
    assert.deepStrictEqual(yield* readMoves, TRANSLATED_MOVES);
    assert.deepStrictEqual(yield* sql`SELECT * FROM issue_requests`, []);
    assert.deepStrictEqual(yield* sql`SELECT id, project_id, title FROM issue_boards ORDER BY id`, [
      { id: "board-1", project_id: "project-1", title: "Acme" },
      { id: "board-2", project_id: "project-1", title: "Acme 2" },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT board_id, revision FROM issue_board_snapshots`, [
      { board_id: "board-1", revision: 3 },
    ]);
  });

describe("IssueBoardsV2", () => {
  it.effect("creates the empty 2.0 schema on a fresh install", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* IssueBoardsV2;

        assert.deepStrictEqual(yield* listTables, NEW_TABLES);
        assert.deepStrictEqual(yield* listIndexes, NEW_INDEXES);
        assert.deepStrictEqual(yield* listColumns("issue_moves"), [
          "sequence",
          "id",
          "request_key",
          "board_id",
          "issue_key",
          "issue_json",
          "column_id",
          "attempt_id",
          "status",
          "error",
          "created_at",
          "origin",
          "retry_at",
          "expected_json",
        ]);
        assert.deepStrictEqual(yield* listColumns("issue_board_attempts"), [
          "id",
          "board_id",
          "issue_key",
          "issue_json",
          "project_id",
          "thread_id",
          "worktree_path",
          "status",
          "active",
          "ended_reason",
          "baseline_column_id",
          "start_column_id",
          "transition_index",
          "controlling_pr_key",
          "controlling_pr_json",
          "launch_request_id",
          "launch_json",
          "failure",
          "created_at",
          "started_at",
        ]);
        assert.deepStrictEqual(yield* listColumns("issue_maintenance"), ["name", "completed_at"]);
        for (const table of NEW_TABLES) {
          assert.deepStrictEqual(yield* sql.unsafe(`SELECT * FROM "${table}"`), []);
        }

        const first = yield* dumpDatabase;
        yield* IssueBoardsV2;
        assert.deepStrictEqual(yield* dumpDatabase, first);
      }),
    ),
  );

  it.effect("translates a Satellite 1.x database and changes nothing on a second run", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* seedShapeA;
        yield* IssueBoardsV2;

        yield* assertTranslated(SHAPE_A_ATTEMPTS);

        const first = yield* dumpDatabase;
        yield* IssueBoardsV2;
        assert.deepStrictEqual(yield* dumpDatabase, first);
      }),
    ),
  );

  it.effect.each(["present", "dropped by repair"] as const)(
    "translates a dev-build database with delivery tables %s and changes nothing on a second run",
    (deliveryTables) =>
      withDatabase(
        Effect.gen(function* () {
          yield* seedShapeB(deliveryTables);
          yield* IssueBoardsV2;

          yield* assertTranslated(
            [...SHAPE_A_ATTEMPTS, MERGED_ATTEMPT].toSorted((a, b) => a.id.localeCompare(b.id)),
          );

          const first = yield* dumpDatabase;
          yield* IssueBoardsV2;
          assert.deepStrictEqual(yield* dumpDatabase, first);
        }),
      ),
  );
});
