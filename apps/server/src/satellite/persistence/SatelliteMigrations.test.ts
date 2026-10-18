import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest } from "../../persistence/Migrations.ts";
import {
  FIRST_SATELLITE_MIGRATION_ID,
  runMigrationsWithSatellite,
  SATELLITE_LEGACY_MIGRATION_IDS,
  runSatelliteMigrations,
  satelliteMigrationEntries,
  type SatelliteMigration,
} from "./SatelliteMigrations.ts";
import {
  readLedger,
  seedSatelliteDevBuild,
  seedSatelliteV1,
} from "./testing/satelliteLegacyFixtures.test.helpers.ts";

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

// Shipped Satellite migrations, then a probe after them: the migrator skips ids below the highest
// recorded one, so the probe is 100 only while the manifest is empty.
const shippedLedger = satelliteMigrationEntries.map(([id, name]) => [id, name] as const);
const probeId = Math.max(FIRST_SATELLITE_MIGRATION_ID - 1, ...shippedLedger.map(([id]) => id)) + 1;

const probe: SatelliteMigration = [
  probeId,
  "Probe",
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS satellite_probe (runs INTEGER NOT NULL)`;
    yield* sql`INSERT INTO satellite_probe VALUES (1)`;
  }),
];

const probeRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql`SELECT runs FROM satellite_probe`).length;
});

describe("Satellite migrations", () => {
  it("ships no migration in the reserved range", () => {
    for (const [id] of satelliteMigrationEntries) {
      assert.isAtLeast(id, FIRST_SATELLITE_MIGRATION_ID);
    }
  });

  it.effect("records exactly the shipped Satellite migrations on a fresh install", () =>
    withDatabase(
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* runMigrationsWithSatellite(), migrationManifest);
        assert.deepStrictEqual(yield* readLedger("effect_sql_migrations"), migrationManifest);
        assert.deepStrictEqual(yield* readLedger("satellite_migrations"), shippedLedger);
      }),
    ),
  );

  it.effect.each(["fresh", "55-60", "dev-build"] as const)(
    "runs a new migration exactly once on a %s database",
    (shape) =>
      withDatabase(
        Effect.gen(function* () {
          if (shape === "55-60") yield* seedSatelliteV1(shape);
          if (shape === "dev-build") yield* seedSatelliteDevBuild;
          yield* runMigrationsWithSatellite();

          assert.deepStrictEqual(yield* runSatelliteMigrations([probe]), [[probeId, "Probe"]]);
          assert.deepStrictEqual(yield* runSatelliteMigrations([probe]), []);
          assert.strictEqual(yield* probeRuns, 1);
        }),
      ),
  );

  it.effect("adopts the ledger the repair created and keeps its legacy rows", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* seedSatelliteDevBuild;
        yield* runMigrationsWithSatellite();
        yield* runSatelliteMigrations([probe]);

        assert.deepStrictEqual(yield* readLedger("satellite_migrations"), [
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
          ...shippedLedger,
          [probeId, "Probe"],
        ]);
        assert.deepStrictEqual(yield* readLedger("effect_sql_migrations"), migrationManifest);
        for (const [id] of (yield* readLedger("satellite_migrations")) ?? []) {
          if (id >= FIRST_SATELLITE_MIGRATION_ID) continue;
          assert.isAtLeast(id, SATELLITE_LEGACY_MIGRATION_IDS.first);
          assert.isAtMost(id, SATELLITE_LEGACY_MIGRATION_IDS.last);
        }
      }),
    ),
  );

  it.effect("rejects a migration below 100 before running anything", () =>
    withDatabase(
      Effect.gen(function* () {
        const reserved: SatelliteMigration = [58, "ReservedRange", probe[2]];

        const error = yield* Effect.flip(runSatelliteMigrations([reserved, probe]));

        assert.strictEqual(error._tag, "MigrationError");
        assert.strictEqual(error._tag === "MigrationError" && error.kind, "BadState");
        assert.include(error.message, "58_ReservedRange");
        assert.isUndefined(yield* readLedger("satellite_migrations"));
      }),
    ),
  );
});
