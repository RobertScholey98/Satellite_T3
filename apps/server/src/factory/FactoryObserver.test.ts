import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, FactoryError, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as FactoryObserver from "./FactoryObserver.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryStore from "./FactoryStore.ts";

const layerStores = Layer.merge(
  FactoryStore.layer,
  EventSink.layer.pipe(
    Layer.provideMerge(EventStore.layer),
    Layer.provideMerge(ProjectionStore.layer),
  ),
);

// Control the acknowledgement boundary while retaining the real stream and
// transactional cursor. Guidance interpretation is tested through FactoryService.
const layerObserver = (
  observe: FactoryService.FactoryService["Service"]["observe"],
  drain: Effect.Effect<void> = Effect.void,
) =>
  FactoryObserver.layer.pipe(
    Layer.provide(Layer.mock(FactoryService.FactoryService)({ observe, drain })),
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

it.effect(
  "observes replay and live events sequentially and drains only after committed progress",
  () =>
    Effect.gen(function* () {
      const store = yield* FactoryStore.FactoryStore;
      const sink = yield* EventSink.EventSinkV2;
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
          assert.equal(yield* store.observationCursor, 0);
          assert.equal(yield* Ref.get(drains), 0);
          yield* writeThread("third");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(draining);
          yield* observer.drain;
          assert.deepStrictEqual(yield* Ref.get(observed), [1, 2, 3]);
          assert.equal(yield* store.observationCursor, yield* sink.latestSequence());
          assert.equal(yield* Ref.get(drains), 2);
        }).pipe(
          Effect.provide(
            layerObserver(
              (event) =>
                Effect.gen(function* () {
                  if (event.sequence === 1) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                  yield* store.observe({
                    sequence: event.sequence,
                    now: DateTime.formatIso(event.event.occurredAt),
                  });
                  yield* Ref.update(observed, (current) => [...current, event.sequence]);
                }),
              Ref.update(drains, (count) => count + 1),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(layerStores.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect(
  "reopens the database after a lost acknowledgement and resumes strictly after the committed cursor",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "factory-observer-recovery-" });
      const filename = path.join(directory, "state.sqlite");
      const seen = yield* Ref.make<number[]>([]);
      const reopen = layerStores.pipe(Layer.provide(SqlitePersistence.layerFromPath(filename)));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* FactoryStore.FactoryStore;
          yield* writeThread("before-crash");
          yield* writeThread("lost-acknowledgement");
          yield* writeThread("after-crash");
          yield* Effect.gen(function* () {
            const observer = yield* FactoryObserver.FactoryObserver;
            const result = yield* observer.drain.pipe(Effect.result);
            assert.equal(Result.isFailure(result), true);
            if (Result.isFailure(result)) assert.equal(result.failure._tag, "FactoryObserverError");
            assert.equal(yield* store.observationCursor, 2);
            assert.deepStrictEqual(yield* Ref.get(seen), [1, 2]);
          }).pipe(
            Effect.provide(
              layerObserver((event) =>
                Effect.gen(function* () {
                  yield* store.observe({
                    sequence: event.sequence,
                    now: DateTime.formatIso(event.event.occurredAt),
                  });
                  yield* Ref.update(seen, (current) => [...current, event.sequence]);
                  if (event.sequence === 2) return yield* new FactoryError({ code: "persistence" });
                }),
              ),
            ),
          );
        }).pipe(Effect.provide(Layer.fresh(reopen))),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* FactoryStore.FactoryStore;
          assert.equal(yield* store.observationCursor, 2);
          yield* Effect.gen(function* () {
            const observer = yield* FactoryObserver.FactoryObserver;
            yield* observer.drain;
            assert.equal(yield* store.observationCursor, 3);
            yield* writeThread("new-live-event");
            yield* observer.drain;
            assert.deepStrictEqual(yield* Ref.get(seen), [1, 2, 3, 4]);
          }).pipe(
            Effect.provide(
              layerObserver((event) =>
                store
                  .observe({
                    sequence: event.sequence,
                    now: DateTime.formatIso(event.event.occurredAt),
                  })
                  .pipe(
                    Effect.andThen(Ref.update(seen, (current) => [...current, event.sequence])),
                  ),
              ),
            ),
          );
        }).pipe(Effect.provide(Layer.fresh(reopen))),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* FactoryStore.FactoryStore;
          assert.equal(yield* store.observationCursor, 4);
          yield* Effect.gen(function* () {
            yield* (yield* FactoryObserver.FactoryObserver).drain;
            assert.deepStrictEqual(yield* Ref.get(seen), [1, 2, 3, 4]);
          }).pipe(
            Effect.provide(layerObserver(() => Effect.die("Acknowledged events must not replay."))),
          );
        }).pipe(Effect.provide(Layer.fresh(reopen))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
