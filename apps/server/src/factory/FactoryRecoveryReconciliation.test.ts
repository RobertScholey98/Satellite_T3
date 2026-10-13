import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactorySnapshot,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type FactoryCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as FactoryRecoveryReconciliation from "./FactoryRecoveryReconciliation.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";

const now = "2026-10-10T12:00:00.000Z";
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(FactorySnapshot));
const projectId = ProjectId.make("diagnosis-reconcile-project");
const managerId = ThreadId.make("manager");
const leadId = ThreadId.make("lead");
const diagnosisId = ThreadId.make("diagnosis");
const assignmentId = FactoryAssignmentId.make("assignment");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "approved" };
const workflow = { repositoryRoot: "/skills", revision: "pinned" };
const qualification = { status: "qualified" as const, profileId: "inspection", checkedAt: now };
const seed: FactorySnapshot = {
  ...initialFactorySnapshot(),
  managers: [
    {
      id: managerId,
      threadId: managerId,
      projectId,
      role: "project",
      name: "Manager",
      modelSelection: model,
      workflow,
      overrides: {},
      status: "active",
      threadStatus: "created",
      launchStatus: "delivered",
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
      title: "Feature",
      scope: {
        description: "Build feature",
        completionCondition: "Merge",
        requiresPullRequest: true,
      },
      modelSelection: model,
      modelPolicy: { approvedModels: [model], preferences: [] },
      workflow,
      status: "waiting",
      threadStatus: "created",
      launchStatus: "delivered",
      preparation: "ready",
      qualification,
      grantedPolicy: initialFactorySnapshot().defaults,
      grant: {
        boundaryId: FactoryBoundaryId.make("boundary"),
        epoch: 0,
        sourcePaths: ["src/app.ts"],
        creatableDirectories: [],
        controlChange: null,
      },
      wait: { kind: "recovery", reason: "Diagnosis pending" },
      report: null,
      createdAt: now,
      updatedAt: now,
      oversight: {
        recovery: {
          cyclesUsed: 1,
          history: [],
          incident: {
            id: "incident",
            phase: "diagnosing",
            reason: "Stopped early",
            evidence: [],
            diagnosisThreadId: diagnosisId,
          },
        },
      },
    },
  ],
  auxiliaryThreads: [
    {
      threadId: diagnosisId,
      assignmentId,
      managerId,
      projectId,
      kind: "diagnosis",
      incidentId: "incident",
      cycle: 1,
      status: "running",
      modelSelection: model,
      qualification,
      sourceDigest: "edited-bytes",
      createdAt: now,
      updatedAt: now,
    },
  ],
};
const runtime = Layer.mergeAll(FactoryStore.layer, ThreadManagement.layer).pipe(
  Layer.provideMerge(Satellite.layer),
);
const scenario = <A, E, R>(body: Effect.Effect<A, E, R>, initial = seed) =>
  Effect.gen(function* () {
    yield* Satellite.recordProject({ projectId, title: "Diagnosis", workspaceRoot: "/project" });
    const threads = yield* ThreadManagement.ThreadManagementService;
    for (const threadId of [managerId, leadId, diagnosisId])
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId,
        title: threadId,
        modelSelection: model,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    const sql = yield* SqlClient.SqlClient;
    const encoded = yield* encodeSnapshot(initial);
    yield* sql`INSERT INTO factory_state(id,revision,payload_json) VALUES(1,0,${encoded})`;
    return yield* body.pipe(Effect.provide(FactoryRecoveryReconciliation.layer));
  }).pipe(Effect.provide(runtime), Effect.scoped);

const request = (name: string) =>
  Effect.gen(function* () {
    const store = yield* FactoryStore.FactoryStore;
    yield* store.commit({
      actor: { kind: "system" },
      now,
      command: {
        type: "auxiliary.reconcile.requested",
        commandId: CommandId.make(name),
        threadId: diagnosisId,
        triggerId: name,
      },
    });
    return (yield* store.pending).find(
      (entry) => entry.intent.type === "auxiliary.reconcile" && entry.intent.triggerId === name,
    )!;
  });
const send = (name: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.sendToThread({
      projectId,
      threadId: diagnosisId,
      commandId: CommandId.make(name),
      messageId: MessageId.make(name),
      text: "Inspect the preserved candidate",
      attachments: [],
      mode: "auto",
      createdBy: "user",
      creationSource: "web",
    });
    return (yield* threads.getThreadProjection(diagnosisId)).runs.at(-1)!;
  });
