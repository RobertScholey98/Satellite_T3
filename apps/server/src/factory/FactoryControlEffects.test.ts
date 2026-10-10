import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactoryControlId,
  FactoryDependencyId,
  FactoryEffectIntent,
  FactoryError,
  FactorySnapshot,
  FactorySourceId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryAssignment,
  type FactoryAuxiliaryThread,
  type FactoryControl,
  type FactoryDependency,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  layer as SatelliteLayer,
  recordProject,
} from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
import { FactoryExecution } from "./FactoryExecution.ts";
import { FactoryHandover } from "./FactoryHandover.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { FactorySource } from "./FactorySource.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";

const now = "2026-10-10T12:00:00.000Z";
const projectId = ProjectId.make("controls-project");
const managerId = ThreadId.make("controls-manager");
const leadId = ThreadId.make("controls-lead");
const assignmentId = FactoryAssignmentId.make("controls-assignment");
const boundaryId = FactoryBoundaryId.make("controls-boundary");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "approved-model" };
const workflow = { repositoryRoot: "/owned-workflow", revision: "approved-workflow" };
const human = { kind: "human" } as const;
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const encodeIntent = Schema.encodeSync(Schema.fromJsonString(FactoryEffectIntent));
const assignment: FactoryAssignment = {
  id: assignmentId,
  managerId,
  threadId: leadId,
  projectId,
  kind: "implementation",
  title: "Existing implementation",
  status: "running",
  scope: {
    description: "Improve the app",
    completionCondition: "Reviewed and verified",
    requiresPullRequest: true,
  },
  threadStatus: "created",
  launchStatus: "delivered",
  preparation: "ready",
  qualification: { status: "qualified", profileId: "implementation-profile", checkedAt: now },
  authorization: { kind: "human", commandId: CommandId.make("initial-work") },
  workflow,
  modelSelection: model,
  grantedPolicy: initialFactorySnapshot().defaults,
  grant: {
    boundaryId,
    epoch: 0,
    sourcePaths: ["src/app.ts"],
    creatableDirectories: [],
    controlChange: null,
  },
  wait: null,
  report: null,
  createdAt: now,
  updatedAt: now,
};
const initial = (assignments: readonly FactoryAssignment[]): FactorySnapshot => ({
  ...initialFactorySnapshot(),
  managers: [
    {
      id: managerId,
      threadId: managerId,
      projectId,
      role: "project",
      name: "Project manager",
      modelSelection: model,
      workflow,
      overrides: {},
      boundaryId,
      status: "active",
      threadStatus: "created",
      launchStatus: "delivered",
      wait: null,
      createdAt: now,
      updatedAt: now,
    },
  ],
  assignments,
  boundaries: [
    {
      id: boundaryId,
      projectId,
      workflow,
      profileId: "discovery-profile",
      sourceRevision: "approved",
      protectedPaths: ["AGENTS.md"],
      writablePaths: ["src/app.ts"],
      creatableDirectories: [],
      gates: [],
      approvedAt: now,
    },
  ],
});
const runtime = Layer.mergeAll(FactoryStore.layer, ThreadManagement.layer).pipe(
  Layer.provideMerge(SatelliteLayer),
);
const source = {
  id: FactorySourceId.make("current-source"),
  projectId,
  revision: "current",
  sourceDigest: "source-digest",
  branch: "main",
  origin: "project" as const,
  capturedAt: now,
  fileCount: 1,
  stagedPaths: [],
  unstagedPaths: [],
  untrackedPaths: [],
  deletedPaths: [],
  excludedPaths: [],
};
const qualification = {
  status: "qualified" as const,
  profileId: "implementation-profile",
  checkedAt: now,
};
const scenario = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  options: {
    assignments?: readonly FactoryAssignment[];
    auxiliaryThreads?: readonly FactoryAuxiliaryThread[];
    dependencies?: readonly FactoryDependency[];
    controls?: readonly FactoryControl[];
    effects?: readonly FactoryEffectIntent[];
    stopTeam?: FactoryHandover["Service"]["stopTeam"];
    suspend?: FactoryBoundaryExecution["Service"]["suspend"];
    resume?: FactoryBoundaryExecution["Service"]["resume"];
    stop?: FactoryBoundaryExecution["Service"]["stop"];
    prepare?: FactoryBoundaryExecution["Service"]["prepare"];
    verify?: FactoryBoundaryExecution["Service"]["verify"];
  } = {},
) =>
  Effect.gen(function* () {
    const assignments = options.assignments ?? [assignment];
    const auxiliaryThreads = options.auxiliaryThreads ?? [];
    yield* recordProject({ projectId, title: "Controls", workspaceRoot: "/project" });
    const threads = yield* ThreadManagement.ThreadManagementService;
    for (const threadId of [
      managerId,
      ...assignments.map((entry) => entry.threadId),
      ...auxiliaryThreads.map((entry) => entry.threadId),
    ]) {
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId,
        title: threadId,
        modelSelection: model,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,0,${encodeSnapshot({
      ...initial(assignments),
      auxiliaryThreads,
      dependencies: options.dependencies ?? [],
      controls: options.controls ?? [],
    })})`;
    if (options.effects !== undefined) {
      yield* sql`INSERT INTO factory_commands (command_id,request_json,result_json)
        VALUES('persisted-delivery','{}','{"revision":0}')`;
      for (const [index, intent] of options.effects.entries())
        yield* sql`INSERT INTO factory_outbox (effect_id,command_id,payload_json,status,created_at)
          VALUES(${`persisted-delivery:${index}`},'persisted-delivery',${encodeIntent(intent)},'pending',${now})`;
    }
    return yield* body.pipe(
      Effect.provide(FactoryService.layer),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(FactoryExecution)({
            qualify: () => Effect.succeed(qualification),
            assertSelectionFor: () => Effect.void,
            assertDelegationFor: () => Effect.void,
            runtimePolicyFor: () => Effect.succeed(undefined),
          }),
          Layer.mock(FactoryBoundaryExecution)({
            suspend: options.suspend ?? (() => Effect.void),
            resume: options.resume ?? (() => Effect.void),
            stop: options.stop ?? (() => Effect.void),
            prepare:
              options.prepare ?? (() => Effect.die("Controls must not prepare another volume.")),
            verify: options.verify ?? (() => Effect.die("Unexpected verification.")),
          }),
          Layer.mock(FactoryHandover)({
            stopTeam:
              options.stopTeam ??
              ((input) =>
                threads
                  .dispatch({
                    type: "thread.stop",
                    threadId: input.threadId,
                    commandId: CommandId.make(`${input.commandId}:${input.threadId}`),
                  })
                  .pipe(
                    Effect.asVoid,
                    Effect.mapError(
                      (cause) => new FactoryError({ code: "execution-unavailable", cause }),
                    ),
                  )),
          }),
          Layer.mock(FactorySource)({
            capture: () => Effect.succeed(source),
            validateCurrent: () => Effect.void,
          }),
        ),
      ),
    );
  }).pipe(Effect.provide(runtime), Effect.scoped);

const send = (threadId: ThreadId, text = "Continue authorized work", queued = false) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });
const commission = {
  type: "assignment.commission" as const,
  commandId: CommandId.make("concurrent-work"),
  managerId,
  title: "New implementation",
  scope: {
    description: "Implement scoped work",
    completionCondition: "Verified",
    requiresPullRequest: true,
  },
  complexity: "standard" as const,
  kind: "implementation" as const,
  sourcePaths: ["src/app.ts"],
  creatableDirectories: [],
};

const delegate = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* send(leadId);
  const run = (yield* projections.getThreadProjection(leadId)).runs[0]!;
  yield* threads.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make("delegate-worker"),
    parentThreadId: leadId,
    parentRunId: run.id,
    parentNodeId: run.rootNodeId!,
    task: "Investigate the scoped implementation",
    modelSelection: model,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
  });
  return (yield* projections.getThreadProjection(leadId)).subagents[0]!.childThreadId!;
});

it.effect("manager pause stops its own thread while an implementation team keeps working", () =>
  scenario(
    Effect.gen(function* () {
      const factory = yield* FactoryService.FactoryService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* send(managerId);
      yield* send(leadId);
      yield* factory.dispatch(human, {
        type: "manager.pause",
        commandId: CommandId.make("pause-manager"),
        managerId,
      });
      yield* factory.drain;
      const state = yield* factory.snapshot({});
      assert.equal(state.managers[0]?.status, "paused");
      assert.equal(
        state.controls[0]?.kind === "manager-pause" ? state.controls[0].stop.status : null,
        "confirmed",
      );
      assert.equal(
        (yield* projections.getThreadProjection(managerId)).runs.at(-1)?.status,
        "interrupted",
      );
      assert.equal(
        (yield* projections.getThreadProjection(leadId)).runs.at(-1)?.status,
        "starting",
      );
      assert.equal(state.assignments[0]?.wait, null);
    }),
  ),
);

it.effect(
  "cancellation rejects a reason until teardown completes and keeps it through service recreation",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      yield* scenario(
        Effect.gen(function* () {
          const factory = yield* FactoryService.FactoryService;
          const command = {
            type: "assignment.cancel" as const,
            commandId: CommandId.make("cancel"),
            assignmentId,
          };
          yield* factory.dispatch(human, command);
          yield* Deferred.await(entered);
          const pending = yield* factory.snapshot({});
          assert.equal(pending.assignments[0]?.outcome?.kind, "cancelled");
          assert.equal(
            (yield* factory
              .dispatch(human, {
                type: "assignment.cancellation-reason",
                commandId: CommandId.make("early-reason"),
                assignmentId,
                reason: "Priorities changed",
              })
              .pipe(Effect.flip)).code,
            "invalid-state",
          );
          yield* Deferred.succeed(finish, undefined);
          yield* factory.drain;
          yield* factory.dispatch(human, {
            type: "assignment.cancellation-reason",
            commandId: CommandId.make("reason"),
            assignmentId,
            reason: "Priorities changed",
          });
          const saved = yield* factory.snapshot({});
          const control = saved.controls.find((entry) => entry.kind === "cancellation");
          assert.equal(
            control?.kind === "cancellation" ? control.reason?.text : null,
            "Priorities changed",
          );
          assert.deepEqual(
            yield* factory.dispatch(human, command),
            yield* (yield* FactoryStore.FactoryStore).findReceipt({ actor: human, command }),
          );
          const reopened = yield* FactoryStore.FactoryStore.pipe(
            Effect.provide(Layer.fresh(FactoryStore.layer)),
          );
          assert.deepEqual((yield* reopened.snapshot).controls, saved.controls);
          const recreated = yield* FactoryService.FactoryService.pipe(
            Effect.provide(Layer.fresh(FactoryService.layer)),
          );
          yield* recreated.drain;
          assert.deepEqual((yield* recreated.snapshot({})).controls, saved.controls);
        }),
        {
          stop: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        },
      );
    }),
);

it.effect("a failed stop stays visible and retry confirms the same control generation", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    yield* scenario(
      Effect.gen(function* () {
        const factory = yield* FactoryService.FactoryService;
        yield* factory.dispatch(human, {
          type: "project.pause",
          commandId: CommandId.make("pause"),
          projectId,
        });
        yield* factory.drain;
        const control = (yield* factory.snapshot({})).controls[0]!;
        assert.equal(control.kind === "project-pause" ? control.stop.status : null, "failed");
        yield* factory.dispatch(human, {
          type: "control.retry",
          commandId: CommandId.make("retry"),
          controlId: control.id,
          generation: control.generation,
        });
        yield* factory.drain;
        const retried = (yield* factory.snapshot({})).controls[0]!;
        assert.equal(retried.id, control.id);
        assert.equal(retried.generation, control.generation);
        assert.equal(retried.kind === "project-pause" ? retried.stop.status : null, "confirmed");
        assert.equal(yield* Ref.get(attempts), 2);
      }),
      {
        suspend: () =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.fail(
                    new FactoryError({
                      code: "execution-unavailable",
                      detail: "Docker unavailable",
                    }),
                  )
                : Effect.void,
            ),
          ),
      },
    );
  }),
);

it.effect(
  "project resume restores active work and waiting volumes without reviving an old interruption",
  () =>
    Effect.gen(function* () {
      const resumed = yield* Ref.make<FactoryAssignmentId[]>([]);
      const waiting = {
        ...assignment,
        id: FactoryAssignmentId.make("waiting"),
        threadId: ThreadId.make("waiting-lead"),
        status: "waiting" as const,
        wait: { kind: "human-decision" as const, reason: "Approve the new journey" },
      };
      const idle = {
        ...assignment,
        id: FactoryAssignmentId.make("idle"),
        threadId: ThreadId.make("idle-lead"),
      };
      const preparing = {
        ...assignment,
        id: FactoryAssignmentId.make("preparing"),
        threadId: ThreadId.make("preparing-lead"),
      };
      yield* scenario(
        Effect.gen(function* () {
          const factory = yield* FactoryService.FactoryService;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          yield* send(leadId);
          yield* send(leadId, "Queued authorized work", true);
          const automaticQueue = (yield* projections.getThreadProjection(leadId)).runs.at(-1)!;
          yield* send(leadId, "Manually held work", true);
          const manualQueue = (yield* projections.getThreadProjection(leadId)).runs.at(-1)!;
          yield* projections.apply({
            id: EventId.make("manual-queue-hold"),
            type: "run.updated",
            threadId: leadId,
            runId: manualQueue.id,
            occurredAt: yield* DateTime.now,
            payload: { ...manualQueue, queueHeld: true },
          });
          yield* send(idle.threadId);
          yield* threads.dispatch({
            type: "thread.stop",
            threadId: idle.threadId,
            commandId: CommandId.make("earlier-interruption"),
          });
          yield* send(preparing.threadId);
          const run = (yield* projections.getThreadProjection(preparing.threadId)).runs[0]!;
          yield* projections.apply({
            id: EventId.make("still-preparing"),
            type: "run.updated",
            threadId: preparing.threadId,
            runId: run.id,
            occurredAt: yield* DateTime.now,
            payload: { ...run, status: "preparing" },
          });
          yield* factory.dispatch(human, {
            type: "project.pause",
            commandId: CommandId.make("project-pause"),
            projectId,
          });
          yield* factory.drain;
          const paused = (yield* factory.snapshot({})).controls[0]!;
          assert.deepEqual(
            paused.kind === "project-pause" ? paused.resumeThreadIds?.toSorted() : null,
            [leadId, preparing.threadId].toSorted(),
          );
          yield* factory.dispatch(human, {
            type: "project.resume",
            commandId: CommandId.make("project-resume"),
            projectId,
          });
          yield* factory.drain;
          const state = yield* factory.snapshot({});
          assert.equal(
            state.controls[0]?.kind === "project-pause" ? state.controls[0].status : null,
            "released",
          );
          assert.deepEqual(yield* Ref.get(resumed), [
            assignment.id,
            waiting.id,
            idle.id,
            preparing.id,
          ]);
          assert.deepEqual(
            state.assignments.find((entry) => entry.id === waiting.id)?.wait,
            waiting.wait,
          );
          assert.equal(
            (yield* projections.getThreadProjection(waiting.threadId)).messages.length,
            0,
          );
          assert.equal((yield* projections.getThreadProjection(idle.threadId)).messages.length, 1);
          assert.equal(
            (yield* projections.getThreadProjection(preparing.threadId)).messages.length,
            2,
          );
          const lead = yield* projections.getThreadProjection(leadId);
          assert.equal(lead.messages.length, 4);
          assert.isFalse(lead.runs.find((entry) => entry.id === automaticQueue.id)?.queueHeld);
          assert.isTrue(lead.runs.find((entry) => entry.id === manualQueue.id)?.queueHeld);
        }),
        {
          assignments: [assignment, waiting, idle, preparing],
          resume: (input) => Ref.update(resumed, (ids) => [...ids, input.assignmentId]),
        },
      );
    }),
);

it.effect(
  "cancellation is accepted while preparation is blocked and late preparation never launches",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      yield* scenario(
        Effect.gen(function* () {
          const factory = yield* FactoryService.FactoryService;
          const created = yield* factory.dispatch(human, commission);
          yield* Deferred.await(entered);
          const cancelled = yield* factory.dispatch(human, {
            type: "assignment.cancel",
            commandId: CommandId.make("cancel-preparing"),
            assignmentId: created.assignmentId!,
          });
          assert.equal(typeof cancelled.controlId, "string");
          yield* Deferred.await(stopped);
          assert.equal(
            (yield* factory.snapshot({})).assignments.find(
              (entry) => entry.id === created.assignmentId,
            )?.outcome?.kind,
            "cancelled",
          );
          yield* Deferred.succeed(finish, undefined);
          yield* factory.drain;
          const result = (yield* factory.snapshot({})).assignments.find(
            (entry) => entry.id === created.assignmentId,
          )!;
          assert.equal(result.threadStatus, "pending");
          assert.equal(result.outcome?.kind, "cancelled");
          assert.equal(
            yield* (yield* ThreadManagement.ThreadManagementService).getThreadShell(
              result.threadId,
            ),
            null,
          );
        }),
        {
          prepare: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as(qualification),
            ),
          stop: () => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
        },
      );
    }),
);

it.effect("cancellation does not wait for slow verification and discards its late result", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    yield* scenario(
      Effect.gen(function* () {
        const factory = yield* FactoryService.FactoryService;
        const verifying = yield* factory
          .dispatch(human, {
            type: "assignment.verify",
            commandId: CommandId.make("slow-verification"),
            assignmentId,
            expectedEpoch: 0,
          })
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        yield* factory.dispatch(human, {
          type: "assignment.cancel",
          commandId: CommandId.make("cancel-verifying"),
          assignmentId,
        });
        yield* factory.changes({}).pipe(
          Stream.filter((state) =>
            state.controls.some(
              (entry) => entry.kind === "cancellation" && entry.stop.status === "confirmed",
            ),
          ),
          Stream.runHead,
        );
        yield* Deferred.succeed(finish, undefined);
        const result = yield* Fiber.join(verifying);
        assert.equal(result._tag, "Failure");
        const state = yield* factory.snapshot({});
        assert.equal(state.assignments[0]?.outcome?.kind, "cancelled");
        assert.equal(state.assignments[0]?.verification, undefined);
      }),
      {
        verify: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as({
              artifactId: "late-artifact",
              boundaryId,
              epoch: 0,
              sourceDigest: "late-digest",
              gates: [],
              checkedAt: now,
            }),
          ),
      },
    );
  }),
);

it.effect("resuming an idle manager delivers earlier worker escalation exactly once", () =>
  scenario(
    Effect.gen(function* () {
      const factory = yield* FactoryService.FactoryService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const workerId = yield* delegate;
      yield* factory.dispatch(human, {
        type: "manager.pause",
        commandId: CommandId.make("pause-idle"),
        managerId,
      });
      yield* factory.drain;
      const paused = (yield* factory.snapshot({})).controls[0]!;
      assert.deepEqual(paused.kind === "manager-pause" ? paused.resumeThreadIds : null, []);
      yield* send(workerId, "Consider adjusting the scope", true);
      const escalation = {
        type: "guidance.escalate" as const,
        commandId: CommandId.make("escalate-worker-guidance"),
        threadId: workerId,
        messageId: MessageId.make(`message:${workerId}:Consider adjusting the scope`),
        summary: "The requested scope needs a decision",
      };
      yield* factory.dispatch({ kind: "thread", threadId: leadId }, escalation);
      yield* factory.drain;
      assert.equal((yield* projections.getThreadProjection(managerId)).messages.length, 0);
      yield* factory.dispatch(human, {
        type: "manager.resume",
        commandId: CommandId.make("resume-idle"),
        managerId,
      });
      yield* factory.drain;
      const messages = (yield* projections.getThreadProjection(managerId)).messages;
      assert.equal(messages.length, 1);
      assert.include(messages[0]!.text, escalation.summary);
      yield* factory.dispatch({ kind: "thread", threadId: leadId }, escalation);
      yield* factory.drain;
      assert.deepEqual((yield* projections.getThreadProjection(managerId)).messages, messages);
    }),
  ),
);

it.effect("project resume releases a manager continuation held by an overlapping pause", () =>
  scenario(
    Effect.gen(function* () {
      const factory = yield* FactoryService.FactoryService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* send(managerId);
      yield* factory.dispatch(human, {
        type: "manager.pause",
        commandId: CommandId.make("overlap-manager-pause"),
        managerId,
      });
      yield* factory.drain;
      yield* factory.dispatch(human, {
        type: "project.pause",
        commandId: CommandId.make("overlap-project-pause"),
        projectId,
      });
      yield* factory.drain;
      yield* factory.dispatch(human, {
        type: "manager.resume",
        commandId: CommandId.make("overlap-manager-resume"),
        managerId,
      });
      yield* factory.drain;
      assert.equal((yield* projections.getThreadProjection(managerId)).messages.length, 1);
      yield* factory.dispatch(human, {
        type: "project.resume",
        commandId: CommandId.make("overlap-project-resume"),
        projectId,
      });
      yield* factory.drain;
      assert.equal((yield* projections.getThreadProjection(managerId)).messages.length, 2);
      const recreated = yield* FactoryService.FactoryService.pipe(
        Effect.provide(Layer.fresh(FactoryService.layer)),
      );
      yield* recreated.drain;
      assert.equal((yield* projections.getThreadProjection(managerId)).messages.length, 2);
    }),
  ),
);

it.effect(
  "recreated services preserve independent pauses, takeover, and cancellation awaiting a reason",
  () => {
    const abandoned = {
      ...assignment,
      id: FactoryAssignmentId.make("abandoned"),
      threadId: ThreadId.make("abandoned-lead"),
    };
    return scenario(
      Effect.gen(function* () {
        const factory = yield* FactoryService.FactoryService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* send(leadId, "A priority decision is needed");
        yield* send(abandoned.threadId);
        for (const command of [
          {
            type: "thread.takeover" as const,
            commandId: CommandId.make("persist-takeover"),
            threadId: leadId,
          },
          {
            type: "manager.pause" as const,
            commandId: CommandId.make("persist-manager-pause"),
            managerId,
          },
          {
            type: "project.pause" as const,
            commandId: CommandId.make("persist-project-pause"),
            projectId,
          },
          {
            type: "assignment.cancel" as const,
            commandId: CommandId.make("persist-cancel"),
            assignmentId: abandoned.id,
          },
        ]) {
          yield* factory.dispatch(human, command);
          yield* factory.drain;
        }
        yield* factory.dispatch(human, {
          type: "guidance.escalate",
          commandId: CommandId.make("persist-escalation"),
          threadId: leadId,
          messageId: MessageId.make(`message:${leadId}:A priority decision is needed`),
          summary: "Review the requested priority",
        });
        yield* factory.drain;
        const before = yield* factory.snapshot({});
        yield* Effect.gen(function* () {
          const recreated = yield* FactoryService.FactoryService;
          yield* recreated.drain;
          assert.deepEqual((yield* recreated.snapshot({})).controls, before.controls);
          assert.equal((yield* projections.getThreadProjection(managerId)).messages.length, 0);
          assert.equal((yield* projections.getThreadProjection(leadId)).messages.length, 1);
          assert.equal(
            (yield* projections.getThreadProjection(abandoned.threadId)).messages.length,
            1,
          );
          yield* recreated.dispatch(human, {
            type: "project.resume",
            commandId: CommandId.make("persist-project-resume"),
            projectId,
          });
          yield* recreated.drain;
          assert.equal((yield* projections.getThreadProjection(managerId)).messages.length, 0);
          assert.equal((yield* projections.getThreadProjection(leadId)).messages.length, 1);
          yield* recreated.dispatch(human, {
            type: "thread.handback",
            commandId: CommandId.make("persist-handback"),
            threadId: leadId,
          });
          yield* recreated.drain;
          assert.equal((yield* projections.getThreadProjection(leadId)).messages.length, 2);
          assert.equal((yield* projections.getThreadProjection(managerId)).messages.length, 0);
          yield* recreated.dispatch(human, {
            type: "manager.resume",
            commandId: CommandId.make("persist-manager-resume"),
            managerId,
          });
          yield* recreated.drain;
          assert.equal((yield* projections.getThreadProjection(managerId)).messages.length, 1);
          assert.equal(
            (yield* projections.getThreadProjection(abandoned.threadId)).messages.length,
            1,
          );
          const after = yield* recreated.snapshot({});
          const cancelled = after.controls.find((entry) => entry.kind === "cancellation");
          assert.equal(
            cancelled?.kind === "cancellation" ? cancelled.stop.status : null,
            "confirmed",
          );
          assert.isUndefined(cancelled?.kind === "cancellation" ? cancelled.reason : null);
          assert.equal(
            after.assignments.find((entry) => entry.id === abandoned.id)?.outcome?.kind,
            "cancelled",
          );
        }).pipe(
          Effect.provide(
            Layer.fresh(FactoryService.layer.pipe(Layer.provideMerge(FactoryStore.layer))),
          ),
        );
      }),
      { assignments: [assignment, abandoned] },
    );
  },
);

it.effect(
  "a queued-only manager resumes its original run after recreation without a new continuation",
  () =>
    scenario(
      Effect.gen(function* () {
        const factory = yield* FactoryService.FactoryService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* send(managerId, "Original queued instruction");
        const run = (yield* projections.getThreadProjection(managerId)).runs[0]!;
        yield* projections.apply({
          id: EventId.make("queued-only-manager"),
          type: "run.updated",
          threadId: managerId,
          runId: run.id,
          occurredAt: yield* DateTime.now,
          payload: { ...run, status: "queued", queueHeld: false, queuePosition: 1 },
        });
        yield* factory.dispatch(human, {
          type: "manager.pause",
          commandId: CommandId.make("queued-manager-pause"),
          managerId,
        });
        yield* factory.drain;
        assert.isTrue((yield* projections.getThreadProjection(managerId)).runs[0]?.queueHeld);
        const paused = (yield* factory.snapshot({})).controls[0]!;
        assert.deepEqual(paused.kind === "manager-pause" ? paused.resumeThreadIds : null, []);
        yield* Effect.gen(function* () {
          const recreated = yield* FactoryService.FactoryService;
          yield* recreated.dispatch(human, {
            type: "manager.resume",
            commandId: CommandId.make("queued-manager-resume"),
            managerId,
          });
          yield* recreated.drain;
          const resumed = yield* projections.getThreadProjection(managerId);
          assert.equal(resumed.messages.length, 1);
          assert.equal(resumed.runs.length, 1);
          assert.equal(resumed.runs[0]?.id, run.id);
          assert.isFalse(resumed.runs[0]?.queueHeld);
          assert.equal(resumed.runs[0]?.status, "starting");
        }).pipe(
          Effect.provide(
            Layer.fresh(FactoryService.layer.pipe(Layer.provideMerge(FactoryStore.layer))),
          ),
        );
      }),
    ),
);

const diagnosisId = ThreadId.make("independent-diagnosis");
const otherDiagnosisId = ThreadId.make("other-diagnosis");
const otherAssignment: FactoryAssignment = {
  ...assignment,
  id: FactoryAssignmentId.make("other-assignment"),
  threadId: ThreadId.make("other-lead"),
};
const auxiliary: FactoryAuxiliaryThread = {
  threadId: diagnosisId,
  assignmentId,
  managerId,
  projectId,
  kind: "diagnosis",
  incidentId: "current-incident",
  cycle: 1,
  status: "running",
  modelSelection: model,
  qualification,
  createdAt: now,
  updatedAt: now,
};

it.effect.each(["assignment.cancel", "project.pause"] as const)(
  "%s stops independently rooted diagnosis threads within its remit",
  (kind) =>
    scenario(
      Effect.gen(function* () {
        const factory = yield* FactoryService.FactoryService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* send(diagnosisId);
        yield* send(otherDiagnosisId);
        assert.equal(
          (yield* projections.getThreadProjection(diagnosisId)).thread.lineage.parentThreadId,
          null,
        );
        yield* factory.dispatch(
          human,
          kind === "assignment.cancel"
            ? { type: kind, commandId: CommandId.make(kind), assignmentId }
            : { type: kind, commandId: CommandId.make(kind), projectId },
        );
        yield* factory.drain;
        assert.equal(
          (yield* projections.getThreadProjection(diagnosisId)).runs[0]?.status,
          "interrupted",
        );
        assert.equal(
          (yield* projections.getThreadProjection(otherDiagnosisId)).runs[0]?.status,
          kind === "project.pause" ? "interrupted" : "starting",
        );
        const control = (yield* factory.snapshot({})).controls[0];
        assert.equal(control?.kind === "takeover" ? null : control?.stop.status, "confirmed");
      }),
      {
        assignments: [assignment, otherAssignment],
        auxiliaryThreads: [
          auxiliary,
          { ...auxiliary, threadId: otherDiagnosisId, assignmentId: otherAssignment.id },
        ],
      },
    ),
);

const dependencyId = FactoryDependencyId.make("current-dependency");
const dependency: FactoryDependency = {
  id: dependencyId,
  assignmentId,
  description: "A separately delivered capability",
  unblockCondition: {
    kind: "pull-request-merged",
    projectId,
    ref: { projectId, repository: "owner/repository", number: 12 },
  },
  requestedBy: leadId,
  evidence: [],
  state: "checking",
  delivery: {
    kind: "pull-request-merged",
    id: "current-delivery",
    projectId,
    ref: { projectId, repository: "owner/repository", number: 12 },
    headSha: "confirmed-head",
    mergedAt: now,
    observedAt: now,
  },
  createdAt: now,
  updatedAt: now,
};
const dependencyWait: FactoryAssignment["wait"] = {
  kind: "dependency",
  dependencyIds: [dependencyId],
  reason: "Check the supporting delivery before resuming implementation",
};
const usabilityIntent: FactoryEffectIntent = {
  type: "thread.deliver",
  threadId: leadId,
  messageId: MessageId.make("check-current-delivery"),
  kind: "continuation",
  sourceThreadId: managerId,
  purpose: { kind: "dependency-usability", dependencyId, deliveryId: "current-delivery" },
  text: "Check whether the host-confirmed supporting delivery is usable.",
};
const recoveringAssignment: FactoryAssignment = {
  ...assignment,
  oversight: {
    recovery: {
      cyclesUsed: 1,
      history: [],
      incident: {
        id: "current-incident",
        phase: "continuing",
        reason: "Continue with the independently diagnosed plan",
        evidence: [],
      },
    },
  },
};
const recoveryIntent: FactoryEffectIntent = {
  ...usabilityIntent,
  messageId: MessageId.make("continue-current-recovery"),
  purpose: { kind: "recovery", incidentId: "current-incident" },
  text: "Continue within the retained grant and recovery allowance.",
};

it.effect.each(["active", "queued", "completed"] as const)(
  "project resume restores only the captured current diagnosis: %s",
  (mode) =>
    scenario(
      Effect.gen(function* () {
        const factory = yield* FactoryService.FactoryService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* send(diagnosisId, "Investigate the recorded failure");
        const original = (yield* projections.getThreadProjection(diagnosisId)).runs[0]!;
        if (mode === "queued")
          yield* projections.apply({
            id: EventId.make("queued-diagnosis"),
            type: "run.updated",
            threadId: diagnosisId,
            runId: original.id,
            occurredAt: yield* DateTime.now,
            payload: { ...original, status: "queued", queueHeld: false, queuePosition: 1 },
          });
        yield* factory.dispatch(human, {
          type: "project.pause",
          commandId: CommandId.make("pause-diagnosis"),
          projectId,
        });
        yield* factory.drain;
        const paused = (yield* factory.snapshot({})).controls[0]!;
        assert.equal(paused.kind, "project-pause");
        if (paused.kind !== "project-pause") return;
        assert.deepEqual(paused.resumeThreadIds, mode === "queued" ? [] : [diagnosisId]);
        if (mode === "queued")
          assert.deepEqual(paused.resumeQueues, [{ threadId: diagnosisId, runIds: [original.id] }]);
        yield* factory.dispatch(human, {
          type: "project.resume",
          commandId: CommandId.make("resume-diagnosis"),
          projectId,
        });
        yield* factory.drain;
        const current = yield* projections.getThreadProjection(diagnosisId);
        assert.equal(
          current.runs.at(-1)?.status,
          mode === "completed" ? "interrupted" : "starting",
        );
        assert.equal(current.messages.length, mode === "active" ? 2 : 1);
        if (mode === "queued") {
          assert.equal(current.runs[0]?.id, original.id);
          assert.isFalse(current.runs[0]?.queueHeld);
        }
        assert.equal((yield* factory.snapshot({})).assignments[0]?.wait?.kind, "recovery");
      }),
      {
        assignments: [
          {
            ...recoveringAssignment,
            wait: { kind: "recovery", reason: "Wait for independent diagnosis" },
            oversight: {
              recovery: {
                ...recoveringAssignment.oversight!.recovery,
                incident: {
                  ...recoveringAssignment.oversight!.recovery.incident!,
                  phase: mode === "completed" ? "replanning" : "diagnosing",
                  diagnosisThreadId: diagnosisId,
                },
              },
            },
          },
        ],
        auxiliaryThreads: [{ ...auxiliary, status: mode === "completed" ? "complete" : "running" }],
      },
    ),
);

const deliveryCases: readonly {
  name: string;
  assignment: FactoryAssignment;
  intent: FactoryEffectIntent;
  dependency?: FactoryDependency;
  expected: "completed" | "pending" | "superseded";
}[] = [
  {
    name: "checks the current dependency delivery through its matching wait",
    assignment: { ...assignment, wait: dependencyWait },
    intent: usabilityIntent,
    dependency,
    expected: "completed",
  },
  {
    name: "does not let an ordinary continuation bypass a dependency wait",
    assignment: { ...assignment, wait: dependencyWait },
    intent: {
      type: "thread.deliver",
      threadId: leadId,
      messageId: MessageId.make("ordinary-continuation"),
      kind: "continuation",
      sourceThreadId: managerId,
      text: "Continue the original work.",
    },
    dependency,
    expected: "pending",
  },
  {
    name: "holds a dependency check behind another dependency wait",
    assignment: {
      ...assignment,
      wait: {
        ...dependencyWait,
        dependencyIds: [FactoryDependencyId.make("unrelated-dependency")],
      },
    },
    intent: usabilityIntent,
    dependency,
    expected: "pending",
  },
  {
    name: "holds a dependency check behind an authority decision",
    assignment: { ...assignment, wait: { kind: "authority", reason: "Grant revoked" } },
    intent: usabilityIntent,
    dependency,
    expected: "pending",
  },
  {
    name: "retires a superseded dependency delivery even when no wait remains",
    assignment,
    intent: usabilityIntent,
    dependency: { ...dependency, delivery: { ...dependency.delivery!, id: "new-delivery" } },
    expected: "superseded",
  },
  {
    name: "retires a check already resolved as usable",
    assignment,
    intent: usabilityIntent,
    dependency: { ...dependency, state: "usable" },
    expected: "superseded",
  },
  {
    name: "rejects another assignment's delivery as a wait bypass",
    assignment: { ...assignment, wait: dependencyWait },
    intent: usabilityIntent,
    dependency: { ...dependency, assignmentId: otherAssignment.id },
    expected: "superseded",
  },
  {
    name: "continues the current recovery through its recovery wait",
    assignment: {
      ...recoveringAssignment,
      wait: { kind: "recovery", reason: "Resume the approved recovery plan" },
    },
    intent: recoveryIntent,
    expected: "completed",
  },
  {
    name: "does not let recovery dismiss a human decision",
    assignment: {
      ...recoveringAssignment,
      wait: { kind: "human-decision", reason: "A new product decision is required" },
    },
    intent: recoveryIntent,
    expected: "pending",
  },
  {
    name: "does not let recovery bypass a dependency wait",
    assignment: { ...recoveringAssignment, wait: dependencyWait },
    intent: recoveryIntent,
    dependency,
    expected: "pending",
  },
  {
    name: "retires an earlier recovery continuation after the incident changes",
    assignment: recoveringAssignment,
    intent: { ...recoveryIntent, purpose: { kind: "recovery", incidentId: "old-incident" } },
    expected: "superseded",
  },
  {
    name: "retires a recovery continuation once the incident escalates",
    assignment: {
      ...recoveringAssignment,
      oversight: {
        recovery: {
          ...recoveringAssignment.oversight!.recovery,
          incident: { ...recoveringAssignment.oversight!.recovery.incident!, phase: "escalated" },
        },
      },
    },
    intent: recoveryIntent,
    expected: "superseded",
  },
];

it.effect.each(deliveryCases)("$name", (test) =>
  scenario(
    Effect.gen(function* () {
      const factory = yield* FactoryService.FactoryService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      yield* factory.drain;
      assert.equal(
        (yield* projections.getThreadProjection(leadId)).messages.length,
        test.expected === "completed" ? 1 : 0,
      );
      const rows = yield* sql<{ readonly status: string }>`
          SELECT status FROM factory_outbox WHERE effect_id = 'persisted-delivery:0'`;
      assert.equal(rows[0]?.status, test.expected);
      const current = (yield* factory.snapshot({})).assignments[0]!;
      assert.deepEqual(current.wait, test.assignment.wait);
      assert.deepEqual(current.grant, test.assignment.grant);
    }),
    {
      assignments: [test.assignment],
      dependencies: test.dependency === undefined ? [] : [test.dependency],
      effects: [test.intent],
    },
  ),
);

const controlCases: readonly FactoryControl[] = [
  {
    id: FactoryControlId.make("held-manager"),
    kind: "manager-pause",
    managerId,
    generation: 1,
    status: "active",
    stop: { status: "confirmed", stoppedAt: now },
    priorStatus: "active",
    requestedAt: now,
    updatedAt: now,
  },
  {
    id: FactoryControlId.make("held-project"),
    kind: "project-pause",
    projectId,
    generation: 1,
    status: "active",
    stop: { status: "confirmed", stoppedAt: now },
    requestedAt: now,
    updatedAt: now,
  },
  {
    id: FactoryControlId.make("human-takeover"),
    kind: "takeover",
    threadId: leadId,
    assignmentId,
    managerId,
    parentThreadId: managerId,
    generation: 1,
    status: "active",
    requestedAt: now,
    updatedAt: now,
  },
  {
    id: FactoryControlId.make("cancelled-work"),
    kind: "cancellation",
    assignmentId,
    managerId,
    generation: 1,
    stop: { status: "confirmed", stoppedAt: now },
    requestedAt: now,
    updatedAt: now,
  },
];
it.effect.each(controlCases)("purpose-specific delivery respects $kind", (control) =>
  scenario(
    Effect.gen(function* () {
      const factory = yield* FactoryService.FactoryService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const store = yield* FactoryStore.FactoryStore;
      yield* factory.drain;
      assert.equal((yield* projections.getThreadProjection(leadId)).messages.length, 0);
      assert.equal((yield* store.pending).length, 2);
    }),
    {
      assignments: [recoveringAssignment],
      dependencies: [dependency],
      controls: [control],
      effects: [usabilityIntent, recoveryIntent],
    },
  ),
);
