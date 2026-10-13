import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryError,
  FactorySnapshot,
  type FactoryDecisionCommand,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "../persistence/Migrations/067_EngineeringFactory.ts";
import observationMigration from "../persistence/Migrations/069_FactoryObservation.ts";
import { deliveryIds, deliveryNow, reviewedDeliveryFixture } from "./FactoryDelivery.testkit.ts";
import * as FactoryPreviewEvidence from "./FactoryPreviewEvidence.ts";
import * as FactoryPreviewExecution from "./FactoryPreviewExecution.ts";
import * as Preview from "./FactoryPreviewService.ts";
import * as Store from "./FactoryStore.ts";

const initial = (): FactorySnapshot => {
  const state = reviewedDeliveryFixture();
  return {
    ...state,
    previewConfigurations: [
      {
        id: "app-config",
        projectId: deliveryIds.project,
        approvedAt: deliveryNow,
        authorizingCommandId: CommandId.make("app-approved"),
        configuration: {
          imageId: `sha256:${"a".repeat(64)}`,
          executable: "/usr/local/bin/node",
          args: ["/workspace/app.cjs"],
          port: 8080,
          data: "ephemeral",
        },
      },
    ],
    auxiliaryThreads: state.auxiliaryThreads.map((entry) => ({ ...entry, status: "running" })),
    assignments: state.assignments.map((entry) => ({
      ...entry,
      delivery: {
        ...entry.delivery!,
        revisions: entry.delivery!.revisions.map((revision) => ({
          ...revision,
          reviews: revision.reviews.map((review) => ({ ...review, status: "running" })),
        })),
      },
    })),
  };
};
const base = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(FactorySnapshot));
const setup = Effect.gen(function* () {
  yield* migration;
  yield* observationMigration;
  const state = initial();
  const sql = yield* SqlClient.SqlClient;
  const encoded = yield* encodeSnapshot(state);
  yield* sql`INSERT INTO factory_state(id,revision,payload_json) VALUES(1,${state.revision},${encoded})`;
  const store = Context.get(yield* Layer.build(Store.layer), Store.FactoryStore);
  const events: string[] = [];
  let hold = false;
  let closeFails = false;
  let startFails = false;
  let stopFails = false;
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let instance: FactoryPreviewExecution.FactoryPreviewInstance | undefined;
  const services = Preview.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(FactoryPreviewExecution.FactoryPreviewExecution)({
          start: (input) =>
            Effect.gen(function* () {
              events.push("start");
              yield* Deferred.succeed(entered, undefined);
              if (startFails) return yield* new FactoryError({ code: "execution-unavailable" });
              if (hold) yield* Deferred.await(release);
              instance = {
                ...input,
                id: input.instanceId,
                candidateDigest: "digest",
                revisionId: "revision:command",
                configuration: state.previewConfigurations[0]!.configuration,
                imageId: `sha256:${"a".repeat(64)}`,
                dockerContext: "test",
                containerName: "app",
                relayName: "relay",
                networkName: "isolated",
                origin: "http://127.0.0.1:41000",
                status: "ready",
                createdAt: deliveryNow,
              };
              return instance;
            }),
          stop: () =>
            Effect.gen(function* () {
              events.push("stop");
              if (stopFails) return yield* new FactoryError({ code: "execution-unavailable" });
              instance = instance ? { ...instance, status: "stopped" } : undefined;
              return instance;
            }),
        }),
        Layer.mock(FactoryPreviewEvidence.FactoryPreviewEvidence)({
          close: () =>
            Effect.gen(function* () {
              events.push("close");
              if (closeFails) return yield* new FactoryError({ code: "execution-unavailable" });
            }),
        }),
      ),
    ),
  );
  const service = yield* Preview.FactoryPreviewService.pipe(
    Effect.provide(services.pipe(Layer.provide(Layer.succeed(Store.FactoryStore, store)))),
  );
  const commit = (command: FactoryDecisionCommand) =>
    store.commit({ actor: { kind: "human" }, command, now: deliveryNow });
  yield* commit({
    type: "delivery.preview.start",
    commandId: CommandId.make("preview-start"),
    assignmentId: deliveryIds.assignment,
    revisionId: "revision:command",
    reviewId: "review:command",
    configurationId: "app-config",
  });
  const pending = (yield* store.pending).find(
    (entry) => entry.intent.type === "delivery.preview.start",
  )!;
  return {
    store,
    service,
    commit,
    pending,
    events,
    entered,
    release,
    hold: () => {
      hold = true;
    },
    failClose: () => {
      closeFails = true;
    },
    failStart: () => {
      startFails = true;
    },
    failStop: (value: boolean) => {
      stopFails = value;
    },
    preview: store.snapshot.pipe(
      Effect.map((value) => value.assignments[0]!.delivery!.revisions[0]!.preview!),
    ),
  };
});