const terminal = Effect.gen(function* () {
  const run = yield* send("diagnosis-turn");
  yield* (yield* EventSink.EventSinkV2).write({
    events: [
      {
        id: EventId.make("diagnosis-ended"),
        type: "run.updated",
        threadId: diagnosisId,
        occurredAt: DateTime.makeUnsafe(now),
        payload: { ...run, status: "completed", completedAt: DateTime.makeUnsafe(now) },
      },
    ],
  });
  return run;
});
const human = (command: FactoryCommand) =>
  Effect.gen(function* () {
    return yield* (yield* FactoryStore.FactoryStore).commit({
      actor: { kind: "human" },
      now,
      command,
    });
  });

it.effect(
  "terminal diagnosis without findings escalates once across service and store recreation",
  () =>
    scenario(
      Effect.gen(function* () {
        yield* terminal;
        const pending = yield* request("terminal");
        yield* (yield* FactoryRecoveryReconciliation.FactoryRecoveryReconciliation).handle(pending);
        const store = yield* FactoryStore.FactoryStore;
        const first = yield* store.snapshot;
        assert.equal(first.auxiliaryThreads[0]!.status, "failed");
        assert.equal(first.assignments[0]!.wait?.kind, "human-decision");
        assert.equal(first.assignments[0]!.oversight!.recovery.cyclesUsed, 1);
        const notifications = (yield* store.pending).filter(
          (entry) => entry.intent.type === "thread.deliver",
        );
        assert.equal(notifications.length, 1);
        yield* Effect.gen(function* () {
          const reopened = yield* FactoryStore.FactoryStore;
          yield* reopened.commit({
            actor: { kind: "system" },
            now,
            command: {
              type: "auxiliary.reconcile.requested",
              commandId: CommandId.make("restart"),
              threadId: diagnosisId,
              triggerId: "restart",
            },
          });
          assert.equal(
            (yield* reopened.pending).filter((entry) => entry.intent.type === "auxiliary.reconcile")
              .length,
            0,
          );
          assert.deepStrictEqual(
            (yield* reopened.pending).filter((entry) => entry.intent.type === "thread.deliver"),
            notifications,
          );
        }).pipe(
          Effect.provide(FactoryRecoveryReconciliation.layer),
          Effect.provide(Layer.fresh(FactoryStore.layer)),
        );
      }),
    ),
);

it.effect("a later accepted run wins over a replayed terminal event", () =>
  scenario(
    Effect.gen(function* () {
      yield* terminal;
      yield* send("newer-run");
      const pending = yield* request("old-terminal");
      yield* (yield* FactoryRecoveryReconciliation.FactoryRecoveryReconciliation).handle(pending);
      const store = yield* FactoryStore.FactoryStore;
      assert.equal((yield* store.snapshot).auxiliaryThreads[0]!.status, "running");
      assert.isFalse((yield* store.pending).some((entry) => entry.id === pending.id));
    }),
  ),
);

it.effect("a newer run arriving during a reconciliation read is rescanned before failure", () =>
  scenario(
    Effect.gen(function* () {
      yield* terminal;
      const pending = yield* request("stale-read");
      const threads = yield* ThreadManagement.ThreadManagementService;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* Ref.make(true);
      const running = yield* Effect.gen(function* () {
        yield* (yield* FactoryRecoveryReconciliation.FactoryRecoveryReconciliation).handle(pending);
      }).pipe(
        Effect.provide(Layer.fresh(FactoryRecoveryReconciliation.layer)),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ...threads,
          getThreadRecords: (threadId, fields, filter) =>
            threads.getThreadRecords(threadId, fields, filter).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (yield* Ref.getAndSet(first, false)) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                }),
              ),
            ),
        }),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      yield* send("arrived-during-read");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      const store = yield* FactoryStore.FactoryStore;
      assert.equal((yield* store.snapshot).auxiliaryThreads[0]!.status, "running");
      assert.isFalse((yield* store.pending).some((entry) => entry.id === pending.id));
    }),
  ),
);

it.effect(
  "an unresolved provider request holds terminal diagnosis until its actual resolution",
  () =>
    scenario(
      Effect.gen(function* () {
        const run = yield* terminal;
        const sink = yield* EventSink.EventSinkV2;
        const requestRecord = {
          id: RuntimeRequestId.make("diagnosis-approval"),
          nodeId: run.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command" as const,
          status: "pending" as const,
          responseCapability: { type: "message" as const },
          createdAt: DateTime.makeUnsafe(now),
          resolvedAt: null,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("request-pending"),
              type: "runtime-request.updated",
              threadId: diagnosisId,
              occurredAt: DateTime.makeUnsafe(now),
              payload: requestRecord,
            },
          ],
        });
        const pending = yield* request("provider-wait");
        const service = yield* FactoryRecoveryReconciliation.FactoryRecoveryReconciliation;
        yield* service.handle(pending);
        const store = yield* FactoryStore.FactoryStore;
        assert.isTrue((yield* store.pending).some((entry) => entry.id === pending.id));
        assert.equal((yield* store.snapshot).auxiliaryThreads[0]!.status, "running");
        yield* sink.write({
          events: [
            {
              id: EventId.make("request-resolved"),
              type: "runtime-request.updated",
              threadId: diagnosisId,
              occurredAt: DateTime.makeUnsafe(now),
              payload: {
                ...requestRecord,
                status: "resolved",
                resolvedAt: DateTime.makeUnsafe(now),
              },
            },
          ],
        });
        yield* service.handle(pending);
        assert.equal((yield* store.snapshot).auxiliaryThreads[0]!.status, "failed");
      }),
    ),
);

