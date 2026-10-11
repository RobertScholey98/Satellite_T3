import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  FactoryError,
  FactorySnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { deliveryFixture } from "./FactoryDelivery.testkit.ts";
import * as FactoryObserver from "./FactoryObserver.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryStore from "./FactoryStore.ts";

const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const layerStores = Layer.merge(
  FactoryStore.layer,
  EventSink.layer.pipe(
    Layer.provideMerge(EventStore.layer),
    Layer.provideMerge(ProjectionStore.layer),
  ),
);
// Seeds a managed factory before the store loads, so observation is not skipped.
const seedManaged = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR IGNORE INTO factory_state (id, revision, payload_json)
      VALUES (1, 0, ${encodeSnapshot(deliveryFixture())})`;
  }),
);
const managedStores = <E, R>(persistence: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  layerStores.pipe(Layer.provide(seedManaged), Layer.provideMerge(persistence));
const setCursor = (sequence: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO factory_observers (name, sequence) VALUES ('orchestration', ${sequence})
      ON CONFLICT(name) DO UPDATE SET sequence = excluded.sequence`;
  });
const acknowledge = (store: FactoryStore.FactoryStore["Service"], sequence: number) =>
  store.observe({ sequence, now: "2026-10-11T00:00:00.000Z" });

// Control the acknowledgement boundary while retaining the real stream and
// transactional cursor. Guidance interpretation is tested through FactoryService.
const layerObserver = (
  observe: FactoryService.FactoryService["Service"]["observe"],
  drain: Effect.Effect<void> = Effect.void,
) =>
  FactoryObserver.layer.pipe(
    Layer.provide(
      Layer.mock(FactoryService.FactoryService)({ observe, drain, recover: Effect.void }),
    ),
  );

const writeThread = Effect.fn("FactoryObserver.test.writeThread")(function* (name: string) {
  const events = yield* EventSink.EventSinkV2;
  const threadId = ThreadId.make(name);
  const now = yield* DateTime.now;
  return yield* events.write({
    events: [
      {
        id: EventId.make(`create:${name}`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("observer-project"),
          title: name,
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      },
    ],
  });
});

it.effect("starts at the current high-water mark instead of replaying history", () =>
  Effect.gen(function* () {
    yield* writeThread("history-one");
    yield* writeThread("history-two");
    const observed = yield* Ref.make<number[]>([]);
    yield* Effect.gen(function* () {
      const observer = yield* FactoryObserver.FactoryObserver;
      yield* observer.drain;
      assert.deepStrictEqual(yield* Ref.get(observed), []);
      yield* writeThread("live");
      yield* observer.drain;
      assert.deepStrictEqual(yield* Ref.get(observed), [3]);
    }).pipe(
      Effect.provide(
        layerObserver((event) => Ref.update(observed, (current) => [...current, event.sequence])),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(managedStores(SqlitePersistence.layerMemory))),
);

it.effect("skips observation and cursor writes while no manager exists", () =>
  Effect.gen(function* () {
    const store = yield* FactoryStore.FactoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* writeThread("history");
    yield* Effect.gen(function* () {
      const observer = yield* FactoryObserver.FactoryObserver;
      yield* writeThread("live-one");
      yield* writeThread("live-two");
      yield* observer.drain;
    }).pipe(
      Effect.provide(layerObserver(() => Effect.die("Unmanaged installs observe nothing."))),
      Effect.scoped,
    );
    assert.equal(yield* store.observationCursor, 0);
    assert.deepStrictEqual(yield* sql`SELECT name FROM factory_observers`, []);
  }).pipe(Effect.provide(layerStores.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))),
);

it.effect(
  "observes replay and live events sequentially and drains only after committed progress",
  () =>
    Effect.gen(function* () {
      const store = yield* FactoryStore.FactoryStore;
      const sink = yield* EventSink.EventSinkV2;
      yield* writeThread("acknowledged");
      yield* setCursor(1);
      yield* writeThread("first");
      yield* writeThread("second");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const observed = yield* Ref.make<number[]>([]);
      const drains = yield* Ref.make(0);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const observer = yield* FactoryObserver.FactoryObserver;
          const draining = yield* observer.drain.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(entered);
          assert.equal(yield* store.observationCursor, 1);
          assert.equal(yield* Ref.get(drains), 0);
          yield* writeThread("third");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(draining);
          yield* observer.drain;
          assert.deepStrictEqual(yield* Ref.get(observed), [2, 3, 4]);
          assert.equal(yield* store.observationCursor, yield* sink.latestSequence());
          assert.equal(yield* Ref.get(drains), 2);
        }).pipe(
          Effect.provide(
            layerObserver(
              (event) =>
                Effect.gen(function* () {
                  if (event.sequence === 2) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                  yield* acknowledge(store, event.sequence);
                  yield* Ref.update(observed, (current) => [...current, event.sequence]);
                }),
              Ref.update(drains, (count) => count + 1),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(managedStores(SqlitePersistence.layerMemory))),
);

it.effect(
  "continues past a failed event and replays uncommanded events after the persisted cursor",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "factory-observer-recovery-" });
      const reopen = managedStores(
        SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")),
      );
      const seen = yield* Ref.make<number[]>([]);
      const record = (store: FactoryStore.FactoryStore["Service"], sequence: number) =>
        acknowledge(store, sequence).pipe(
          Effect.andThen(Ref.update(seen, (current) => [...current, sequence])),
        );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* FactoryStore.FactoryStore;
          yield* writeThread("acknowledged");
          yield* setCursor(1);
          yield* writeThread("before-failure");
          yield* writeThread("failure");
          yield* writeThread("after-failure");
          yield* Effect.gen(function* () {
            yield* (yield* FactoryObserver.FactoryObserver).drain;
            assert.deepStrictEqual(yield* Ref.get(seen), [2, 3, 4]);
            assert.equal(yield* store.observationCursor, 4);
          }).pipe(
            Effect.provide(
              layerObserver((event) =>
                record(store, event.sequence).pipe(
                  Effect.andThen(
                    event.sequence === 3
                      ? Effect.fail(new FactoryError({ code: "persistence" }))
                      : Effect.void,
                  ),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(Layer.fresh(reopen))),
      );

      yield* Ref.set(seen, []);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* FactoryStore.FactoryStore;
          // Uncommanded observations are persisted in batches, so a restart replays them.
          assert.equal(yield* store.observationCursor, 1);
          yield* Effect.gen(function* () {
            const observer = yield* FactoryObserver.FactoryObserver;
            yield* observer.drain;
            yield* writeThread("new-live-event");
            yield* observer.drain;
            assert.deepStrictEqual(yield* Ref.get(seen), [2, 3, 4, 5]);
          }).pipe(Effect.provide(layerObserver((event) => record(store, event.sequence))));
        }).pipe(Effect.provide(Layer.fresh(reopen))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
