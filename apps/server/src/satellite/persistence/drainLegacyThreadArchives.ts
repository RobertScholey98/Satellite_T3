import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ThreadLifecycleService from "../../orchestration-v2/ThreadLifecycleService.ts";
import { LEGACY_THREAD_ARCHIVE_QUEUE } from "../../persistence/Migrations/satellite/repairSatelliteLegacyLedger.ts";
import * as ServerLifecycleEvents from "../../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";

/**
 * Archives the dev-build Idea and Revdoc threads the ledger repair queued, through upstream's
 * archive command so events and projections agree. Only the one-time repair fills the queue, so a
 * thread the user unarchives later is never archived again. Returns how many it archived.
 */
export const drainLegacyThreadArchives = Effect.fn("drainLegacyThreadArchives")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lifecycle = yield* ThreadLifecycleService.ThreadLifecycleService;
  const queue = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${LEGACY_THREAD_ARCHIVE_QUEUE}
  `;
  if (queue.length === 0) return 0;

  const queued = yield* sql<{ readonly thread_id: string; readonly open: number }>`
    SELECT queued.thread_id,
      COALESCE(thread.archived_at IS NULL AND thread.deleted_at IS NULL, 0) AS open
    FROM ${sql(LEGACY_THREAD_ARCHIVE_QUEUE)} AS queued
    LEFT JOIN orchestration_v2_projection_threads AS thread USING (thread_id)
    ORDER BY queued.thread_id
  `;
  let archived = 0;
  for (const row of queued) {
    if (row.open) {
      // A fixed command id lets upstream's command receipts absorb a repeat after a crash.
      const result = yield* lifecycle
        .archive({
          commandId: CommandId.make(`satellite:legacy-archive:${row.thread_id}`),
          threadId: ThreadId.make(row.thread_id),
        })
        .pipe(Effect.result);
      if (result._tag === "Failure") {
        yield* Effect.logWarning("Could not archive a legacy Satellite thread", {
          threadId: row.thread_id,
          cause: result.failure,
        });
        continue;
      }
      archived += 1;
    }
    yield* sql`DELETE FROM ${sql(LEGACY_THREAD_ARCHIVE_QUEUE)} WHERE thread_id = ${row.thread_id}`;
  }

  const remaining = yield* sql`SELECT 1 FROM ${sql(LEGACY_THREAD_ARCHIVE_QUEUE)} LIMIT 1`;
  if (remaining.length === 0) yield* sql`DROP TABLE ${sql(LEGACY_THREAD_ARCHIVE_QUEUE)}`;
  if (archived > 0) {
    yield* Effect.logInfo("Archived legacy Satellite Idea and Revdoc threads", { archived });
  }
  return archived;
});

/** Waits for the lifecycle `ready` event, which upstream publishes once startup is complete. */
const awaitServerReady = Effect.gen(function* () {
  const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
  // Subscribe before reading the snapshot so a `ready` published in between is not missed.
  const nextReady = yield* lifecycle.stream.pipe(
    Stream.filter((event) => event.type === "ready"),
    Stream.runHead,
    Effect.forkScoped({ startImmediately: true }),
  );
  const { events } = yield* lifecycle.snapshot;
  if (events.some((event) => event.type === "ready")) return;
  yield* Fiber.join(nextReady);
}).pipe(Effect.scoped);

/**
 * Runs the drain after upstream accepts commands and reports ready, then waits `settle` more,
 * because startup output and the first client syncs still run just after ready. The archive
 * commands then neither interleave with legacy import and recovery nor delay readiness.
 */
export const drainLegacyThreadArchivesAfterStartup = (settle: Duration.Input = "1 second") =>
  Effect.gen(function* () {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    yield* startup.awaitCommandReady;
    yield* awaitServerReady;
    yield* Effect.sleep(settle);
    return yield* drainLegacyThreadArchives();
  });
