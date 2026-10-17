/**
 * Builds databases in the shapes Satellite builds left behind, for tests of the ledger repair and
 * of later Satellite migrations. Satellite DDL is copied verbatim from origin/main's (2a9c7b9b26) migrations
 * 055 to 069. Rows are synthetic.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../../../mcp/McpSessionRegistry.testkit.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../../orchestration-v2/EventStore.ts";
import * as LegacyV1ThreadImporter from "../../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../../../orchestration-v2/runtimeLayer.ts";
import * as ThreadLifecycleService from "../../../orchestration-v2/ThreadLifecycleService.ts";
import { migrationEntries, runMigrations } from "../../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../../project/ProjectEnrichmentService.ts";
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";

/**
 * Which Satellite rows a 1.x build recorded. `55-60` is the maintainer's install, `55-62` the
 * v1.1.12 to v1.2.1 tags, `55-56` an older build, `early-ideas` the first Ideas build.
 */
export type SatelliteV1Ledger = "55-60" | "55-62" | "55-56" | "early-ideas";

export const LEGACY_CREATED_AT = "2026-10-04 19:53:37";
export const PROJECT_ID = "project:satellite";
export const THREADS = {
  work: "thread:satellite:work",
  idea: "thread:satellite:idea",
  revdoc: "thread:satellite:revdoc",
  archivedIdea: "thread:satellite:archived-idea",
  deletedRevdoc: "thread:satellite:deleted-revdoc",
} as const;
export const ARCHIVED_IDEA_AT = "2026-10-02T00:00:00.000Z";
export const DELETED_REVDOC_AT = "2026-10-03T00:00:00.000Z";

export const BOARD_TABLES = [
  "issue_boards",
  "issue_attempts",
  "issue_active_attempts",
  "issue_lifecycle_consumed",
  "issue_generations",
  "issue_lifecycle_outbox",
  "issue_pr_observations",
  "issue_moves",
  "issue_requests",
  "issue_board_snapshots",
] as const;

const satellite055 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE managed_documents (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
    current_revision_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
    status TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX managed_documents_thread ON managed_documents(thread_id, updated_at)`;
  yield* sql`CREATE TABLE document_revisions (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES managed_documents(id),
    number INTEGER NOT NULL, format TEXT NOT NULL, content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, definition_json TEXT NOT NULL, snapshot_path TEXT NOT NULL,
    answers_json TEXT NOT NULL, answer_version INTEGER NOT NULL,
    UNIQUE(document_id, number)
  )`;
  yield* sql`CREATE TABLE document_submissions (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES managed_documents(id),
    revision_id TEXT NOT NULL REFERENCES document_revisions(id), answer_version INTEGER NOT NULL,
    answers_json TEXT NOT NULL, markdown TEXT NOT NULL, created_at TEXT NOT NULL,
    actor TEXT NOT NULL, delivery TEXT NOT NULL, delivery_attempt INTEGER NOT NULL DEFAULT 0, delivery_error TEXT
  )`;
  yield* sql`CREATE INDEX document_submissions_document ON document_submissions(document_id, created_at)`;
  yield* sql`CREATE TABLE document_history (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES managed_documents(id),
    revision_id TEXT NOT NULL, event TEXT NOT NULL, actor TEXT NOT NULL,
    created_at TEXT NOT NULL, detail TEXT NOT NULL, answer_version INTEGER, answers_json TEXT
  )`;
  yield* sql`CREATE INDEX document_history_document ON document_history(document_id, created_at)`;
  yield* sql`CREATE TABLE document_requests (
    actor TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
    result_json TEXT NOT NULL, PRIMARY KEY(actor, request_id)
  )`;
});

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

const satellite057 = Effect.gen(function* () {
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

const satellite058 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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

const satellite060 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TEMP TABLE revdoc_thread_purposes AS SELECT thread_id, purpose FROM projection_threads`;
  yield* sql`DROP INDEX projection_threads_purpose`;
  yield* sql`ALTER TABLE projection_threads DROP COLUMN purpose`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN purpose TEXT NOT NULL DEFAULT 'work' CHECK (purpose IN ('work', 'idea', 'revdoc'))`;
  yield* sql`UPDATE projection_threads SET purpose = (SELECT purpose FROM revdoc_thread_purposes WHERE revdoc_thread_purposes.thread_id = projection_threads.thread_id)`;
  yield* sql`DROP TABLE revdoc_thread_purposes`;
  yield* sql`CREATE INDEX projection_threads_purpose ON projection_threads(purpose, archived_at, deleted_at)`;
});

const satellite061 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN commit_recommendation_json TEXT`;
});

