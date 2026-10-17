import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLifecycleService from "../../orchestration-v2/ThreadLifecycleService.ts";
import { drainLegacyThreadArchives } from "./drainLegacyThreadArchives.ts";
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

const isOpen = (threadId: string) =>
  Effect.map(v2ThreadStates, (rows) =>
    rows.some((row) => row.thread_id === threadId && row.archived_at === null),
  );

it.live("archives queued dev-build threads through upstream's archive command once", () =>
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

      yield* Effect.gen(function* () {
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
      }).pipe(Effect.provide(layerSatelliteRuntime(baseDir)));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
