import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect("adds internal Revdoc runs without changing existing thread data or purposes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 59 });
    for (const purpose of ["work", "idea"]) {
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at, purpose, worktree_path)
      VALUES (${purpose}, 'project', 'Keep this title', '{"instanceId":"codex","model":"test"}', 'full-access', '2026-10-04T12:00:00Z', '2026-10-04T12:00:00Z', ${purpose}, '/worktree')`;
    }
    yield* runMigrations();
    assert.deepEqual(
      yield* sql`SELECT thread_id, title, purpose, worktree_path FROM projection_threads ORDER BY thread_id`,
      [
        {
          thread_id: "idea",
          title: "Keep this title",
          purpose: "idea",
          worktree_path: "/worktree",
        },
        {
          thread_id: "work",
          title: "Keep this title",
          purpose: "work",
          worktree_path: "/worktree",
        },
      ],
    );
    yield* sql`UPDATE projection_threads SET purpose = 'revdoc' WHERE thread_id = 'work'`;
    assert.deepEqual(yield* sql`SELECT purpose FROM projection_threads WHERE thread_id = 'work'`, [
      { purpose: "revdoc" },
    ]);
    assert.strictEqual(
      (yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projection_threads_purpose'`)
        .length,
      1,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