const satellite062 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_request_lifecycle
    ON projection_thread_activities(thread_id, kind)
    WHERE kind IN (
      'approval.requested', 'approval.resolved', 'provider.approval.respond.failed',
      'user-input.requested', 'user-input.resolved', 'provider.user-input.respond.failed'
    )
  `;
});

const satellite067 = Effect.gen(function* () {
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

const satellite068 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE document_revisions ADD COLUMN media_type TEXT`;
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

const earlyIdeas = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN purpose TEXT NOT NULL DEFAULT 'work'
    CHECK (purpose IN ('work', 'idea'))`;
  yield* sql`CREATE TABLE projection_idea_notebooks (
    thread_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
    updated_at TEXT NOT NULL, excerpt TEXT NOT NULL, update_status TEXT NOT NULL,
    deletion_error TEXT, notebook_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE idea_deletion_markers (
    thread_id TEXT PRIMARY KEY NOT NULL, epoch INTEGER NOT NULL,
    requested_at TEXT NOT NULL, completed_at TEXT
  )`;
  yield* sql`CREATE INDEX projection_threads_purpose ON projection_threads(purpose, archived_at, deleted_at)`;
});

type Step = readonly [
  id: number,
  name: string,
  ddl: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>,
];

const V1_STEPS: Record<SatelliteV1Ledger, ReadonlyArray<Step>> = {
  "55-56": [
    [55, "ManagedDocuments", satellite055],
    [56, "IssueBoards", satellite056],
  ],
  "55-60": [
    [55, "ManagedDocuments", satellite055],
    [56, "IssueBoards", satellite056],
    [57, "OpenWork", satellite057],
    [58, "IdeaNotebooks", satellite058],
    [59, "IssueBoardSnapshots", satellite059],
    [60, "RevdocTesting", satellite060],
  ],
  "55-62": [
    [55, "ManagedDocuments", satellite055],
    [56, "IssueBoards", satellite056],
    [57, "OpenWork", satellite057],
    [58, "IdeaNotebooks", satellite058],
    [59, "IssueBoardSnapshots", satellite059],
    [60, "RevdocTesting", satellite060],
    [61, "ProjectionThreadsCommitRecommendation", satellite061],
    [62, "ProjectionRequestLifecycleIndex", satellite062],
  ],
  "early-ideas": [[55, "IdeaNotebooks", earlyIdeas]],
};

const DEV_BUILD_STEPS: ReadonlyArray<Step> = [
  [67, "DocumentPlacements", satellite067],
  [68, "DocumentMediaTypes", satellite068],
  [69, "IssueDeliveryPeers", satellite069],
];

const applySteps = (steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [id, name, ddl] of steps) {
      yield* ddl;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (${id}, ${name}, ${LEGACY_CREATED_AT})
      `;
    }
  });

const tableExists = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
    return rows.length > 0;
  });

const seedThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at, deleted_at
    ) VALUES (
      ${PROJECT_ID}, 'Satellite', '/work/satellite', NULL, '[]',
      '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL
    )
  `;
  const rows = [
    [THREADS.work, "Work thread", "2026-10-01T01:00:00.000Z", null, null],
    [THREADS.idea, "Idea thread", "2026-10-01T02:00:00.000Z", null, null],
    [THREADS.revdoc, "Revdoc test thread", "2026-10-01T03:00:00.000Z", null, null],
    [THREADS.archivedIdea, "Archived idea", "2026-10-01T04:00:00.000Z", ARCHIVED_IDEA_AT, null],
    [THREADS.deletedRevdoc, "Deleted revdoc", "2026-10-01T05:00:00.000Z", null, DELETED_REVDOC_AT],
  ] as const;
  for (const [threadId, title, createdAt, archivedAt, deletedAt] of rows) {
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        ${threadId}, ${PROJECT_ID}, ${title}, '{"instanceId":"codex","model":"gpt-5.4"}',
        'full-access', 'default', ${createdAt}, ${createdAt}, ${archivedAt}, ${deletedAt}
      )
    `;
  }
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, attachments_json, is_streaming,
      created_at, updated_at
    ) VALUES
      ('message:satellite:1', ${THREADS.work}, NULL, 'user', 'Fix the build', '[]', 0,
        '2026-10-01T01:01:00.000Z', '2026-10-01T01:01:00.000Z'),
      ('message:satellite:2', ${THREADS.work}, NULL, 'assistant', 'Fixed it', '[]', 0,
        '2026-10-01T01:02:00.000Z', '2026-10-01T01:02:00.000Z')
  `;
});

const seedSatelliteRows = (steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (yield* tableExists("issue_boards")) {
      yield* sql`INSERT INTO issue_boards VALUES ('board-1', ${PROJECT_ID}, 'gh:acme/1', 'Acme board',
      '{"kind":"github-project","host":"github.com","owner":"acme","ownerKind":"organization","projectNumber":1}',
      '{"ready":"col-ready","inProgress":"col-prog","inPullRequest":"col-pr","completed":"col-done","moveOnMerge":true}')`;
      yield* sql`INSERT INTO issue_attempts (id, reservation_id, board_id, issue_key, link_json, launch_order,
        project_id, thread_id, worktree_path, status, created_at, started_at, source_generation, controlling_pr_key)
      VALUES ('attempt-1', 'res-1', 'board-1', 'github:github.com/acme/app#7', '{"attemptId":"attempt-1"}', 1,
        ${PROJECT_ID}, ${THREADS.work}, '/work/satellite/.worktrees/7', 'started',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z', 0, NULL)`;
      yield* sql`INSERT INTO issue_active_attempts VALUES ('github:github.com/acme/app#7', 'attempt-1', 1)`;
    }
    if (yield* tableExists("issue_board_snapshots")) {
      yield* sql`INSERT INTO issue_board_snapshots VALUES ('board-1', 3, 'hash', '{"columns":[]}',
      '2026-10-01T00:00:00.000Z', NULL, NULL)`;
    }
    if (yield* tableExists("managed_documents")) {
      yield* sql`INSERT INTO managed_documents VALUES ('doc-1', ${THREADS.work}, 'Doc', 'markdown', 'rev-1', 1,
      'open', '2026-10-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO document_revisions (id, document_id, number, format, content_hash, created_at,
        definition_json, snapshot_path, answers_json, answer_version)
      VALUES ('rev-1', 'doc-1', 1, 'markdown', 'h', '2026-10-01T00:00:00.000Z', '{}', '/x', '{}', 0)`;
      yield* sql`INSERT INTO document_history VALUES ('h-1', 'doc-1', 'rev-1', 'created', 'user',
      '2026-10-01T00:00:00.000Z', '', NULL, NULL)`;
    }
    if (yield* tableExists("open_worktrees")) {
      yield* sql`INSERT INTO open_worktrees VALUES ('wt-1', '/work/satellite/.git', '/work/satellite')`;
      yield* sql`INSERT INTO open_work_folders VALUES ('f-1', 'wt-1', '/work/satellite/docs', '2026-10-01')`;
      yield* sql`INSERT INTO open_work_documents (id, worktree_id, title, source, observed_at, favorite)
      VALUES ('owd-1', 'wt-1', 'Favourite', 'file', '2026-10-01', 1)`;
    }
    if (yield* tableExists("projection_idea_notebooks")) {
      yield* sql`INSERT INTO projection_idea_notebooks VALUES (${THREADS.idea}, 1, 'open', '2026-10-01', 'x',
      'idle', NULL, '{}')`;
    }
    // 058 and the early Ideas build allow purpose 'idea'; 060 adds 'revdoc'.
    if (steps.some(([, name]) => name === "IdeaNotebooks")) {
      yield* sql`UPDATE projection_threads SET purpose = 'idea'
      WHERE ${sql.in("thread_id", [THREADS.idea, THREADS.archivedIdea])}`;
    }
    if (steps.some(([, name]) => name === "RevdocTesting")) {
      yield* sql`UPDATE projection_threads SET purpose = 'revdoc'
      WHERE ${sql.in("thread_id", [THREADS.revdoc, THREADS.deletedRevdoc])}`;
    }
  });

