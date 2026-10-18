import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { runMigrations } from "../../persistence/Migrations.ts";
import { repairSatelliteLegacyLedger } from "../../persistence/Migrations/satellite/repairSatelliteLegacyLedger.ts";
import RevdocReviews from "../../revdoc/migrations/RevdocReviews.ts";

/**
 * Ids 55 to 69 of `satellite_migrations` hold rows the ledger repair moved out of upstream's
 * ledger. They are records and never run. The migrator skips every id at or below the highest
 * recorded one, so a Satellite migration in this range would run on fresh installs and be
 * skipped on upgraded ones. Satellite migrations start at 100.
 */
export const SATELLITE_LEGACY_MIGRATION_IDS = { first: 55, last: 69 } as const;
export const FIRST_SATELLITE_MIGRATION_ID = 100;

export type SatelliteMigration = readonly [
  id: number,
  name: string,
  migration: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>,
];

export const satelliteMigrationEntries: ReadonlyArray<SatelliteMigration> = [
  [100, "RevdocReviews", RevdocReviews],
];

const run = Migrator.make({});

export const runSatelliteMigrations = Effect.fn("runSatelliteMigrations")(function* (
  entries: ReadonlyArray<SatelliteMigration> = satelliteMigrationEntries,
) {
  const reserved = entries.filter(([id]) => id < FIRST_SATELLITE_MIGRATION_ID);
  if (reserved.length > 0) {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: `Satellite migration ids start at ${FIRST_SATELLITE_MIGRATION_ID}: ${reserved.map(([id, name]) => `${id}_${name}`).join(", ")}. Upgraded databases would skip them.`,
    });
  }
  const executed = yield* run({
    table: "satellite_migrations",
    loader: Migrator.fromRecord(
      Object.fromEntries(entries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
    ),
  });
  if (executed.length > 0) {
    yield* Effect.log("Satellite migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});

/** Upstream's persistence setup runs this in place of `runMigrations`. */
export const runMigrationsWithSatellite = Effect.fn("runMigrationsWithSatellite")(function* () {
  yield* repairSatelliteLegacyLedger();
  const executed = yield* runMigrations();
  yield* runSatelliteMigrations();
  return executed;
});
