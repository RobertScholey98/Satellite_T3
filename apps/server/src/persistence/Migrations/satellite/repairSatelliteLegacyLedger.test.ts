import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../../Migrations.ts";
import { repairSatelliteLegacyLedger } from "./repairSatelliteLegacyLedger.ts";
import {
  ARCHIVED_IDEA_AT,
  BOARD_TABLES,
  DELETED_REVDOC_AT,
  dumpDatabase,
  dumpTables,
  indexExists,
  listColumns,
  listTables,
  readLedger,
  seedSatelliteDevBuild,
  seedSatelliteV1,
  THREADS,
  threadStates,
} from "../../../satellite/persistence/testing/satelliteLegacyFixtures.test.helpers.ts";

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    return yield* effect;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const upstreamThrough54 = migrationManifest.filter(([id]) => id <= 54);
const upstreamThrough58 = migrationManifest.filter(([id]) => id <= 58);

const ORPHANS_55_60 = [
  "document_submissions",
  "document_history",
  "document_revisions",
  "document_requests",
  "managed_documents",
  "open_work_documents",
  "open_work_folders",
  "open_work_requests",
  "open_worktrees",
  "projection_idea_notebooks",
  "idea_deletion_markers",
];

describe("repairSatelliteLegacyLedger", () => {
  it.effect.each([
    {
      ledger: "55-60",
      moved: [
        [55, "ManagedDocuments"],
        [56, "IssueBoards"],
        [57, "OpenWork"],
        [58, "IdeaNotebooks"],
        [59, "IssueBoardSnapshots"],
        [60, "RevdocTesting"],
      ],
      droppedTables: ORPHANS_55_60,
      droppedColumns: ["projection_threads.purpose"],
      droppedIndexes: [],
      archivedV1Threads: 2,
    },
    {
      ledger: "55-62",
      moved: [
        [55, "ManagedDocuments"],
        [56, "IssueBoards"],
        [57, "OpenWork"],
        [58, "IdeaNotebooks"],
        [59, "IssueBoardSnapshots"],
        [60, "RevdocTesting"],
        [61, "ProjectionThreadsCommitRecommendation"],
        [62, "ProjectionRequestLifecycleIndex"],
      ],
      droppedTables: ORPHANS_55_60,
      droppedColumns: [
        "projection_threads.commit_recommendation_json",
        "projection_threads.purpose",
      ],
      droppedIndexes: ["idx_projection_thread_activities_request_lifecycle"],
      archivedV1Threads: 2,
    },
    {
      ledger: "55-56",
      moved: [
        [55, "ManagedDocuments"],
        [56, "IssueBoards"],
      ],
      droppedTables: [
        "document_submissions",
        "document_history",
        "document_revisions",
        "document_requests",
        "managed_documents",
      ],
      droppedColumns: [],
      droppedIndexes: [],
      archivedV1Threads: 0,
    },
    {
      ledger: "early-ideas",
      moved: [[55, "IdeaNotebooks"]],
      droppedTables: ["projection_idea_notebooks", "idea_deletion_markers"],
      droppedColumns: ["projection_threads.purpose"],
      droppedIndexes: [],
      archivedV1Threads: 1,
    },
  ] as const)("repairs a 1.x database at Satellite $ledger", (expected) =>
    withDatabase(
      Effect.gen(function* () {
        yield* seedSatelliteV1(expected.ledger);
        const boards = yield* dumpTables(BOARD_TABLES);

        const outcome = yield* repairSatelliteLegacyLedger();

        assert.deepStrictEqual(outcome, {
          moved: expected.moved,
          renumbered: [],
          droppedTables: expected.droppedTables,
          droppedColumns: expected.droppedColumns,
          droppedIndexes: expected.droppedIndexes,
          archivedV1Threads: expected.archivedV1Threads,
          queuedV2Archives: 0,
          deletedForkEvents: 0,
        });
        assert.deepStrictEqual(yield* readLedger("effect_sql_migrations"), upstreamThrough54);
        assert.deepStrictEqual(yield* readLedger("satellite_migrations"), expected.moved);
        assert.deepStrictEqual(yield* dumpTables(BOARD_TABLES), boards);
        const tables = yield* listTables;
        for (const table of expected.droppedTables) assert.notInclude(tables, table);
        const columns = yield* listColumns("projection_threads");
        assert.notInclude(columns, "purpose");
        assert.notInclude(columns, "commit_recommendation_json");
        assert.isFalse(yield* indexExists("idx_projection_thread_activities_request_lifecycle"));
        assert.isFalse(yield* indexExists("projection_threads_purpose"));
        assert.deepStrictEqual(
          yield* SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql`PRAGMA foreign_key_check`)),
          [],
        );
      }),
    ),
  );

  it.effect("archives open V1 Idea and Revdoc threads and keeps archived and deleted ones", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* seedSatelliteV1("55-60");

        yield* repairSatelliteLegacyLedger();

        const states = new Map((yield* threadStates).map((row) => [row.thread_id, row]));
        assert.deepStrictEqual(states.get(THREADS.work), {
          thread_id: THREADS.work,
          archived_at: null,
          deleted_at: null,
        });
        assert.match(states.get(THREADS.idea)?.archived_at ?? "", /^\d{4}-\d\d-\d\dT/);
        assert.match(states.get(THREADS.revdoc)?.archived_at ?? "", /^\d{4}-\d\d-\d\dT/);
        assert.deepStrictEqual(states.get(THREADS.archivedIdea), {
          thread_id: THREADS.archivedIdea,
          archived_at: ARCHIVED_IDEA_AT,
          deleted_at: null,
        });
        assert.deepStrictEqual(states.get(THREADS.deletedRevdoc), {
          thread_id: THREADS.deletedRevdoc,
          archived_at: null,
          deleted_at: DELETED_REVDOC_AT,
        });
      }),
    ),
  );

  it.effect("repairs a dev-build database and queues its V2 Idea and Revdoc threads", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedSatelliteDevBuild;
        const boards = yield* dumpTables(BOARD_TABLES);

        const outcome = yield* repairSatelliteLegacyLedger();

        assert.deepStrictEqual(outcome, {
          moved: [
            [55, "ManagedDocuments"],
            [56, "IssueBoards"],
            [57, "OpenWork"],
            [58, "IdeaNotebooks"],
            [59, "IssueBoardSnapshots"],
            [60, "RevdocTesting"],
            [61, "ProjectionThreadsCommitRecommendation"],
            [62, "ProjectionRequestLifecycleIndex"],
            [67, "DocumentPlacements"],
            [68, "DocumentMediaTypes"],
            [69, "IssueDeliveryPeers"],
          ],
          renumbered: [
            [63, 55, "OrchestrationV2"],
            [64, 56, "RemoveRedundantProjectionIndexes"],
            [65, 57, "ScheduledTaskWebhooks"],
            [66, 58, "WebhookRelayDeliveries"],
          ],
          droppedTables: [
            "document_placements",
            ...ORPHANS_55_60,
            "issue_delivery_peers",
            "issue_peer_grants",
          ],
          droppedColumns: [
            "projection_threads.commit_recommendation_json",
            "projection_threads.purpose",
          ],
          droppedIndexes: ["idx_projection_thread_activities_request_lifecycle"],
          archivedV1Threads: 2,
          queuedV2Archives: 2,
          deletedForkEvents: 1,
        });
        assert.deepStrictEqual(yield* readLedger("effect_sql_migrations"), upstreamThrough58);
        assert.deepStrictEqual(
          (yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM satellite_legacy_thread_archives ORDER BY thread_id
          `).map((row) => row.thread_id),
          [THREADS.idea, THREADS.revdoc],
        );
        assert.deepStrictEqual(yield* dumpTables(BOARD_TABLES), boards);
        assert.deepStrictEqual(
          yield* sql`SELECT completed_at FROM issue_attempts WHERE id = 'attempt-1'`,
          [{ completed_at: "2026-10-11T00:00:00.000Z" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT event_id FROM orchestration_events WHERE event_type LIKE 'idea.%'`,
          [],
        );
        assert.deepStrictEqual(
          yield* runMigrations(),
          migrationManifest.filter(([id]) => id >= 59),
        );
      }),
    ),
  );

  it.effect("leaves fresh, upstream-only and repaired databases unchanged", () =>
    withDatabase(
      Effect.gen(function* () {
        const unchanged = {
          moved: [],
          renumbered: [],
          droppedTables: [],
          droppedColumns: [],
          droppedIndexes: [],
          archivedV1Threads: 0,
          queuedV2Archives: 0,
          deletedForkEvents: 0,
        };
        assert.deepStrictEqual(yield* repairSatelliteLegacyLedger(), unchanged);
        assert.deepStrictEqual(yield* listTables, []);

        yield* runMigrations();
        const upstream = yield* dumpDatabase;
        assert.deepStrictEqual(yield* repairSatelliteLegacyLedger(), unchanged);
        assert.deepStrictEqual(yield* dumpDatabase, upstream);
        assert.isUndefined(yield* readLedger("satellite_migrations"));
      }),
    ),
  );

  it.effect.each(["55-62", "dev-build"] as const)(
    "changes nothing when run again on a repaired %s database",
    (shape) =>
      withDatabase(
        Effect.gen(function* () {
          yield* shape === "dev-build" ? seedSatelliteDevBuild : seedSatelliteV1(shape);
          yield* repairSatelliteLegacyLedger();
          const repaired = yield* dumpDatabase;

          const second = yield* repairSatelliteLegacyLedger();

          assert.deepStrictEqual(second.moved, []);
          assert.deepStrictEqual(yield* dumpDatabase, repaired);
          yield* runMigrations();
          const migrated = yield* dumpDatabase;
          yield* repairSatelliteLegacyLedger();
          assert.deepStrictEqual(yield* dumpDatabase, migrated);
        }),
      ),
  );

  it.effect("rolls back schema and ledger together on failure and can retry", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedSatelliteV1("55-60");
        yield* sql`
          CREATE TABLE blocker (document_id TEXT NOT NULL REFERENCES managed_documents(id))
        `;
        yield* sql`INSERT INTO blocker VALUES ('doc-1')`;
        const before = yield* dumpDatabase;

        const exit = yield* Effect.exit(repairSatelliteLegacyLedger());

        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "Satellite ledger repair failed");
        assert.include(String(exit), "state.sqlite was not modified");
        assert.deepStrictEqual(yield* dumpDatabase, before);

        yield* sql`DROP TABLE blocker`;
        const retry = yield* repairSatelliteLegacyLedger();
        assert.strictEqual(retry.moved.length, 6);
        assert.deepStrictEqual(yield* readLedger("effect_sql_migrations"), upstreamThrough54);
      }),
    ),
  );

  it.effect("refuses to renumber onto an id another migration holds", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 54 });
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (55, 'SomeoneElsesMigration'), (63, 'OrchestrationV2')
        `;
        const before = yield* dumpDatabase;

        const error = yield* Effect.flip(repairSatelliteLegacyLedger());

        assert.strictEqual(error.kind, "BadState");
        assert.include(error.message, "63_OrchestrationV2");
        assert.include(error.message, "55_SomeoneElsesMigration");
        assert.deepStrictEqual(yield* dumpDatabase, before);
      }),
    ),
  );
});