/** A 1.x database: upstream migrations 1 to 54, then the Satellite rows `ledger` names. */
export const seedSatelliteV1 = (ledger: SatelliteV1Ledger) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* seedThreads;
    yield* applySteps(V1_STEPS[ledger]);
    yield* seedSatelliteRows(V1_STEPS[ledger]);
  });

const importV1Threads = Effect.gen(function* () {
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  return yield* importer.reconcileShells;
}).pipe(
  Effect.provide(
    LegacyV1ThreadImporter.layer.pipe(
      Layer.provide(EventSink.layer),
      Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
    ),
  ),
);

/**
 * A database a dev build since 2026-10-09 left behind: Satellite 55 to 62, upstream's V2
 * migrations 55 to 58 recorded at 63 to 66, Satellite 67 to 69, V1 threads imported into V2,
 * and the fork-only V2 data upstream does not know.
 */
export const seedSatelliteDevBuild = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* seedSatelliteV1("55-62");
  yield* Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        migrationEntries
          .filter(([id]) => id >= 55 && id <= 58)
          .map(([id, name, migration]) => [`${id + 8}_${name}`, migration]),
      ),
    ),
  });
  yield* applySteps(DEV_BUILD_STEPS);
  yield* importV1Threads;

  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_set(payload_json, '$.purpose',
      (SELECT purpose FROM projection_threads AS v1 WHERE v1.thread_id = orchestration_v2_projection_threads.thread_id))
    WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE purpose <> 'work')
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_set(payload_json, '$.issueAttempt', json('{"attemptId":"attempt-1"}'))
    WHERE thread_id = ${THREADS.work}
  `;
  yield* sql`
    INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json,
      metadata_json, application_event_version)
    SELECT 'satellite-dev:idea-changed-1', 'thread', ${THREADS.idea}, MAX(stream_version) + 1,
      'idea.changed', '2026-10-12T10:00:00.000Z', NULL, NULL, NULL, 'server',
      json_object('threadId', ${THREADS.idea}, 'mutation', json('{"kind":"noop"}')),
      '{"applicationEventVersion":2}', 2
    FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${THREADS.idea}
  `;
  yield* sql`UPDATE issue_attempts SET completed_at = '2026-10-11T00:00:00.000Z' WHERE id = 'attempt-1'`;
  yield* sql`UPDATE document_revisions SET media_type = 'text/markdown' WHERE id = 'rev-1'`;
  yield* sql`INSERT INTO issue_delivery_peers (destination_environment_id, endpoints_json, public_key,
      credential_expires_at, state, registered_at)
    VALUES ('env-2', '[]', 'pk', '2026-11-01', 'active', '2026-10-10')`;
  yield* sql`INSERT INTO issue_peer_grants VALUES ('env-3', 'pk')`;
  yield* sql`INSERT INTO document_placements (id, document_id, revision_id, thread_id, worktree_id, title,
      observed_at)
    VALUES ('p-1', 'doc-1', 'rev-1', ${THREADS.work}, 'wt-1', 'Doc', '2026-10-10')`;
});

export const readLedger = (table: "effect_sql_migrations" | "satellite_migrations") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (!(yield* tableExists(table))) return undefined;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
    const ledger: ReadonlyArray<readonly [number, string]> = rows.map(
      (row) => [row.migration_id, row.name] as const,
    );
    return ledger;
  });

export const listTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

export const listColumns = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_info(${table})`;
    return rows.map((row) => row.name);
  });