it.effect(
  "closes the review browser and app after a completed review and preserves its durable receipt",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.service.handle(f.pending);
      assert.equal((yield* f.preview).status, "ready");
      yield* f.store.commit({
        actor: { kind: "thread", threadId: deliveryIds.reviewer },
        now: deliveryNow,
        command: {
          type: "delivery.review.report",
          commandId: CommandId.make("review-done"),
          assignmentId: deliveryIds.assignment,
          revisionId: "revision:command",
          reviewId: "review:command",
          verdict: "passed",
          confirmsImpact: true,
          findings: "The candidate behaves as expected",
          evidence: [{ label: "journey", location: "sealed-evidence" }],
        },
      });
      yield* f.service.reconcile;
      assert.deepEqual(f.events, ["start", "close", "stop"]);
      assert.equal((yield* f.preview).status, "stopped");
      yield* f.service.reconcile;
      assert.equal(f.events.length, 3);
    }).pipe(Effect.provide(base)),
);

it.effect.each(["pause", "stop"] as const)(
  "revokes an in-flight startup on %s without announcing a ready app",
  (action) =>
    Effect.gen(function* () {
      const f = yield* setup;
      f.hold();
      const running = yield* f.service.handle(f.pending).pipe(Effect.forkChild);
      yield* Deferred.await(f.entered);
      yield* f.commit(
        action === "pause"
          ? {
              type: "project.pause",
              commandId: CommandId.make("pause"),
              projectId: deliveryIds.project,
            }
          : {
              type: "delivery.preview.stop",
              commandId: CommandId.make("stop-preview"),
              assignmentId: deliveryIds.assignment,
              revisionId: "revision:command",
              instanceId: "preview:preview-start",
            },
      );
      const stale = yield* f.store
        .commit({
          actor: { kind: "system" },
          now: deliveryNow,
          command: {
            type: "delivery.preview.recorded",
            commandId: CommandId.make("stale-ready"),
            assignmentId: deliveryIds.assignment,
            revisionId: "revision:command",
            instanceId: "preview:preview-start",
            status: "ready",
            origin: "http://127.0.0.1:41000",
          },
        })
        .pipe(Effect.flip);
      assert.equal(stale.code, "stale-revision");
      yield* Deferred.succeed(f.release, undefined);
      yield* Fiber.join(running);
      assert.equal((yield* f.preview).status, "stopped");
      assert.deepEqual(f.events, ["start", "close", "stop"]);
      assert.isFalse(
        (yield* f.store.pending).some(
          (entry) =>
            entry.intent.type === "thread.deliver" && entry.intent.text.includes("is ready"),
        ),
      );
    }).pipe(Effect.provide(base)),
);

it.effect("stops the container even if browser closure fails and leaves shutdown retryable", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.service.handle(f.pending);
    yield* f.commit({
      type: "project.pause",
      commandId: CommandId.make("pause"),
      projectId: deliveryIds.project,
    });
    f.failClose();
    yield* f.service.reconcile.pipe(Effect.flip);
    assert.deepEqual(f.events, ["start", "close", "stop"]);
    assert.equal((yield* f.preview).status, "ready");
  }).pipe(Effect.provide(base)),
);

it.effect("keeps a team's preview running while its manager's coordination is paused", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.service.handle(f.pending);
    yield* f.commit({
      type: "manager.pause",
      commandId: CommandId.make("pause-manager"),
      managerId: deliveryIds.manager,
    });
    yield* f.service.reconcile;
    assert.equal((yield* f.preview).status, "ready");
    assert.deepEqual(f.events, ["start"]);
  }).pipe(Effect.provide(base)),
);

it.effect("cleans up a failed start whose own cleanup failed before another start is allowed", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    f.failStart();
    f.failStop(true);
    yield* f.service.handle(f.pending);
    assert.equal((yield* f.preview).status, "failed");
    const restart = {
      type: "delivery.preview.start" as const,
      commandId: CommandId.make("preview-restart"),
      assignmentId: deliveryIds.assignment,
      revisionId: "revision:command",
      reviewId: "review:command",
      configurationId: "app-config",
    };
    yield* f.commit(restart).pipe(Effect.flip);
    yield* f.service.reconcile.pipe(Effect.flip);
    assert.equal((yield* f.preview).status, "failed");
    f.failStop(false);
    yield* f.service.reconcile;
    assert.equal((yield* f.preview).status, "stopped");
    assert.deepEqual(f.events, ["start", "close", "stop", "close", "stop"]);
    yield* f.commit(restart);
    assert.equal((yield* f.preview).instanceId, "preview:preview-restart");
  }).pipe(Effect.provide(base)),
);

it.effect("stops a preview on request while its project is paused", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.service.handle(f.pending);
    yield* f.commit({
      type: "delivery.preview.stop",
      commandId: CommandId.make("stop-preview"),
      assignmentId: deliveryIds.assignment,
      revisionId: "revision:command",
      instanceId: "preview:preview-start",
    });
    yield* f.commit({
      type: "project.pause",
      commandId: CommandId.make("pause"),
      projectId: deliveryIds.project,
    });
    const stopping = (yield* f.store.pending).find(
      (entry) => entry.intent.type === "delivery.preview.stop",
    )!;
    yield* f.service.handle(stopping);
    assert.equal((yield* f.preview).status, "stopped");
    assert.isFalse((yield* f.store.pending).some((entry) => entry.id === stopping.id));
  }).pipe(Effect.provide(base)),
);