it.effect("an active child prevents terminal diagnosis failure", () =>
  scenario(
    Effect.gen(function* () {
      const run = yield* send("parent-with-child");
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* threads.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("child"),
        parentThreadId: diagnosisId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Read evidence",
        modelSelection: model,
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("parent-ended"),
            type: "run.updated",
            threadId: diagnosisId,
            occurredAt: DateTime.makeUnsafe(now),
            payload: { ...run, status: "completed", completedAt: DateTime.makeUnsafe(now) },
          },
        ],
      });
      const pending = yield* request("child-active");
      yield* (yield* FactoryRecoveryReconciliation.FactoryRecoveryReconciliation).handle(pending);
      const store = yield* FactoryStore.FactoryStore;
      assert.equal((yield* store.snapshot).auxiliaryThreads[0]!.status, "running");
      assert.isFalse((yield* store.pending).some((entry) => entry.id === pending.id));
    }),
  ),
);

it.effect("a paused terminal diagnosis retains its check through recreation and release", () =>
  scenario(
    Effect.gen(function* () {
      yield* terminal;
      const paused = yield* human({
        type: "project.pause",
        commandId: CommandId.make("pause"),
        projectId,
      });
      const pending = yield* request("paused-terminal");
      yield* (yield* FactoryRecoveryReconciliation.FactoryRecoveryReconciliation).handle(pending);
      const store = yield* FactoryStore.FactoryStore;
      assert.isTrue((yield* store.pending).some((entry) => entry.id === pending.id));
      assert.equal((yield* store.snapshot).auxiliaryThreads[0]!.status, "running");
      yield* Effect.gen(function* () {
        const reopened = yield* FactoryStore.FactoryStore;
        const control = (yield* reopened.snapshot).controls.find(
          (entry) => entry.id === paused.controlId,
        )!;
        yield* reopened.commit({
          actor: { kind: "system" },
          now,
          command: {
            type: "control.stop.recorded",
            commandId: CommandId.make("stopped"),
            controlId: control.id,
            generation: control.generation,
          },
        });
        yield* human({ type: "project.resume", commandId: CommandId.make("resume"), projectId });
        yield* reopened.commit({
          actor: { kind: "system" },
          now,
          command: {
            type: "control.resume.recorded",
            commandId: CommandId.make("resumed"),
            controlId: control.id,
            generation: control.generation,
          },
        });
        yield* (yield* FactoryRecoveryReconciliation.FactoryRecoveryReconciliation).handle(pending);
        assert.equal((yield* reopened.snapshot).auxiliaryThreads[0]!.status, "failed");
      }).pipe(
        Effect.provide(FactoryRecoveryReconciliation.layer),
        Effect.provide(Layer.fresh(FactoryStore.layer)),
      );
    }),
  ),
);

it.effect("a fast terminal waits for its launch receipt and cannot overwrite a fast report", () =>
  scenario(
    Effect.gen(function* () {
      yield* terminal;
      const pending = yield* request("fast-terminal");
      const service = yield* FactoryRecoveryReconciliation.FactoryRecoveryReconciliation;
      yield* service.handle(pending);
      const store = yield* FactoryStore.FactoryStore;
      assert.isTrue((yield* store.pending).some((entry) => entry.id === pending.id));
      yield* store.commit({
        actor: { kind: "thread", threadId: diagnosisId },
        now,
        command: {
          type: "auxiliary.report",
          commandId: CommandId.make("report"),
          threadId: diagnosisId,
          summary: "Found the cause",
          evidence: [{ label: "Candidate", location: "/workspace/src/app.ts" }],
        },
      });
      yield* store.commit({
        actor: { kind: "system" },
        now,
        command: {
          type: "auxiliary.started",
          commandId: CommandId.make("late-started"),
          threadId: diagnosisId,
          qualification,
          sourceDigest: "edited-bytes",
        },
      });
      yield* service.handle(pending);
      const state = yield* store.snapshot;
      assert.equal(state.auxiliaryThreads[0]!.status, "complete");
      assert.equal(state.assignments[0]!.oversight!.recovery.incident!.phase, "replanning");
    }),
    { ...seed, auxiliaryThreads: [{ ...seed.auxiliaryThreads[0]!, status: "pending" }] },
  ),
);
