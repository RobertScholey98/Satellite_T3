import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  runMigrationsWithSatellite,
  satelliteMigrationEntries,
} from "../../satellite/persistence/SatelliteMigrations.ts";
import { readLedger } from "../../satellite/persistence/testing/satelliteLegacyFixtures.test.helpers.ts";

const withMigratedDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runMigrationsWithSatellite();
    return yield* effect;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const insertReview = (id: string, worktree: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO revdoc_reviews (id, project_id, worktree_path, revision, title, summary, context,
        created_at, updated_at)
      VALUES (${id}, 'project-1', ${worktree}, 1, 'Review', '', '', 'now', 'now')
    `,
  );

const insertPass = (id: string, status: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO revdoc_passes (id, project_id, worktree_path, kind, status, started_at, data_json)
      VALUES (${id}, 'project-1', '/work/a', 'generate', ${status}, 'now', '{}')
    `,
  );

const revdocMigrationId = satelliteMigrationEntries.find(
  ([, name]) => name === "RevdocReviews",
)?.[0];

describe("Satellite migration RevdocReviews", () => {
  it.effect("is recorded in the Satellite ledger", () =>
    withMigratedDatabase(
      Effect.gen(function* () {
        const ledger = (yield* readLedger("satellite_migrations")) ?? [];
        assert.isTrue(
          ledger.some(([id, name]) => id === revdocMigrationId && name === "RevdocReviews"),
        );
        assert.isUndefined(
          (yield* readLedger("effect_sql_migrations"))?.find(([id]) => id === revdocMigrationId),
        );
      }),
    ),
  );

  it.effect("keeps one Review per project worktree and deletes its items with it", () =>
    withMigratedDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertReview("review-1", "/work/a");
        const duplicate = yield* Effect.flip(insertReview("review-2", "/work/a"));
        assert.strictEqual(duplicate._tag, "SqlError");
        yield* sql`
          INSERT INTO revdoc_items (review_id, id, revision, position, area, check_text, expected,
            covered_paths_json, check_fingerprint, code_fingerprint, outcome, note)
          VALUES ('review-1', 'item-1', 1, 0, 'General', 'Check', '', '[]', 'c', 'k', 'complete', '')
        `;
        yield* sql`DELETE FROM revdoc_reviews WHERE id = 'review-1'`;
        assert.deepStrictEqual(yield* sql`SELECT id FROM revdoc_items`, []);
      }),
    ),
  );

  it.effect("allows one running pass per worktree", () =>
    withMigratedDatabase(
      Effect.gen(function* () {
        yield* insertPass("pass-1", "running");
        yield* insertPass("pass-2", "completed");
        const second = yield* Effect.flip(insertPass("pass-3", "running"));
        assert.strictEqual(second._tag, "SqlError");
      }),
    ),
  );
});
