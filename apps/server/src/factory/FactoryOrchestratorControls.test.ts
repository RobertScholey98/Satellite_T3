import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  FactoryAssignmentId,
  FactorySnapshot,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeProviderAdapter } from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryExecutionTestkit from "./FactoryExecution.testkit.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";

const now = "2026-10-10T12:00:00.000Z";
const projectId = ProjectId.make("factory-controls-project");
const managerId = ThreadId.make("factory-controls-manager");
const leadId = ThreadId.make("factory-controls-lead");
const ordinaryId = ThreadId.make("ordinary-thread");
const assignmentId = FactoryAssignmentId.make("factory-controls-assignment");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "approved" };
const workflow = { repositoryRoot: "/skills", revision: "pinned" };
const base = initialFactorySnapshot();
const snapshot: FactorySnapshot = {
  ...base,
  managers: [
    {
      id: managerId,
      threadId: managerId,
      projectId,
      role: "project",
      name: "Manager",
      status: "active",
      threadStatus: "created",
      launchStatus: "delivered",
      modelSelection,
      workflow,
      overrides: {},
      wait: null,
      createdAt: now,
      updatedAt: now,
    },
  ],
  assignments: [
    {
      id: assignmentId,
      managerId,
      threadId: leadId,
      projectId,
      kind: "implementation",
      status: "running",
      threadStatus: "created",
      launchStatus: "delivered",
      qualification: { status: "qualified", profileId: "profile", checkedAt: now },
      modelSelection,
      workflow,
      grantedPolicy: base.defaults,
      wait: null,
      report: null,
      createdAt: now,
      updatedAt: now,
    },
  ],
};
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(FactoryStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(database),
);
const controls = FactoryControlAccess.layer.pipe(Layer.provide(stores));
const testLayer = ProviderReplayHarness.layerWithRegistry(
  { name: "factory-control-admission" },
  ProviderAdapterRegistry.layerFromAdapters([makeProviderAdapter(modelSelection.instanceId)]),
  {
    databaseLayer: database,
    runEffectWorker: false,
    governance: FactoryExecution.layerThreadGovernance.pipe(
      Layer.provide(Layer.merge(FactoryExecutionTestkit.layerUnmanagedExecution, controls)),
      Layer.orDie,
    ),
  },
).pipe(Layer.provideMerge(stores));

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO factory_state (id, revision, payload_json)
    VALUES (1, ${snapshot.revision}, ${encodeSnapshot(snapshot)})`;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  for (const threadId of [managerId, leadId, ordinaryId])
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
});

const dispatchMessage = (
  threadId: ThreadId,
  label: string,
  options: { readonly senderThreadId?: ThreadId; readonly queue?: boolean } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`dispatch:${label}`),
      threadId,
      messageId: MessageId.make(label),
      text: label,
      attachments: [],
      dispatchMode: { type: options.queue ? "queue_after_active" : "start_immediately" },
      createdBy: options.senderThreadId === undefined ? "user" : "agent",
      creationSource: options.senderThreadId === undefined ? "web" : "mcp",
      ...(options.senderThreadId === undefined ? {} : { senderThreadId: options.senderThreadId }),
    });
  });

const factoryCommand = (command: FactoryCommand) =>
  Effect.gen(function* () {
    return yield* (yield* FactoryStore.FactoryStore).commit({
      actor: { kind: "human" },
      command,
      now,
      controlTarget: {
        threadId: leadId,
        managerId,
        projectId,
        assignmentId,
        ancestorThreadIds: [],
      },
    });
  });

const completeRun = (messageId: MessageId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projection = yield* projections.getThreadProjection(leadId);
    const run = projection.runs.find((candidate) => candidate.userMessageId === messageId)!;
    const timestamp = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`complete:${messageId}`),
      threadId: leadId,
      runId: run.id,
      type: "run.updated",
      occurredAt: timestamp,
      payload: { ...run, status: "completed", completedAt: timestamp },
    });
  });

describe("Orchestrator factory controls", () => {
  it.effect(
    "delivers queued human guidance past held parent direction and resumes the same parent run on handback",
    () =>
      Effect.gen(function* () {
        yield* setup;
        yield* dispatchMessage(leadId, "active-human");
        yield* dispatchMessage(leadId, "queued-parent", { senderThreadId: managerId, queue: true });
        yield* factoryCommand({
          type: "thread.takeover",
          commandId: CommandId.make("takeover"),
          threadId: leadId,
        });
        yield* dispatchMessage(leadId, "queued-human", { queue: true });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const before = yield* projections.getThreadProjection(leadId);
        const parentRun = before.runs.find(
          (run) => run.userMessageId === MessageId.make("queued-parent"),
        )!;
        yield* completeRun(MessageId.make("active-human"));
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("start-human-queue"),
          threadId: leadId,
        });
        const during = yield* projections.getThreadProjection(leadId);
        assert.strictEqual(during.runs.find((run) => run.id === parentRun.id)?.status, "queued");
        assert.strictEqual(
          during.runs.find((run) => run.userMessageId === MessageId.make("queued-human"))?.status,
          "starting",
        );
        assert.strictEqual(
          during.messages.find((message) => message.id === parentRun.userMessageId)?.senderThreadId,
          managerId,
        );
        yield* completeRun(MessageId.make("queued-human"));
        yield* factoryCommand({
          type: "thread.handback",
          commandId: CommandId.make("handback"),
          threadId: leadId,
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("resume-parent-queue"),
          threadId: leadId,
        });
        const after = yield* projections.getThreadProjection(leadId);
        const resumed = after.runs.find((run) => run.id === parentRun.id)!;
        assert.strictEqual(resumed.status, "starting");
        assert.strictEqual(resumed.userMessageId, parentRun.userMessageId);
        assert.strictEqual(resumed.activeAttemptId, parentRun.activeAttemptId);
        assert.strictEqual(after.runs.length, 3);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("allows human messages during takeover and rejects new parent direction", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* factoryCommand({
        type: "thread.takeover",
        commandId: CommandId.make("takeover"),
        threadId: leadId,
      });
      assert.isTrue(
        Result.isFailure(
          yield* dispatchMessage(leadId, "rejected-parent", { senderThreadId: managerId }).pipe(
            Effect.result,
          ),
        ),
      );
      yield* dispatchMessage(leadId, "human-guidance");
      const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
        leadId,
      );
      assert.deepStrictEqual(
        projection.messages.map((message) => message.id),
        [MessageId.make("human-guidance")],
      );
      assert.strictEqual(projection.runs[0]?.status, "starting");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each([false, true])(
    "restores the original paused queue and preserves an earlier manual hold (%s)",
    (manualHold) =>
      Effect.gen(function* () {
        yield* setup;
        yield* dispatchMessage(leadId, "completed-human");
        yield* dispatchMessage(leadId, "runnable-queued-human", { queue: true });
        if (manualHold) yield* dispatchMessage(leadId, "manually-held-human", { queue: true });
        yield* completeRun(MessageId.make("completed-human"));
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* FactoryStore.FactoryStore;
        const before = yield* projections.getThreadProjection(leadId);
        const queued = before.runs.find(
          (run) => run.userMessageId === MessageId.make("runnable-queued-human"),
        )!;
        const held = before.runs.find(
          (run) => run.userMessageId === MessageId.make("manually-held-human"),
        );
        if (held)
          yield* projections.apply({
            id: EventId.make("manual-hold"),
            type: "run.updated",
            threadId: leadId,
            runId: held.id,
            occurredAt: yield* DateTime.now,
            payload: { ...held, queueHeld: true },
          });
        const paused = yield* factoryCommand({
          type: "project.pause",
          commandId: CommandId.make("pause-queued-project"),
          projectId,
        });
        assert.isDefined(paused.controlId);
        yield* store.commit({
          actor: { kind: "system" },
          now,
          command: {
            type: "control.stop.targets.recorded",
            commandId: CommandId.make("capture-paused-queue"),
            controlId: paused.controlId!,
            generation: 1,
            threadIds: [],
            resumeQueues: [{ threadId: leadId, runIds: [queued.id] }],
          },
        });
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-paused-queue"),
          threadId: leadId,
        });
        const stopped = yield* projections.getThreadProjection(leadId);
        assert.isTrue(stopped.runs.find((run) => run.id === queued.id)?.queueHeld);
        yield* store.commit({
          actor: { kind: "system" },
          now,
          command: {
            type: "control.stop.recorded",
            commandId: CommandId.make("record-paused-queue-stop"),
            controlId: paused.controlId!,
            generation: 1,
          },
        });
        yield* factoryCommand({
          type: "project.resume",
          commandId: CommandId.make("resume-queued-project"),
          projectId,
        });
        yield* store.commit({
          actor: { kind: "system" },
          now,
          command: {
            type: "control.resume.recorded",
            commandId: CommandId.make("record-queued-project-resume"),
            controlId: paused.controlId!,
            generation: 1,
          },
        });
        const pending = yield* store.pending;
        assert.isFalse(pending.some((effect) => effect.intent.type === "thread.deliver"));
        const resume = pending.find((effect) => effect.intent.type === "thread.queue.resume");
        if (resume?.intent.type !== "thread.queue.resume" || resume.intent.runIds === undefined)
          throw new Error("Missing targeted queue resume");
        assert.deepStrictEqual(resume.intent.runIds, [queued.id]);
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("targeted-paused-queue-resume"),
          threadId: leadId,
          runIds: resume.intent.runIds,
        });
        const after = yield* projections.getThreadProjection(leadId);
        const restored = after.runs.find((run) => run.id === queued.id)!;
        assert.strictEqual(restored.status, manualHold ? "queued" : "starting");
        assert.isFalse(restored.queueHeld);
        assert.strictEqual(restored.userMessageId, queued.userMessageId);
        assert.strictEqual(restored.activeAttemptId, queued.activeAttemptId);
        assert.strictEqual(after.runs.length, before.runs.length);
        if (held) assert.isTrue(after.runs.find((run) => run.id === held.id)?.queueHeld);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("pauses only the manager while its team and ordinary threads remain available", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* factoryCommand({
        type: "manager.pause",
        commandId: CommandId.make("pause-manager"),
        managerId,
      });
      assert.isTrue(
        Result.isFailure(yield* dispatchMessage(managerId, "manager-blocked").pipe(Effect.result)),
      );
      assert.isTrue(
        Result.isFailure(
          yield* dispatchMessage(leadId, "paused-manager-direction", {
            senderThreadId: managerId,
          }).pipe(Effect.result),
        ),
      );
      yield* dispatchMessage(leadId, "team-continues");
      yield* dispatchMessage(ordinaryId, "ordinary-continues");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      assert.strictEqual((yield* projections.getThreadProjection(managerId)).runs.length, 0);
      assert.strictEqual(
        (yield* projections.getThreadProjection(leadId)).runs[0]?.status,
        "starting",
      );
      assert.strictEqual(
        (yield* projections.getThreadProjection(ordinaryId)).runs[0]?.status,
        "starting",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(["project.pause", "assignment.cancel"] as const)(
    "prevents actual dispatch after %s without affecting ordinary work",
    (type) =>
      Effect.gen(function* () {
        yield* setup;
        yield* factoryCommand(
          type === "project.pause"
            ? { type, commandId: CommandId.make(type), projectId }
            : { type, commandId: CommandId.make(type), assignmentId },
        );
        assert.isTrue(
          Result.isFailure(yield* dispatchMessage(leadId, "blocked-team").pipe(Effect.result)),
        );
        yield* dispatchMessage(ordinaryId, "ordinary-continues");
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        assert.strictEqual((yield* projections.getThreadProjection(leadId)).messages.length, 0);
        assert.strictEqual(
          (yield* projections.getThreadProjection(ordinaryId)).runs[0]?.status,
          "starting",
        );
      }).pipe(Effect.provide(testLayer)),
  );
});
