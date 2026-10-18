import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as LegacyV1ThreadImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { migrationManifest } from "../../persistence/Migrations.ts";
import { drainLegacyThreadArchives } from "./drainLegacyThreadArchives.ts";
import { SATELLITE_LEGACY_LEDGER_ROWS } from "../../persistence/Migrations/satellite/repairSatelliteLegacyLedger.ts";
import { runMigrationsWithSatellite, satelliteMigrationEntries } from "./SatelliteMigrations.ts";
import {
  ARCHIVED_IDEA_AT,
  BOARD_TABLES,
  DELETED_REVDOC_AT,
  dumpDatabase,
  dumpTables,
  layerSatelliteRuntime,
  listTables,
  readAllV2Events,
  readLedger,
  seedSatelliteDevBuild,
  seedSatelliteV1,
  THREADS,
} from "./testing/satelliteLegacyFixtures.test.helpers.ts";

const SATELLITE_1X_TABLES = [
  "managed_documents",
  "document_revisions",
  "document_submissions",
  "document_history",
  "document_requests",
  "document_placements",
  "open_worktrees",
  "open_work_folders",
  "open_work_documents",
  "open_work_requests",
  "projection_idea_notebooks",
  "idea_deletion_markers",
  "issue_delivery_peers",
  "issue_peer_grants",
];

const LEGACY_55_60 = [
  [55, "ManagedDocuments"],
  [56, "IssueBoards"],
  [57, "OpenWork"],
  [58, "IdeaNotebooks"],
  [59, "IssueBoardSnapshots"],
  [60, "RevdocTesting"],
] as const;
const LEGACY_55_62 = [
  [55, "ManagedDocuments"],
  [56, "IssueBoards"],
  [57, "OpenWork"],
  [58, "IdeaNotebooks"],
  [59, "IssueBoardSnapshots"],
  [60, "RevdocTesting"],
  [61, "ProjectionThreadsCommitRecommendation"],
  [62, "ProjectionRequestLifecycleIndex"],
] as const;
const LEGACY_DEV_BUILD = [
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
] as const;

type Seed = (userdata: string) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;

interface UpgradeCase {
  readonly name: string;
  readonly seed: Seed;
  /** Rows the Satellite ledger must hold after the upgrade; `source` reads them from state.sqlite. */
  readonly legacyRows: ReadonlyArray<readonly [number, string]> | "source";
  readonly fixtureThreads: boolean;
}

const seedFile = <A, E>(file: string, seed: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.scoped(seed.pipe(Effect.provide(NodeSqliteClient.layer({ filename: file }))));

const atPath =
  <A, E>(name: string, seed: Effect.Effect<A, E, SqlClient.SqlClient>): Seed =>
  (userdata) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* seedFile(path.join(userdata, name), seed);
    }).pipe(Effect.orDie);

const both =
  (...seeds: ReadonlyArray<Seed>): Seed =>
  (userdata) =>
    Effect.forEach(seeds, (seed) => seed(userdata), { discard: true });

const snapshot = process.env.SATELLITE_UPGRADE_SNAPSHOT;

const CASES: ReadonlyArray<UpgradeCase> = [
  { name: "a fresh install", seed: () => Effect.void, legacyRows: [], fixtureThreads: false },
  {
    name: "a 1.x install at Satellite 55 to 60",
    seed: atPath("state.sqlite", seedSatelliteV1("55-60")),
    legacyRows: LEGACY_55_60,
    fixtureThreads: true,
  },
  {
    name: "a v1.2.x install at Satellite 55 to 62",
    seed: atPath("state.sqlite", seedSatelliteV1("55-62")),
    legacyRows: LEGACY_55_62,
    fixtureThreads: true,
  },
  {
    name: "a dev build's existing statev2.sqlite",
    seed: both(
      atPath("state.sqlite", seedSatelliteV1("55-62")),
      atPath("statev2.sqlite", seedSatelliteDevBuild),
    ),
    legacyRows: LEGACY_DEV_BUILD,
    fixtureThreads: true,
  },
  {
    name: "a database this port already repaired",
    seed: atPath(
      "statev2.sqlite",
      Effect.andThen(seedSatelliteV1("55-60"), runMigrationsWithSatellite()),
    ),
    legacyRows: LEGACY_55_60,
    fixtureThreads: true,
  },
  ...(snapshot === undefined
    ? []
    : [
        {
          name: `the snapshot at ${snapshot}`,
          seed: (userdata: string) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              yield* fs.copyFile(snapshot, path.join(userdata, "state.sqlite"));
            }).pipe(Effect.orDie),
          legacyRows: "source" as const,
          fixtureThreads: false,
        },
      ]),
];

