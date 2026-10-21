import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Every id and name Satellite recorded in upstream's ledger. 55 IdeaNotebooks is the early Ideas
 * build, 61 and 62 shipped in v1.1.12 to v1.2.1, and 67 to 69 exist only on dev builds since
 * 2026-10-09. No name collides with an upstream migration name.
 */
export const SATELLITE_LEGACY_LEDGER_ROWS = [
  [55, "ManagedDocuments"],
  [55, "IdeaNotebooks"],
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

/** Dev builds recorded upstream's V2 migrations 55 to 58 at 63 to 66, with identical schema. */
const FORK_NUMBERED_UPSTREAM_ROWS = [
  [63, 55, "OrchestrationV2"],
  [64, 56, "RemoveRedundantProjectionIndexes"],
  [65, 57, "ScheduledTaskWebhooks"],
  [66, 58, "WebhookRelayDeliveries"],
] as const;

// Children before parents: foreign keys are enforced. The ten issue_* board tables stay for a
// later Satellite migration.
const ORPHAN_TABLES = [
  "document_placements",
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
  "issue_delivery_peers",
  "issue_peer_grants",
] as const;

const REQUEST_LIFECYCLE_INDEX = "idx_projection_thread_activities_request_lifecycle";

/** Upstream's strict event reads reject these dev-build event types. */
const FORK_V2_EVENT_TYPES = ["idea.changed", "idea.purged"] as const;

export const LEGACY_THREAD_ARCHIVE_QUEUE = "satellite_legacy_thread_archives";

export interface SatelliteLedgerRepair {
  readonly moved: ReadonlyArray<readonly [id: number, name: string]>;
  readonly renumbered: ReadonlyArray<readonly [from: number, to: number, name: string]>;
  readonly droppedTables: ReadonlyArray<string>;
  readonly droppedColumns: ReadonlyArray<string>;
  readonly droppedIndexes: ReadonlyArray<string>;
  readonly archivedV1Threads: number;
  readonly queuedV2Archives: number;
  readonly deletedForkEvents: number;
}

const unchanged: SatelliteLedgerRepair = {
  moved: [],
  renumbered: [],
  droppedTables: [],
  droppedColumns: [],
  droppedIndexes: [],
  archivedV1Threads: 0,
  queuedV2Archives: 0,
  deletedForkEvents: 0,
};

/**
 * Moves Satellite's rows out of upstream's migration ledger and removes the schema of features
 * the port does not carry, so upstream's migrator sees only its own names. Runs before upstream's
 * migrations, in one transaction, and does nothing once the ledger holds no Satellite row.
 */
export const repairSatelliteLegacyLedger = Effect.fn("repairSatelliteLegacyLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ readonly name: string; readonly file: string }>`
    PRAGMA database_list
  `.pipe(Effect.orElseSucceed(() => []));
  const databasePath = databases.find((row) => row.name === "main")?.file;
  const describe = databasePath ? databasePath : "the in-memory database";

  const tableExists = (name: string) =>
    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${name}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  const columnExists = (table: string, column: string) =>
    sql`SELECT 1 FROM pragma_table_info(${table}) WHERE name = ${column}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  const repair = Effect.gen(function* () {
    if (!(yield* tableExists("effect_sql_migrations"))) return unchanged;
    const ledger = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
      readonly created_at: string;
    }>`SELECT migration_id, name, created_at FROM effect_sql_migrations`;
    const isRecorded = (id: number, name: string) =>
      ledger.some((row) => row.migration_id === id && row.name === name);
    const legacy = ledger.filter((row) =>
      SATELLITE_LEGACY_LEDGER_ROWS.some(
        ([id, name]) => row.migration_id === id && row.name === name,
      ),
    );
    const forkNumbered = FORK_NUMBERED_UPSTREAM_ROWS.filter(([from, , name]) =>
      isRecorded(from, name),
    );
    if (legacy.length === 0 && forkNumbered.length === 0) return unchanged;

    // Effect's migrator creates its table with this DDL, so the Satellite migrator adopts it.
    yield* sql`
      CREATE TABLE IF NOT EXISTS satellite_migrations (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )
    `;
    for (const row of legacy) {
      yield* sql`
        INSERT OR IGNORE INTO satellite_migrations (migration_id, name, created_at)
        VALUES (${row.migration_id}, ${row.name}, ${row.created_at})
      `;
      yield* sql`
        DELETE FROM effect_sql_migrations WHERE migration_id = ${row.migration_id} AND name = ${row.name}
      `;
    }

    for (const [from, to, name] of forkNumbered) {
      const occupant = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = ${to}
      `;
      if (occupant[0] !== undefined) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: `Satellite ledger repair cannot move ${from}_${name} to ${to} in ${describe}, because ${to}_${occupant[0].name} holds that id. This migration history is not one Satellite wrote. state.sqlite was not modified.`,
        });
      }
      yield* sql`
        UPDATE effect_sql_migrations SET migration_id = ${to}
        WHERE migration_id = ${from} AND name = ${name}
      `;
    }

    const droppedTables: Array<string> = [];
    for (const table of ORPHAN_TABLES) {
      if (!(yield* tableExists(table))) continue;
      yield* sql`DROP TABLE ${sql(table)}`;
      droppedTables.push(table);
    }

    const droppedIndexes: Array<string> = [];
    const lifecycleIndex = yield* sql`
      SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ${REQUEST_LIFECYCLE_INDEX}
    `;
    if (lifecycleIndex.length > 0) {
      yield* sql`DROP INDEX ${sql(REQUEST_LIFECYCLE_INDEX)}`;
      droppedIndexes.push(REQUEST_LIFECYCLE_INDEX);
    }

    const droppedColumns: Array<string> = [];
    if (yield* columnExists("projection_threads", "commit_recommendation_json")) {
      yield* sql`ALTER TABLE projection_threads DROP COLUMN commit_recommendation_json`;
      droppedColumns.push("projection_threads.commit_recommendation_json");
    }
    let archivedV1Threads = 0;
    if (yield* columnExists("projection_threads", "purpose")) {
      // Upstream's V1 importer carries archived_at, so these arrive in V2 already archived.
      const archived = yield* sql<{ readonly thread_id: string }>`
        UPDATE projection_threads SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE purpose IN ('idea', 'revdoc') AND archived_at IS NULL AND deleted_at IS NULL
        RETURNING thread_id
      `;
      archivedV1Threads = archived.length;
      yield* sql`DROP INDEX IF EXISTS projection_threads_purpose`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN purpose`;
      droppedColumns.push("projection_threads.purpose");
    }

    let deletedForkEvents = 0;
    if (yield* columnExists("orchestration_events", "application_event_version")) {
      const deleted = yield* sql<{ readonly event_id: string }>`
        DELETE FROM orchestration_events
        WHERE application_event_version = 2 AND ${sql.in("event_type", FORK_V2_EVENT_TYPES)}
        RETURNING event_id
      `;
      deletedForkEvents = deleted.length;
    }

    let queuedV2Archives = 0;
    if (yield* tableExists("orchestration_v2_projection_threads")) {
      // Archived after startup through upstream's thread lifecycle service, so events and
      // projections agree. See drainLegacyThreadArchives.
      const threads = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE json_extract(payload_json, '$.purpose') IN ('idea', 'revdoc')
          AND archived_at IS NULL AND deleted_at IS NULL
      `;
      if (threads.length > 0) {
        yield* sql`
          CREATE TABLE IF NOT EXISTS ${sql(LEGACY_THREAD_ARCHIVE_QUEUE)} (
            thread_id TEXT PRIMARY KEY NOT NULL
          )
        `;
        for (const thread of threads) {
          yield* sql`
            INSERT OR IGNORE INTO ${sql(LEGACY_THREAD_ARCHIVE_QUEUE)} (thread_id)
            VALUES (${thread.thread_id})
          `;
        }
        queuedV2Archives = threads.length;
      }
    }

    return {
      moved: legacy.map((row) => [row.migration_id, row.name] as const),
      renumbered: forkNumbered,
      droppedTables,
      droppedColumns,
      droppedIndexes,
      archivedV1Threads,
      queuedV2Archives,
      deletedForkEvents,
    } satisfies SatelliteLedgerRepair;
  });

  const outcome = yield* sql.withTransaction(repair).pipe(
    Effect.mapError((cause) =>
      cause._tag === "MigrationError"
        ? cause
        : new Migrator.MigrationError({
            kind: "Failed",
            cause,
            message: `Satellite ledger repair failed on ${describe} and was rolled back. state.sqlite was not modified.`,
          }),
    ),
  );
  yield* outcome === unchanged
    ? Effect.logDebug("Satellite ledger needs no repair")
    : Effect.logInfo("Repaired Satellite migration ledger").pipe(
        Effect.annotateLogs({ ...outcome }),
      );
  return outcome;
});
