import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.effect("moves published Open work rows into placements and leaves folder links", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 66 });
    yield* sql`INSERT INTO open_worktrees (id, common_dir, path) VALUES ('/repo', '/repo/.git', '/repo')`;
    yield* sql`INSERT INTO open_work_folders (id, worktree_id, path, time_link)
      VALUES ('folder-1', '/repo', '/repo/docs', 'none')`;
    yield* sql`INSERT INTO open_work_documents (id, worktree_id, title, source, document_id, revision_id,
      thread_id, commit_sha, anchor_head, observed_at, favorite, unresolved)
      VALUES ('publication:revision-1', '/repo', 'Plan', 'published', 'document-1', 'revision-1',
      'thread-1', 'abc123', 'head-1', '2026-10-01T00:00:00.000Z', 1, NULL),
      ('publication:revision-2', '/repo', 'Plan v2', 'published', 'document-1', 'revision-2',
      'thread-1', NULL, 'head-2', '2026-10-02T00:00:00.000Z', 0, 'history-diverged')`;
    yield* sql`INSERT INTO open_work_documents (id, worktree_id, title, source, folder_id, path,
      observed_at, association_mode)
      VALUES ('file:1', '/repo', 'notes.md', 'linked', 'folder-1', '/repo/docs/notes.md',
      '2026-10-03T00:00:00.000Z', 'unassigned')`;

    assert.deepStrictEqual(yield* runMigrations(), [[67, "DocumentPlacements"]]);

    assert.deepStrictEqual(yield* sql`SELECT * FROM document_placements ORDER BY id`, [
      {
        id: "publication:revision-1",
        document_id: "document-1",
        revision_id: "revision-1",
        thread_id: "thread-1",
        worktree_id: "/repo",
        title: "Plan",
        commit_sha: "abc123",
        anchor_head: "head-1",
        observed_at: "2026-10-01T00:00:00.000Z",
        favorite: 1,
        unresolved: null,
      },
      {
        id: "publication:revision-2",
        document_id: "document-1",
        revision_id: "revision-2",
        thread_id: "thread-1",
        worktree_id: "/repo",
        title: "Plan v2",
        commit_sha: null,
        anchor_head: "head-2",
        observed_at: "2026-10-02T00:00:00.000Z",
        favorite: 0,
        unresolved: "history-diverged",
      },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT id, source, path, association_mode FROM open_work_documents`,
      [
        {
          id: "file:1",
          source: "linked",
          path: "/repo/docs/notes.md",
          association_mode: "unassigned",
        },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
