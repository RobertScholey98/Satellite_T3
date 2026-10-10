import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactoryError,
  FactorySnapshot,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryAssignment,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import { FactoryExecution } from "./FactoryExecution.ts";
import { FactoryHandover } from "./FactoryHandover.ts";
import * as FactoryRecoveryEffects from "./FactoryRecoveryEffects.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";

const now = "2026-10-10T12:00:00.000Z";
const projectId = ProjectId.make("recovery-effects-project");
const managerId = ThreadId.make("manager");
const leadId = ThreadId.make("original-lead");
const diagnosisId = ThreadId.make("diagnosis");
const replacementId = ThreadId.make("replacement");
const assignmentId = FactoryAssignmentId.make("assignment");
const boundaryId = FactoryBoundaryId.make("boundary");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "approved" };
const workflow = { repositoryRoot: "/skills", revision: "pinned" };
const qualification = {
  status: "qualified" as const,
  profileId: "inspection-profile",
  checkedAt: now,
};
const assignment: FactoryAssignment = {
  id: assignmentId,
  managerId,
  threadId: leadId,
  projectId,
  kind: "implementation",
  title: "Original feature",
  scope: {
    description: "Implement the feature",
    completionCondition: "Reviewed PR merged",
    requiresPullRequest: true,
  },
  modelSelection: model,
  modelPolicy: { approvedModels: [model], preferences: [] },
  status: "running",
  preparation: "ready",
  threadStatus: "created",
  launchStatus: "delivered",
  qualification: { ...qualification, profileId: "original-profile" },
  workflow,
  grantedPolicy: initialFactorySnapshot().defaults,
  grant: {
    boundaryId,
    epoch: 3,
    sourcePaths: ["src/app.ts"],
    creatableDirectories: [],
    controlChange: null,
  },
  oversight: {
    recovery: {
      cyclesUsed: 0,
      history: [],
      incident: {
        id: "incident",
        phase: "reconciling",
        reason: "Stopped with work remaining",
        evidence: [],
      },
    },
  },
  wait: null,
  report: null,
  createdAt: now,
  updatedAt: now,
};
const seed: FactorySnapshot = {
  ...initialFactorySnapshot(),
  assignments: [assignment],
  managers: [
    {
      id: managerId,
      threadId: managerId,
      role: "project",
      projectId,
      name: "Manager",
      modelSelection: model,
      workflow,
      overrides: {},
      status: "active",
      threadStatus: "created",
      launchStatus: "delivered",
      boundaryId,
      wait: null,
      createdAt: now,
      updatedAt: now,
    },
  ],
};
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const base = Layer.mergeAll(FactoryStore.layer, ThreadManagement.layer).pipe(
  Layer.provideMerge(Satellite.layer),
);
const adapter = FactoryRecoveryEffects.layer.pipe(Layer.provide(FactoryControlAccess.layer));
const scenario = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  options: {
    stopTeam?: FactoryHandover["Service"]["stopTeam"];
    inspect?: FactoryBoundaryExecution["Service"]["inspect"];
    rebind?: FactoryBoundaryExecution["Service"]["rebind"];
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const store = yield* FactoryStore.FactoryStore;
    yield* Satellite.recordProject({
      projectId,
      title: "Recovery",
      workspaceRoot: "/original-worktree",
    });
    for (const threadId of [managerId, leadId])
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId,
        title: threadId,
        modelSelection: model,
        runtimeMode: "approval-required",
        interactionMode: "default",
        worktreePath: "/original-worktree",
        branch: "feature/current",
        createdBy: "user",
        creationSource: "web",
      });
    yield* threads.sendToThread({
      projectId,
      threadId: leadId,
      commandId: CommandId.make("original-task"),
      messageId: MessageId.make("original-task"),
      text: "The unfinished implementation",
      attachments: [],
      mode: "auto",
      createdBy: "user",
      creationSource: "web",
    });
    yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,0,${encodeSnapshot(seed)})`;
    yield* body.pipe(
      Effect.provide(adapter),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(FactoryBoundaryExecution)({
            inspect:
              options.inspect ??
              (() => Effect.succeed({ qualification, sourceDigest: "unfinished-edits" })),
            rebind:
              options.rebind ??
              (() => Effect.succeed({ ...qualification, profileId: "replacement-profile" })),
            prepare: () => Effect.die("Recovery cannot rebuild the starting source"),
          }),
          Layer.mock(FactoryHandover)({
            stopTeam:
              options.stopTeam ??
              ((input) =>
                threads
                  .dispatch({
                    type: "thread.stop",
                    threadId: input.threadId,
                    commandId: input.commandId,
                  })
                  .pipe(
                    Effect.asVoid,
                    Effect.mapError(
                      (cause) => new FactoryError({ code: "execution-unavailable", cause }),
                    ),
                  )),
          }),
          Layer.mock(FactoryExecution)({
            assertSelectionFor: () => Effect.void,
            runtimePolicyFor: (threadId) =>
              Effect.gen(function* () {
                const current = yield* store.snapshot;
                if (threadId === diagnosisId)
                  assert.isDefined(
                    current.auxiliaryThreads[0]?.qualification,
                    "Diagnosis profile must be durable before launch",
                  );
                if (threadId === replacementId) {
                  assert.equal(current.assignments[0]?.threadId, replacementId);
                  assert.include(current.assignments[0]?.previousLeadThreadIds ?? [], leadId);
                }
                return {
                  boundaryId: `boundary:${threadId}`,
                  dockerContext: "test",
                  imageId: "image",
                  projectSnapshotPath: "/snapshot",
                  workflowSnapshotPath: "/workflow",
                  runtimePath: `/runtime/${threadId}`,
                };
              }),
          }),
        ),
      ),
    );
  }).pipe(Effect.provide(base), Effect.scoped);

const begin = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  yield* store.commit({
    actor: { kind: "human" },
    now,
    auxiliaryAllocation: { threadId: diagnosisId, modelSelection: model },
    command: {
      type: "assignment.recovery.begin",
      commandId: CommandId.make("begin"),
      assignmentId,
      incidentId: "incident",
    },
  });
  return (yield* store.pending).find((entry) => entry.intent.type === "auxiliary.launch")!;
});
const replace = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  yield* store.commit({
    actor: { kind: "thread", threadId: diagnosisId },
    now,
    command: {
      type: "auxiliary.report",
      commandId: CommandId.make("diagnosis-report"),
      threadId: diagnosisId,
      summary: "Replan the unfinished work",
      evidence: [{ label: "Current candidate", location: "/workspace/src/app.ts" }],
    },
  });
  yield* store.commit({
    actor: { kind: "human" },
    now,
    replacementAllocation: { threadId: replacementId, modelSelection: model },
    command: {
      type: "assignment.recovery.replan",
      commandId: CommandId.make("replan"),
      assignmentId,
      incidentId: "incident",
      plan: "Preserve edits and complete verification",
      replaceLead: true,
    },
  });
  return (yield* store.pending).find((entry) => entry.intent.type === "assignment.replace-lead")!;
});

it.effect(
  "diagnosis waits for strict stop, records its profile, then launches one ordinary thread",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const inspected = yield* Ref.make(false);
      yield* scenario(
        Effect.gen(function* () {
          const effects = yield* FactoryRecoveryEffects.FactoryRecoveryEffects;
          const store = yield* FactoryStore.FactoryStore;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const pending = yield* begin;
          const running = yield* effects
            .handle(pending)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(entered);
          assert.isFalse(yield* Ref.get(inspected));
          assert.isNull(yield* threads.getThreadShell(diagnosisId));
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(running);
          const current = yield* store.snapshot;
          assert.equal(current.auxiliaryThreads[0]?.status, "running");
          assert.equal(current.auxiliaryThreads[0]?.sourceDigest, "unfinished-edits");
          assert.equal(current.assignments[0]?.oversight?.recovery.cyclesUsed, 1);
          assert.equal(
            (yield* threads.getThreadRecords(diagnosisId, ["messages"])).messages.length,
            1,
          );
          assert.equal((yield* threads.getThreadShell(diagnosisId))?.lineage.parentThreadId, null);
          assert.isFalse((yield* store.pending).some((entry) => entry.id === pending.id));
          assert.equal(
            (yield* threads.getThreadRecords(diagnosisId, ["messages"])).messages.length,
            1,
          );
        }),
        {
          stopTeam: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          inspect: () =>
            Ref.set(inspected, true).pipe(
              Effect.as({ qualification, sourceDigest: "unfinished-edits" }),
            ),
        },
      );
    }),
);

it.effect(
  "a replacement accepted before a lost receipt is recovered without stopping it or duplicating the handoff",
  () =>
    Effect.gen(function* () {
      const stops = yield* Ref.make<ThreadId[]>([]);
      const rebinds = yield* Ref.make(0);
      yield* scenario(
        Effect.gen(function* () {
          const effects = yield* FactoryRecoveryEffects.FactoryRecoveryEffects;
          const store = yield* FactoryStore.FactoryStore;
          const threads = yield* ThreadManagement.ThreadManagementService;
          yield* effects.handle(yield* begin);
          const pending = yield* replace;
          const interrupted = yield* FactoryRecoveryEffects.FactoryRecoveryEffects.pipe(
            Effect.provide(Layer.fresh(adapter)),
            Effect.provideService(FactoryStore.FactoryStore, {
              ...store,
              finishEffect: (input) =>
                input.command.type === "assignment.replacement.recorded"
                  ? Effect.fail(new FactoryError({ code: "persistence" }))
                  : store.finishEffect(input),
            }),
          );
          assert.equal((yield* interrupted.handle(pending).pipe(Effect.flip)).code, "persistence");
          const prepared = (yield* store.snapshot).assignments[0]!;
          assert.equal(prepared.threadId, replacementId);
          assert.equal(prepared.oversight?.recovery.incident?.phase, "replacing");
          const existingMessages = (yield* threads.getThreadRecords(replacementId, ["messages"]))
            .messages;
          assert.equal(existingMessages.length, 1);
          const previousStops = yield* Ref.get(stops);
          yield* Effect.gen(function* () {
            const recreated = yield* FactoryRecoveryEffects.FactoryRecoveryEffects;
            yield* recreated.handle(pending);
          }).pipe(
            Effect.provide(Layer.fresh(adapter.pipe(Layer.provideMerge(FactoryStore.layer)))),
          );
          assert.deepEqual(yield* Ref.get(stops), previousStops);
          assert.equal(yield* Ref.get(rebinds), 1);
          assert.deepEqual(
            (yield* threads.getThreadRecords(replacementId, ["messages"])).messages,
            existingMessages,
          );
          assert.equal(
            (yield* threads.getThreadRecords(leadId, ["messages"])).messages[0]?.text,
            "The unfinished implementation",
          );
          const current = (yield* store.snapshot).assignments[0]!;
          assert.equal(current.launchStatus, "delivered");
          assert.equal(current.oversight?.recovery.incident?.phase, "continuing");
          assert.equal(current.oversight?.recovery.cyclesUsed, 1);
          assert.deepEqual(current.grant, assignment.grant);
          assert.deepEqual(current.workflow, assignment.workflow);
          assert.deepEqual(current.modelPolicy, assignment.modelPolicy);
        }),
        {
          stopTeam: (input) => Ref.update(stops, (values) => [...values, input.threadId]),
          rebind: () =>
            Ref.update(rebinds, (count) => count + 1).pipe(
              Effect.as({ ...qualification, profileId: "replacement-profile" }),
            ),
        },
      );
    }),
);

it.effect(
  "cancellation during inspection retires recovery without launching the prepared thread",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* scenario(
        Effect.gen(function* () {
          const effects = yield* FactoryRecoveryEffects.FactoryRecoveryEffects;
          const store = yield* FactoryStore.FactoryStore;
          const pending = yield* begin;
          const running = yield* effects
            .handle(pending)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(entered);
          yield* store.commit({
            actor: { kind: "human" },
            now,
            command: {
              type: "assignment.cancel",
              commandId: CommandId.make("cancel"),
              assignmentId,
            },
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(running);
          assert.isNull(
            yield* (yield* ThreadManagement.ThreadManagementService).getThreadShell(diagnosisId),
          );
          assert.equal((yield* store.snapshot).assignments[0]?.outcome?.kind, "cancelled");
          assert.isFalse((yield* store.pending).some((entry) => entry.id === pending.id));
        }),
        {
          inspect: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ qualification, sourceDigest: "unfinished-edits" }),
            ),
        },
      );
    }),
);

it.effect(
  "a changed recovery decision during inspection cannot launch the superseded diagnosis",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* scenario(
        Effect.gen(function* () {
          const effects = yield* FactoryRecoveryEffects.FactoryRecoveryEffects;
          const store = yield* FactoryStore.FactoryStore;
          const pending = yield* begin;
          const running = yield* effects
            .handle(pending)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(entered);
          yield* store.commit({
            actor: { kind: "human" },
            now,
            command: {
              type: "assignment.recovery.escalate",
              commandId: CommandId.make("changed-plan"),
              assignmentId,
              incidentId: "incident",
              escalation: {
                failure: "Different direction needed",
                attempts: ["Inspection started"],
                options: ["Continue original work"],
                recommendation: "Continue original work",
              },
            },
          });
          yield* store.commit({
            actor: { kind: "human" },
            now,
            command: {
              type: "assignment.wait.resolve",
              commandId: CommandId.make("resolve-change"),
              assignmentId,
            },
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(running);
          assert.isNull(
            yield* (yield* ThreadManagement.ThreadManagementService).getThreadShell(diagnosisId),
          );
          const state = yield* store.snapshot;
          assert.equal(state.assignments[0]!.oversight!.recovery.incident!.phase, "continuing");
          assert.equal(state.auxiliaryThreads[0]!.qualification, undefined);
          assert.isFalse((yield* store.pending).some((entry) => entry.id === pending.id));
        }),
        {
          inspect: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ qualification, sourceDigest: "unfinished-edits" }),
            ),
        },
      );
    }),
);

it.effect(
  "a paused recovery remains pending and launches only after the confirmed pause is released",
  () =>
    Effect.gen(function* () {
      const inspections = yield* Ref.make(0);
      yield* scenario(
        Effect.gen(function* () {
          const effects = yield* FactoryRecoveryEffects.FactoryRecoveryEffects;
          const store = yield* FactoryStore.FactoryStore;
          const pending = yield* begin;
          yield* store.commit({
            actor: { kind: "human" },
            now,
            command: {
              type: "project.pause",
              commandId: CommandId.make("pause-recovery"),
              projectId,
            },
          });
          yield* effects.handle(pending);
          assert.equal(yield* Ref.get(inspections), 0);
          assert.equal((yield* store.snapshot).auxiliaryThreads[0]?.status, "pending");
          assert.isTrue((yield* store.pending).some((entry) => entry.id === pending.id));
          const control = (yield* store.snapshot).controls[0]!;
          yield* store.commit({
            actor: { kind: "system" },
            now,
            command: {
              type: "control.stop.recorded",
              commandId: CommandId.make("pause-stopped"),
              controlId: control.id,
              generation: control.generation,
            },
          });
          yield* store.commit({
            actor: { kind: "human" },
            now,
            command: {
              type: "project.resume",
              commandId: CommandId.make("resume-recovery"),
              projectId,
            },
          });
          yield* effects.handle(pending);
          assert.equal(yield* Ref.get(inspections), 0);
          yield* store.commit({
            actor: { kind: "system" },
            now,
            command: {
              type: "control.resume.recorded",
              commandId: CommandId.make("resume-recorded"),
              controlId: control.id,
              generation: control.generation,
            },
          });
          yield* effects.handle(pending);
          assert.equal(yield* Ref.get(inspections), 1);
          assert.equal((yield* store.snapshot).auxiliaryThreads[0]?.status, "running");
        }),
        {
          inspect: () =>
            Ref.update(inspections, (count) => count + 1).pipe(
              Effect.as({ qualification, sourceDigest: "unfinished-edits" }),
            ),
        },
      );
    }),
);

it.effect("unconfirmed teardown escalates visibly without inspecting or launching", () =>
  scenario(
    Effect.gen(function* () {
      const effects = yield* FactoryRecoveryEffects.FactoryRecoveryEffects;
      const store = yield* FactoryStore.FactoryStore;
      const pending = yield* begin;
      yield* effects.handle(pending);
      const current = yield* store.snapshot;
      assert.equal(current.auxiliaryThreads[0]?.status, "failed");
      assert.include(
        current.auxiliaryThreads[0]?.failure ?? "",
        "Provider teardown was not confirmed",
      );
      assert.equal(current.assignments[0]?.oversight?.recovery.incident?.phase, "escalated");
      assert.isNull(
        yield* (yield* ThreadManagement.ThreadManagementService).getThreadShell(diagnosisId),
      );
    }),
    {
      stopTeam: () =>
        Effect.fail(
          new FactoryError({
            code: "execution-unavailable",
            detail: "Provider teardown was not confirmed",
          }),
        ),
      inspect: () => Effect.die("Inspection cannot precede confirmed teardown"),
    },
  ),
);
