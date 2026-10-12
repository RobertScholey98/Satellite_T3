import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryError,
  FactorySnapshot,
  ThreadId,
  type FactoryPreviewAction,
  type PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import migration from "../persistence/Migrations/067_EngineeringFactory.ts";
import observationMigration from "../persistence/Migrations/069_FactoryObservation.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import { deliveryIds, deliveryNow, reviewedDeliveryFixture } from "./FactoryDelivery.testkit.ts";
import * as FactoryStore from "./FactoryStore.ts";
import * as FactoryPreviewExecution from "./FactoryPreviewExecution.ts";
import * as Evidence from "./FactoryPreviewEvidence.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4n8AAAAASUVORK5CYII=";
const instance: FactoryPreviewExecution.FactoryPreviewInstance = {
  id: "app-instance",
  assignmentId: deliveryIds.assignment,
  candidateId: "candidate",
  candidateDigest: "digest",
  revisionId: "revision:command",
  reviewThreadId: deliveryIds.reviewer,
  configurationId: "app-config",
  configuration: {
    imageId: "sha256:image",
    executable: "/usr/local/bin/node",
    args: ["/workspace/app.cjs"],
    port: 8080,
    data: "ephemeral",
  },
  expectedEpoch: 1,
  imageId: "sha256:image",
  dockerContext: "test",
  containerName: "container",
  relayName: "relay",
  networkName: "network",
  containerId: "actual-container",
  origin: "http://127.0.0.1:40123",
  status: "ready",
  createdAt: deliveryNow,
};
const initial = (): FactorySnapshot => {
  const state = reviewedDeliveryFixture();
  return {
    ...state,
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
const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const base = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  ServerConfig.layerTest(process.cwd(), { prefix: "factory-preview-evidence-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
const setup = Effect.gen(function* () {
  yield* migration;
  yield* observationMigration;
  const sql = yield* SqlClient.SqlClient;
  let state = initial();
  yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,0,${encode(state)})`;
  const calls: Array<Parameters<ServerBrowser.ServerBrowser["Service"]["invokeRestricted"]>[0]> =
    [];
  let runtimeInstance = instance;
  let blocked = false;
  let hold = false;
  const entered = yield* Deferred.make<void>();
  const snapshot: PreviewAutomationSnapshot = {
    url: instance.origin!,
    title: "App",
    loading: false,
    visibleText: "Task saved",
    interactiveElements: [],
    accessibilityTree: '- button "Save"',
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    screenshot: { mimeType: "image/png", data: png, width: 1, height: 1 },
  };
  const ports = Layer.mergeAll(
    Layer.mock(FactoryPreviewExecution.FactoryPreviewExecution)({
      get: () => Effect.sync(() => runtimeInstance),
    }),
    Layer.mock(FactoryControlAccess.FactoryControlAccess)({
      assertExecution: () =>
        blocked ? Effect.fail(new FactoryError({ code: "permission-denied" })) : Effect.void,
    }),
    Layer.mock(ServerBrowser.ServerBrowser)({
      invokeRestricted: (input) =>
        Effect.gen(function* () {
          calls.push(input);
          if (hold) {
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }
          return input.operation === "snapshot" ? snapshot : null;
        }),
      closeRestricted: () => Effect.void,
    }),
  );
  const services = Evidence.layer.pipe(Layer.provide(ports), Layer.provide(FactoryStore.layer));
  const reopen = Evidence.FactoryPreviewEvidence.pipe(Effect.provide(Layer.fresh(services)));
  const service = yield* reopen;
  const action = (id: string, value: FactoryPreviewAction, threadId = deliveryIds.reviewer) =>
    service.invoke({
      commandId: CommandId.make(id),
      instanceId: instance.id,
      journey: "Save task",
      action: value,
      threadId,
    });
  const finish = () =>
    service.finish({
      commandId: CommandId.make("finish"),
      instanceId: instance.id,
      threadId: deliveryIds.reviewer,
      journeys: ["Save task"],
    });
  const completeJourney = Effect.gen(function* () {
    yield* action("navigate", { type: "navigate", path: "/tasks" });
    yield* action("inspect", { type: "snapshot" });
    yield* action("click", { type: "click", input: { locator: "role=button[name=Save]" } });
    yield* action("result", { type: "snapshot" });
  });
  return {
    service,
    reopen,
    action,
    finish,
    completeJourney,
    calls,
    entered,
    hold: () => {
      hold = true;
    },
    block: () => {
      blocked = true;
    },
    stop: () => {
      runtimeInstance = { ...instance, status: "stopped" };
    },
    replaceInstance: (changes: Partial<FactoryPreviewExecution.FactoryPreviewInstance>) => {
      runtimeInstance = { ...instance, ...changes };
    },
    retire: Effect.gen(function* () {
      state = {
        ...state,
        auxiliaryThreads: state.auxiliaryThreads.map((entry) => ({ ...entry, status: "complete" })),
      };
      yield* sql`UPDATE factory_state SET payload_json=${encode(state)} WHERE id=1`;
    }),
  };
});

it.effect(
  "seals actual browser receipts and PNGs across service recreation without replaying actions",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* fixture.finish().pipe(Effect.flip);
      yield* fixture.completeJourney;
      assert.equal(fixture.calls.length, 4);
      const first = yield* fixture.action("result", { type: "snapshot" });
      assert.equal(fixture.calls.length, 4);
      assert.equal((first.result as PreviewAutomationSnapshot).screenshot.data, png);
      yield* fixture.action("click", { type: "press", input: { key: "Enter" } }).pipe(Effect.flip);
      const evidence = yield* fixture.finish();
      assert.equal(evidence.candidateDigest, "digest");
      assert.equal(evidence.reviewThreadId, deliveryIds.reviewer);
      assert.equal(evidence.screenshots.length, 1);
      const reopened = yield* fixture.reopen;
      const saved = yield* reopened.read(evidence.operationsDigest);
      assert.deepEqual(saved.evidence, evidence);
      const fs = yield* FileSystem.FileSystem;
      assert.equal(
        Buffer.from(yield* fs.readFile(saved.artifacts[0]!.path)).toString("base64"),
        png,
      );
      const replay = yield* reopened.invoke({
        commandId: CommandId.make("click"),
        instanceId: instance.id,
        threadId: deliveryIds.reviewer,
        journey: "Save task",
        action: { type: "click", input: { locator: "role=button[name=Save]" } },
      });
      assert.equal(replay.sequence, 2);
      assert.equal(fixture.calls.length, 4);
      yield* reopened
        .finish({
          commandId: CommandId.make("finish"),
          instanceId: instance.id,
          threadId: deliveryIds.reviewer,
          journeys: ["Different journey"],
        })
        .pipe(Effect.flip);
      yield* fs.writeFileString(saved.artifacts[0]!.path, "changed screenshot");
      yield* reopened.read(evidence.operationsDigest).pipe(Effect.flip);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "preserves an interrupted browser action as uncertain instead of replaying its click",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      fixture.hold();
      const running = yield* fixture
        .action("uncertain", { type: "click", input: { locator: "role=button[name=Save]" } })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(fixture.entered);
      yield* Fiber.interrupt(running);
      const reopened = yield* fixture.reopen;
      for (const commandId of ["uncertain", "different-command"])
        yield* reopened
          .invoke({
            commandId: CommandId.make(commandId),
            instanceId: instance.id,
            threadId: deliveryIds.reviewer,
            journey: "Save task",
            action: { type: "click", input: { locator: "role=button[name=Save]" } },
          })
          .pipe(Effect.flip);
      assert.equal(fixture.calls.length, 1);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "rejects foreign reviewers, stopped instances, stale review identity and outside navigation before browser work",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* fixture
        .action("foreign", { type: "navigate", path: "/" }, ThreadId.make("foreign"))
        .pipe(Effect.flip);
      for (const path of ["https://outside.example/", "//127.0.0.1:9000", "/\\127.0.0.1:9000"])
        yield* fixture.action(`outside:${path}`, { type: "navigate", path }).pipe(Effect.flip);
      assert.equal(fixture.calls.length, 0);
      fixture.stop();
      yield* fixture.action("stopped", { type: "navigate", path: "/" }).pipe(Effect.flip);
      yield* fixture.retire;
      yield* fixture.action("retired", { type: "snapshot" }).pipe(Effect.flip);
      assert.equal(fixture.calls.length, 0);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "cannot mint UX evidence from a screenshot alone or while project control blocks the reviewer",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* fixture.action("navigate", { type: "navigate", path: "/" });
      yield* fixture.action("snapshot", { type: "snapshot" });
      yield* fixture.finish().pipe(Effect.flip);
      fixture.block();
      yield* fixture
        .action("blocked-click", { type: "click", input: { locator: "role=button[name=Save]" } })
        .pipe(Effect.flip);
      yield* fixture.finish().pipe(Effect.flip);
      assert.equal(fixture.calls.length, 2);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "refuses another instance's reviewer, revision, assignment or candidate before browser work",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const mismatches: ReadonlyArray<Partial<FactoryPreviewExecution.FactoryPreviewInstance>> = [
        { reviewThreadId: ThreadId.make("other-reviewer") },
        { revisionId: "another-revision" },
        { assignmentId: FactoryAssignmentId.make("other-assignment") },
        { candidateDigest: "another-candidate" },
      ];
      for (const [index, mismatch] of mismatches.entries()) {
        fixture.replaceInstance({ id: "foreign-instance", ...mismatch });
        const error = yield* fixture.service
          .invoke({
            instanceId: "foreign-instance",
            threadId: deliveryIds.reviewer,
            commandId: CommandId.make(`foreign-instance:${index}`),
            journey: "Save task",
            action: { type: "navigate", path: "/" },
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "execution-unavailable");
      }
      assert.lengthOf(fixture.calls, 0);
    }).pipe(Effect.provide(base)),
);
