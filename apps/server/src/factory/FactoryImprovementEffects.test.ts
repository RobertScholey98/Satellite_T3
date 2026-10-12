import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, FactorySnapshot, ThreadId, type FactoryFinding } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { factoryImprovementDefaults } from "./FactoryImprovements.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Execution from "./FactoryExecution.ts";
import * as Improvements from "./FactoryImprovementEffects.ts";
import * as Store from "./FactoryStore.ts";
import { deletedThreadDetail } from "./FactoryThreadReach.ts";
import {
  deliveryFixture,
  deliveryIds,
  deliveryNow,
  deliverySelection,
} from "./FactoryDelivery.testkit.ts";

const systemId = ThreadId.make("system-manager");
const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const base = Layer.mergeAll(Store.layer, Threads.layer).pipe(
  Layer.provideMerge(Satellite.layer),
  Layer.provideMerge(NodeServices.layer),
);
const finding = (id: string): FactoryFinding => ({
  id,
  assignmentId: deliveryIds.assignment,
  reporterThreadId: deliveryIds.lead,
  problem: `Repeated coordination problem ${id}`,
  impact: "Repeated clarification delays delivery",
  evidence: [{ kind: "thread", threadId: deliveryIds.lead }],
  activeBlocker: true,
  route: {
    suspectedCause: "shared-system",
    uncertainty: "Only one project observed so far",
    owner: { kind: "system-remit" },
    requiredAuthority: "Human workflow review",
    rationale: "Coordination instructions apply across projects",
  },
  containmentOf: null,
  history: [],
  escalation: {
    summary: "Investigate shared coordination",
    commandId: CommandId.make(`escalate:${id}`),
    escalatedAt: deliveryNow,
  },
  createdAt: deliveryNow,
  updatedAt: deliveryNow,
});
const fixture = Effect.fn(function* () {
  const store = yield* Store.FactoryStore;
  const threads = yield* Threads.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  yield* Satellite.recordProject({
    projectId: deliveryIds.project,
    title: "Improvements",
    workspaceRoot: root,
  });
  const seed: FactorySnapshot = { ...deliveryFixture(), findings: [finding("first")] };
  yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,${seed.revision},${encode(seed)})`;
  let loseAck = false;
  let failSend = false;
  let qualifyCalls = 0;
  const qualification = {
    status: "qualified" as const,
    profileId: "system-profile",
    checkedAt: deliveryNow,
  };
  const dependencies = Layer.mergeAll(
    Access.layer,
    Layer.mock(Execution.FactoryExecution)({
      qualify: () =>
        Effect.sync(() => {
          qualifyCalls++;
          return qualification;
        }),
      runtimePolicyFor: () =>
        Effect.succeed({
          boundaryId: qualification.profileId,
          dockerContext: "fixture",
          imageId: "fixture",
          projectSnapshotPath: root,
          workflowSnapshotPath: root,
          runtimePath: root,
        }),
    }),
    Layer.succeed(Threads.ThreadManagementService, {
      ...threads,
      sendToThread: (input) =>
        Effect.gen(function* () {
          if (failSend)
            return yield* new Threads.ThreadManagementProjectionLoadError({
              projectId: input.projectId,
              threadId: input.threadId,
              cause: "Unavailable before acceptance",
            });
          const result = yield* threads.sendToThread(input);
          if (loseAck) {
            loseAck = false;
            return yield* new Threads.ThreadManagementProjectionLoadError({
              projectId: input.projectId,
              threadId: input.threadId,
              cause: "Lost acknowledgement",
            });
          }
          return result;
        }),
    }),
  );
  const effects = yield* Improvements.FactoryImprovementEffects.pipe(
    Effect.provide(Improvements.layer.pipe(Layer.provide(dependencies))),
  );
  const create = Effect.gen(function* () {
    yield* store.commit({
      actor: { kind: "human" },
      now: deliveryNow,
      systemManagerCreation: { threadId: systemId, qualification },
      command: {
        type: "system.create",
        commandId: CommandId.make("create-system"),
        workspaceProjectId: deliveryIds.project,
        modelSelection: deliverySelection,
        workflow: seed.managers[0]!.workflow,
      },
    });
    const launch = (yield* store.pending).find((entry) => entry.intent.type === "system.launch")!;
    yield* effects.handle(launch);
    return launch;
  });
  const notify = Effect.gen(function* () {
    for (const pending of yield* store.pending)
      if (pending.intent.type === "improvement.notify") yield* effects.handle(pending);
  });
  const write = (state: FactorySnapshot) =>
    sql`UPDATE factory_state SET revision=revision+1,payload_json=${encode(state)} WHERE id=1`;
  const messages = threads
    .getThreadRecords(systemId, ["messages"])
    .pipe(Effect.map((records) => records.messages));
  return {
    store,
    threads,
    effects,
    create,
    notify,
    write,
    messages,
    qualifyCalls: () => qualifyCalls,
    loseAck: () => {
      loseAck = true;
    },
    failSend: (value: boolean) => {
      failSend = value;
    },
  };
});

describe("FactoryImprovementEffects", () => {
  it.effect(
    "records a delivery failure and retries the same frozen batch without duplicate intake",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.create;
        yield* f.effects.reconcile;
        const sealed = (yield* f.store.snapshot).improvementBatches[0]!;
        f.failSend(true);
        yield* f.notify;
        const failed = (yield* f.store.snapshot).improvementBatches[0]!;
        assert.equal(failed.delivery.status, "pending");
        assert.isTrue(failed.delivery.status === "pending" && Boolean(failed.delivery.failure));
        const revision = (yield* f.store.snapshot).revision;
        yield* f.notify;
        assert.equal((yield* f.store.snapshot).revision, revision);
        yield* f.store.commit({
          actor: { kind: "human" },
          now: deliveryNow,
          command: {
            type: "improvement.batch.retry",
            commandId: CommandId.make("retry-batch"),
            batchId: sealed.id,
          },
        });
        f.failSend(false);
        yield* f.notify;
        const state = yield* f.store.snapshot;
        assert.equal(state.improvementBatches.length, 1);
        assert.equal(state.improvementIntakes.length, 1);
        assert.equal(state.improvementBatches[0]!.digest, sealed.digest);
        assert.equal(state.improvementBatches[0]!.delivery.status, "delivered");
        assert.equal((yield* f.messages).length, 2);
      }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("rearms one age deadline for persisted routine backlog without periodic wakeups", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.create;
      yield* f.effects.reconcile;
      const state = yield* f.store.snapshot;
      yield* f.write({
        ...state,
        improvementBatches: [],
        improvementIntakes: state.improvementIntakes.map((entry) => ({
          ...entry,
          origin: "retro",
          delivery: { phase: "queued" },
        })),
      });
      yield* f.store.commit({
        actor: { kind: "human" },
        now: deliveryNow,
        command: {
          type: "improvement.configure",
          commandId: CommandId.make("timer-config"),
          ...factoryImprovementDefaults,
        },
      });
      const subscribed = yield* Deferred.make<void>();
      const due = yield* Deferred.make<void>();
      let wakes = 0;
      yield* f.effects.watch(
        Effect.gen(function* () {
          wakes++;
          yield* Deferred.succeed(wakes === 1 ? subscribed : due, undefined);
        }),
      );
      yield* Deferred.await(subscribed);
      yield* TestClock.adjust("23 hours");
      assert.equal(wakes, 1);
      yield* TestClock.adjust("1 hour");
      yield* Deferred.await(due);
      assert.equal(wakes, 2);
      yield* TestClock.adjust("24 hours");
      assert.equal(wakes, 2);
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect(
    "launches a real peer thread without an onboarding assignment and recovers a lost acknowledgement",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.loseAck();
        const launch = yield* f.create;
        const state = yield* f.store.snapshot;
        assert.equal(state.managers.find((entry) => entry.id === systemId)?.status, "active");
        assert.equal(state.assignments.length, 1);
        assert.equal((yield* f.messages).length, 1);
        yield* f.effects.handle(launch);
        assert.equal((yield* f.messages).length, 1);
        assert.equal((yield* f.threads.getThreadShell(systemId))?.projectId, deliveryIds.project);
      }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("retries a created thread with the same profile and no duplicate thread", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.failSend(true);
      yield* f.create;
      const manager = (yield* f.store.snapshot).managers.find((entry) => entry.id === systemId)!;
      assert.equal(manager.status, "blocked");
      assert.equal(manager.threadStatus, "created");
      const command = {
        type: "system.retry" as const,
        commandId: CommandId.make("retry-system"),
        managerId: systemId,
      };
      const context = yield* f.effects.context({ kind: "human" }, command);
      assert.equal(f.qualifyCalls(), 0);
      yield* f.store.commit({ actor: { kind: "human" }, now: deliveryNow, command, ...context });
      f.failSend(false);
      for (const entry of yield* f.store.pending)
        if (entry.intent.type === "system.launch") yield* f.effects.handle(entry);
      assert.equal(
        (yield* f.store.snapshot).managers.find((entry) => entry.id === systemId)?.status,
        "active",
      );
      assert.equal((yield* f.messages).length, 1);
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("a retry never recreates a system-manager thread the human deleted", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.failSend(true);
      yield* f.create;
      yield* f.threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-system-thread"),
        threadId: systemId,
      });
      const command = {
        type: "system.retry" as const,
        commandId: CommandId.make("retry-system"),
        managerId: systemId,
      };
      const context = yield* f.effects.context({ kind: "human" }, command);
      yield* f.store.commit({ actor: { kind: "human" }, now: deliveryNow, command, ...context });
      f.failSend(false);
      for (const entry of yield* f.store.pending)
        if (entry.intent.type === "system.launch") yield* f.effects.handle(entry);
      const manager = (yield* f.store.snapshot).managers.find((entry) => entry.id === systemId)!;
      assert.equal(manager.status, "blocked");
      assert.equal(manager.wait?.reason, deletedThreadDetail);
      assert.isNull(yield* f.threads.getThreadShell(systemId));
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect(
    "seals urgent evidence once and delivers its frozen content after a finding changes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.create;
        yield* f.effects.reconcile;
        const sealed = yield* f.store.snapshot;
        assert.equal(sealed.improvementIntakes.length, 1);
        assert.equal(sealed.improvementBatches.length, 1);
        const batch = sealed.improvementBatches[0]!;
        yield* f.write({
          ...sealed,
          findings: [{ ...sealed.findings[0]!, problem: "Changed after sealing" }],
        });
        f.loseAck();
        yield* f.notify;
        yield* f.notify;
        const messages = yield* f.messages;
        assert.equal(messages.length, 2);
        assert.include(JSON.stringify(messages), batch.summary.replaceAll("\n", "\\n"));
        assert.notInclude(JSON.stringify(messages), "Changed after sealing");
        assert.equal((yield* f.store.snapshot).improvementBatches[0]!.delivery.status, "delivered");
        yield* f.effects.reconcile;
        assert.equal((yield* f.store.snapshot).improvementIntakes.length, 2);
        assert.equal((yield* f.store.snapshot).improvementBatches.length, 2);
      }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect(
    "keeps evidence pending while its manager is paused and ignores an unrelated project pause",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.create;
        yield* f.effects.reconcile;
        const state = yield* f.store.snapshot;
        yield* f.write({
          ...state,
          managers: state.managers.map((manager) =>
            manager.id === systemId ? { ...manager, status: "paused" } : manager,
          ),
        });
        yield* f.notify;
        assert.equal((yield* f.messages).length, 1);
        yield* f.write(state);
        yield* f.store.commit({
          actor: { kind: "human" },
          now: deliveryNow,
          command: {
            type: "project.pause",
            commandId: CommandId.make("pause-project"),
            projectId: deliveryIds.project,
          },
        });
        yield* f.notify;
        assert.equal((yield* f.messages).length, 2);
      }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect(
    "delivers a retired manager's undelivered batch to its replacement on a fresh thread",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.create;
        yield* f.effects.reconcile;
        f.failSend(true);
        yield* f.notify;
        const batch = (yield* f.store.snapshot).improvementBatches[0]!;
        yield* f.store.commit({
          actor: { kind: "human" },
          now: deliveryNow,
          command: {
            type: "manager.retire",
            commandId: CommandId.make("retire-system"),
            managerId: systemId,
            reason: "Use a different model",
          },
        });
        yield* f.notify;
        assert.isFalse(
          (yield* f.store.pending).some((entry) => entry.intent.type === "improvement.notify"),
        );
        const command = {
          type: "system.create" as const,
          commandId: CommandId.make("replace-system"),
          workspaceProjectId: deliveryIds.project,
          modelSelection: deliverySelection,
          workflow: deliveryFixture().managers[0]!.workflow,
        };
        const context = yield* f.effects.context({ kind: "human" }, command);
        const replacementId = context.systemManagerCreation!.threadId;
        assert.notEqual(replacementId, systemId);
        yield* f.store.commit({ actor: { kind: "human" }, now: deliveryNow, command, ...context });
        f.failSend(false);
        for (const entry of yield* f.store.pending)
          if (entry.intent.type === "system.launch") yield* f.effects.handle(entry);
        yield* f.notify;
        const state = yield* f.store.snapshot;
        assert.deepStrictEqual(
          state.improvementBatches.map((entry) => [
            entry.id,
            entry.managerId,
            entry.delivery.status,
          ]),
          [[batch.id, replacementId, "delivered"]],
        );
        const delivered = yield* f.threads.getThreadRecords(replacementId, ["messages"]);
        assert.include(JSON.stringify(delivered.messages), batch.id);
      }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect(
    "rejects a mismatched outbox receipt and repeated reconciliation does not spend twice",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.create;
        yield* f.effects.reconcile;
        yield* f.effects.reconcile;
        const pending = (yield* f.store.pending).find(
          (entry) => entry.intent.type === "improvement.notify",
        )!;
        const rejected = yield* f.store
          .finishEffect({
            id: pending.id,
            now: deliveryNow,
            command: {
              type: "system.launch.recorded",
              commandId: CommandId.make("wrong-receipt"),
              managerId: systemId,
              profileId: "system-profile",
            },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(rejected));
        assert.equal((yield* f.store.snapshot).improvementBatches.length, 1);
        yield* f.notify;
        assert.equal((yield* f.store.snapshot).improvementIntakes.length, 1);
      }).pipe(Effect.provide(base), Effect.scoped),
  );
});
