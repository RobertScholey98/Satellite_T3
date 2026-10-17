import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, type ServerLifecycleStreamEvent, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLifecycleService from "../../orchestration-v2/ThreadLifecycleService.ts";
import * as ServerLifecycleEvents from "../../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import {
  drainLegacyThreadArchives,
  drainLegacyThreadArchivesAfterStartup,
} from "./drainLegacyThreadArchives.ts";
import {
  layerSatelliteRuntime,
  listTables,
  seedSatelliteDevBuild,
  THREADS,
  v2ThreadStates,
} from "./testing/satelliteLegacyFixtures.test.helpers.ts";

const archivedEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly stream_id: string }>`
    SELECT stream_id FROM orchestration_events
    WHERE application_event_version = 2 AND event_type = 'thread.archived'
    ORDER BY stream_id
  `;
  return rows.map((row) => row.stream_id);
});

const withDevBuild = <A, E, R>(test: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "satellite-drain-" });
      yield* fs.makeDirectory(path.join(baseDir, "userdata"));
      const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
      yield* seedSatelliteDevBuild.pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
      );
      return yield* test.pipe(Effect.provide(layerSatelliteRuntime(baseDir)));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const isOpen = (threadId: string) =>
  Effect.map(v2ThreadStates, (rows) =>
    rows.some((row) => row.thread_id === threadId && row.archived_at === null),
  );

it.live("archives queued dev-build threads through upstream's archive command once", () =>
  withDevBuild(
    Effect.gen(function* () {
      assert.include(yield* listTables, "satellite_legacy_thread_archives");
      assert.deepStrictEqual(yield* archivedEvents, []);

      assert.strictEqual(yield* drainLegacyThreadArchives(), 2);

      assert.deepStrictEqual(yield* archivedEvents, [THREADS.idea, THREADS.revdoc]);
      assert.isFalse(yield* isOpen(THREADS.idea));
      assert.isFalse(yield* isOpen(THREADS.revdoc));
      assert.isTrue(yield* isOpen(THREADS.work));
      assert.notInclude(yield* listTables, "satellite_legacy_thread_archives");
      assert.strictEqual(yield* drainLegacyThreadArchives(), 0);

      const lifecycle = yield* ThreadLifecycleService.ThreadLifecycleService;
      yield* lifecycle.unarchive({
        commandId: CommandId.make("test:unarchive-idea"),
        threadId: ThreadId.make(THREADS.idea),
      });
      assert.strictEqual(yield* drainLegacyThreadArchives(), 0);
      assert.isTrue(yield* isOpen(THREADS.idea));
    }),
  ),
);

it.live("archives nothing until upstream accepts commands and reports ready", () =>
  withDevBuild(
    Effect.gen(function* () {
      const commandGateAwaited = yield* Deferred.make<void>();
      const commandGate = yield* Deferred.make<void>();
      const readinessChecked = yield* Deferred.make<void>();
      const lifecycleEvents = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
      const published = yield* Ref.make<ReadonlyArray<ServerLifecycleStreamEvent>>([]);
      // Only the event type is read.
      const ready = { version: 1, type: "ready", sequence: 1 } as ServerLifecycleStreamEvent;

      const drain = yield* drainLegacyThreadArchivesAfterStartup(Duration.zero).pipe(
        Effect.provideService(
          ServerRuntimeStartup.ServerRuntimeStartup,
          ServerRuntimeStartup.ServerRuntimeStartup.of({
            awaitCommandReady: Deferred.succeed(commandGateAwaited, undefined).pipe(
              Effect.andThen(Deferred.await(commandGate)),
            ),
            markHttpListening: Effect.void,
            enqueueCommand: (effect) => effect,
          }),
        ),
        Effect.provideService(
          ServerLifecycleEvents.ServerLifecycleEvents,
          ServerLifecycleEvents.ServerLifecycleEvents.of({
            publish: () => Effect.die("unused"),
            snapshot: Ref.get(published).pipe(
              Effect.map((events) => ({ sequence: events.length, events })),
              Effect.tap(() => Deferred.succeed(readinessChecked, undefined)),
            ),
            stream: Stream.fromPubSub(lifecycleEvents),
          }),
        ),
        Effect.forkScoped,
      );

      yield* Deferred.await(commandGateAwaited);
      assert.deepStrictEqual(yield* archivedEvents, []);

      yield* Deferred.succeed(commandGate, undefined);
      yield* Deferred.await(readinessChecked);
      assert.deepStrictEqual(yield* archivedEvents, []);
      assert.include(yield* listTables, "satellite_legacy_thread_archives");

      yield* Ref.set(published, [ready]);
      yield* PubSub.publish(lifecycleEvents, ready);
      assert.strictEqual(yield* Fiber.join(drain), 2);
      assert.deepStrictEqual(yield* archivedEvents, [THREADS.idea, THREADS.revdoc]);
    }),
  ),
);