export const indexExists = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ${name}`;
    return rows.length > 0;
  });

export const dumpTables = (tables: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dump: Record<string, ReadonlyArray<unknown>> = {};
    for (const table of tables) {
      if (!(yield* tableExists(table))) continue;
      // Naming the columns keeps a cached statement from hiding a column added since. Some
      // upstream tables are WITHOUT ROWID, so rows are ordered by content.
      const columns = yield* listColumns(table);
      const select = columns.map((column) => `"${column}"`).join(", ");
      const rows = yield* sql.unsafe(`SELECT ${select} FROM "${table}"`);
      dump[table] = rows
        .map((row) => JSON.stringify(row))
        .toSorted()
        .map((row) => JSON.parse(row) as unknown);
    }
    return dump;
  });

export const dumpDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const schema = yield* sql`
    SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `;
  return { schema, rows: yield* dumpTables(yield* listTables) };
});

export const threadStates = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly thread_id: string;
    readonly archived_at: string | null;
    readonly deleted_at: string | null;
  }>`SELECT thread_id, archived_at, deleted_at FROM projection_threads ORDER BY created_at`;
});

export const v2ThreadStates = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly thread_id: string;
    readonly archived_at: string | null;
    readonly deleted_at: string | null;
  }>`SELECT thread_id, archived_at, deleted_at FROM orchestration_v2_projection_threads ORDER BY created_at`;
});

/** Reads every V2 event the way projection rebuilds do, failing on any type upstream rejects. */
export const readAllV2Events = Effect.gen(function* () {
  const store = yield* EventStore.EventStoreV2;
  return yield* store.read({}).pipe(Stream.runCollect);
}).pipe(Effect.provide(EventStore.layer));

const unusedEnrichment = {
  repositoryIdentity: null,
  faviconPath: null,
  repositoryIdentityResolved: false,
};

/**
 * Upstream's orchestration runtime and thread lifecycle service over the real persistence config
 * layer, so the V1 copy, the ledger repair and every migration run as they do at startup. The
 * database is `<baseDir>/userdata/statev2.sqlite`, copied from `state.sqlite` beside it if absent.
 */
export const layerSatelliteRuntime = (baseDir: string) => {
  const layerPlatform = Layer.merge(
    NodeServices.layer,
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("unused"),
    }),
  );
  const layerServerConfig = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const layerCheckpointStore = CheckpointStore.layer.pipe(
    Layer.provide(
      VcsDriverRegistry.layer.pipe(
        Layer.provide(VcsProcess.layer),
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatform),
      ),
    ),
  );
  const layerRuntime = RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService));
  return Layer.mergeAll(
    ThreadLifecycleService.layer.pipe(Layer.provideMerge(layerRuntime)),
    RuntimeLayer.layerProjectService,
  ).pipe(
    Layer.provide(
      Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
        peek: () => Effect.succeed(unusedEnrichment),
        getAvailable: () => Effect.succeed(unusedEnrichment),
        invalidate: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
    ),
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(SqlitePersistence.layerConfig),
    Layer.provide(layerCheckpointStore),
    Layer.provide(layerServerConfig),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: () => Effect.succeed(undefined),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflow.GitWorkflowService)({
        pruneWorktrees: () => Effect.void,
      }),
    ),
    Layer.provide(layerPlatform),
  );
};
