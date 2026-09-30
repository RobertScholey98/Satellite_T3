import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const now = "2026-09-30T22:00:00.000Z";
const notebookJson = '{"pitch":"Keep the existing pitch","entries":[{"body":"A user decision"}]}';

const seedThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_threads (
    thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at
  ) VALUES ('thread-1', 'project-1', 'Existing thread',
    '{"instanceId":"claude","model":"sonnet"}', 'full-access', ${now}, ${now})`;
});

const seedSatelliteContent = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO managed_documents (
    id, thread_id, title, kind, current_revision_id, revision_number, status, updated_at
  ) VALUES ('document-1', 'thread-1', 'Reviewed design', 'review', 'revision-1', 1, 'active', ${now})`;
  yield* sql`INSERT INTO issue_boards (id, project_id, locator_key, title, locator_json, mapping_json)
    VALUES ('board-1', 'project-1', 'github:owner/repo', 'Delivery', '{}', '{}')`;
  yield* sql`INSERT INTO open_worktrees (id, common_dir, path)
    VALUES ('worktree-1', '/repo/.git', '/repo')`;
});

const assertSatelliteContent = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepEqual(yield* sql`SELECT id, title FROM managed_documents`, [
    { id: "document-1", title: "Reviewed design" },
  ]);
  assert.deepEqual(yield* sql`SELECT id, title FROM issue_boards`, [
    { id: "board-1", title: "Delivery" },
  ]);
  assert.deepEqual(yield* sql`SELECT id, path FROM open_worktrees`, [
    { id: "worktree-1", path: "/repo" },
  ]);
});

const seedLegacyIdeas = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  yield* seedThread;
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
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'IdeaNotebooks')`;
  yield* sql`UPDATE projection_threads SET purpose = 'idea' WHERE thread_id = 'thread-1'`;
  yield* sql`INSERT INTO projection_idea_notebooks (
    thread_id, revision, status, updated_at, excerpt, update_status, notebook_json
  ) VALUES ('thread-1', 7, 'active', ${now}, 'Keep the existing pitch', 'current', ${notebookJson})`;
  yield* sql`INSERT INTO idea_deletion_markers (thread_id, epoch, requested_at, completed_at)
    VALUES ('deleted-idea', 2, ${now}, ${now})`;
});

const assertLegacyIdeasContent = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepEqual(yield* sql`SELECT thread_id, title, purpose FROM projection_threads`, [
    { thread_id: "thread-1", title: "Existing thread", purpose: "idea" },
  ]);
  assert.deepEqual(
    yield* sql`SELECT thread_id, revision, notebook_json FROM projection_idea_notebooks`,
    [{ thread_id: "thread-1", revision: 7, notebook_json: notebookJson }],
  );
  assert.deepEqual(yield* sql`SELECT thread_id, epoch, completed_at FROM idea_deletion_markers`, [
    { thread_id: "deleted-idea", epoch: 2, completed_at: now },
  ]);
});

const assertCurrentLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepEqual(
    yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55 ORDER BY migration_id`,
    [
      { migration_id: 55, name: "ManagedDocuments" },
      { migration_id: 56, name: "IssueBoards" },
      { migration_id: 57, name: "OpenWork" },
      { migration_id: 58, name: "IdeaNotebooks" },
    ],
  );
});

it.effect("fresh startup creates usable Ideas, Documents, Issues and Open Work schemas", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* seedThread;
    yield* seedSatelliteContent;
    yield* sql`INSERT INTO projection_idea_notebooks (
      thread_id, revision, status, updated_at, excerpt, update_status, notebook_json
    ) VALUES ('thread-1', 1, 'active', ${now}, 'A new idea', 'current', '{}')`;
    assert.deepEqual(yield* sql`SELECT purpose FROM projection_threads`, [{ purpose: "work" }]);
    assert.deepEqual(yield* sql`SELECT excerpt FROM projection_idea_notebooks`, [
      { excerpt: "A new idea" },
    ]);
    yield* assertCurrentLedger;
    assert.deepEqual(yield* runMigrations(), []);
    yield* assertSatelliteContent;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("existing Satellite data survives the Ideas upgrade and another startup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 57 });
    yield* seedThread;
    yield* seedSatelliteContent;
    assert.deepEqual(yield* runMigrations(), [[58, "IdeaNotebooks"]]);
    yield* assertSatelliteContent;
    assert.deepEqual(yield* sql`SELECT title, purpose FROM projection_threads`, [
      { title: "Existing thread", purpose: "work" },
    ]);
    assert.deepEqual(yield* runMigrations(), []);
    yield* assertSatelliteContent;
    yield* assertCurrentLedger;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "the original Ideas migration is reconciled without losing notebooks or deletion markers",
  () =>
    Effect.gen(function* () {
      yield* seedLegacyIdeas;
      assert.deepEqual(yield* runMigrations(), [
        [56, "IssueBoards"],
        [57, "OpenWork"],
        [58, "IdeaNotebooks"],
      ]);
      yield* assertLegacyIdeasContent;
      yield* assertCurrentLedger;
      yield* seedSatelliteContent;
      assert.deepEqual(yield* runMigrations(), []);
      yield* assertLegacyIdeasContent;
      yield* assertSatelliteContent;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "failed legacy repair rolls back all pending schemas and ledger changes before retry",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyIdeas;
      yield* sql`CREATE TABLE managed_documents (sentinel TEXT)`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55`,
        [{ migration_id: 55, name: "IdeaNotebooks" }],
      );
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name IN ('issue_boards', 'open_worktrees')`,
        [],
      );
      yield* assertLegacyIdeasContent;
      yield* sql`DROP TABLE managed_documents`;
      yield* runMigrations();
      yield* assertCurrentLedger;
      yield* assertLegacyIdeasContent;
      yield* seedSatelliteContent;
      yield* assertSatelliteContent;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("an incomplete legacy Ideas schema fails without creating a false migration record", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacyIdeas;
    yield* sql`DROP TABLE idea_deletion_markers`;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55`,
      [{ migration_id: 55, name: "IdeaNotebooks" }],
    );
    assert.deepEqual(yield* sql`SELECT notebook_json FROM projection_idea_notebooks`, [
      { notebook_json: notebookJson },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