const sha256 = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    if (!(yield* fs.exists(file))) return undefined;
    const digest = yield* crypto.digest("SHA-256", yield* fs.readFile(file));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });

const satelliteRowsIn = Effect.map(readLedger("effect_sql_migrations"), (rows) =>
  (rows ?? []).filter(([id, name]) =>
    SATELLITE_LEGACY_LEDGER_ROWS.some(
      ([legacyId, legacyName]) => legacyId === id && legacyName === name,
    ),
  ),
);

/** What a server start does to the database, short of serving: open it, import, drain. */
const start = Effect.gen(function* () {
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  yield* importer.reconcileShells;
  yield* drainLegacyThreadArchives();
  yield* readAllV2Events;
  const sql = yield* SqlClient.SqlClient;
  return {
    dump: yield* dumpDatabase,
    upstreamLedger: yield* readLedger("effect_sql_migrations"),
    satelliteLedger: yield* readLedger("satellite_migrations"),
    tables: yield* listTables,
    boards: yield* dumpTables(BOARD_TABLES),
    v1Threads: yield* sql<{ readonly thread_id: string }>`SELECT thread_id FROM projection_threads`,
    v2Threads: yield* sql<{
      readonly thread_id: string;
      readonly archived_at: string | null;
      readonly deleted_at: string | null;
    }>`SELECT thread_id, archived_at, deleted_at FROM orchestration_v2_projection_threads`,
  };
});

describe("Satellite ledger upgrade", () => {
  it.live.each(CASES)("upgrades $name and changes nothing on the next start", (upgrade) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "satellite-upgrade-" });
        const userdata = path.join(baseDir, "userdata");
        const v1Path = path.join(userdata, "state.sqlite");
        const v2Path = path.join(userdata, "statev2.sqlite");
        yield* fs.makeDirectory(userdata, { recursive: true });
        yield* upgrade.seed(userdata);

        const sourcePath = (yield* fs.exists(v2Path)) ? v2Path : v1Path;
        const source = (yield* fs.exists(sourcePath))
          ? yield* seedFile(
              sourcePath,
              Effect.all({ boards: dumpTables(BOARD_TABLES), satellite: satelliteRowsIn }),
            )
          : { boards: {}, satellite: [] };
        const v1Hash = yield* sha256(v1Path);

        const first = yield* start.pipe(Effect.provide(layerSatelliteRuntime(baseDir)));

        assert.strictEqual(yield* sha256(v1Path), v1Hash);
        assert.deepStrictEqual(first.upstreamLedger, migrationManifest);
        assert.deepStrictEqual(first.satelliteLedger, [
          ...(upgrade.legacyRows === "source" ? source.satellite : upgrade.legacyRows),
          ...satelliteMigrationEntries.map(([id, name]) => [id, name] as const),
        ]);
        assert.deepStrictEqual(first.boards, source.boards);
        for (const table of SATELLITE_1X_TABLES) assert.notInclude(first.tables, table);
        assert.notInclude(first.tables, "satellite_legacy_thread_archives");
        assert.deepStrictEqual(
          first.v2Threads.map((row) => row.thread_id).toSorted(),
          first.v1Threads.map((row) => row.thread_id).toSorted(),
        );
        if (upgrade.fixtureThreads) {
          const threads = new Map(first.v2Threads.map((row) => [row.thread_id, row]));
          assert.deepStrictEqual(threads.get(THREADS.work), {
            thread_id: THREADS.work,
            archived_at: null,
            deleted_at: null,
          });
          assert.isNotNull(threads.get(THREADS.idea)?.archived_at);
          assert.isNotNull(threads.get(THREADS.revdoc)?.archived_at);
          assert.strictEqual(threads.get(THREADS.archivedIdea)?.archived_at, ARCHIVED_IDEA_AT);
          assert.strictEqual(threads.get(THREADS.deletedRevdoc)?.deleted_at, DELETED_REVDOC_AT);
        }

        const second = yield* start.pipe(Effect.provide(layerSatelliteRuntime(baseDir)));

        assert.deepStrictEqual(second.dump, first.dump);
        assert.strictEqual(yield* sha256(v1Path), v1Hash);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
