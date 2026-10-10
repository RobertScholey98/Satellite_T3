import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryError,
  MessageId,
  FactorySnapshot,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Store from "./FactoryStore.ts";
import * as Collaboration from "./FactoryCollaborationEffects.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Boundaries from "./FactoryBoundaryExecution.ts";
import * as Handover from "./FactoryHandover.ts";
import * as Preview from "./FactoryPreviewService.ts";
import {
  deliveryFixture,
  deliveryIds,
  deliveryNow,
  deliverySelection,
} from "./FactoryDelivery.testkit.ts";
const apiProject = ProjectId.make("api-project");
const apiManager = ThreadId.make("api-manager");
const apiLead = ThreadId.make("api-lead");
const apiAssignment = FactoryAssignmentId.make("api-assignment");
const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const base = Layer.mergeAll(Store.layer, Threads.layer).pipe(
  Layer.provideMerge(Satellite.layer),
  Layer.provideMerge(NodeServices.layer),
);
const seed = Effect.gen(function* () {
  const initial = deliveryFixture();
  const state: FactorySnapshot = {
    ...initial,
    managers: [
      ...initial.managers,
      {
        ...initial.managers[0]!,
        role: "project",
        id: apiManager,
        threadId: apiManager,
        projectId: apiProject,
      },
    ],
    assignments: [
      ...initial.assignments,
      {
        ...initial.assignments[0]!,
        id: apiAssignment,
        managerId: apiManager,
        projectId: apiProject,
        threadId: apiLead,
      },
    ],
    crossProjectRequests: [
      {
        id: "request",
        origin: { kind: "assignment", assignmentId: deliveryIds.assignment },
        originManagerId: deliveryIds.manager,
        originThreadId: deliveryIds.lead,
        originalLeadThreadId: deliveryIds.lead,
        receiverManagerId: apiManager,
        outcome: "Expose API",
        acceptanceConditions: "Same response",
        compatibility: "Additive",
        generation: 1,
        lifecycle: {
          phase: "accepted",
          support: { assignmentId: apiAssignment, dedicated: false },
          notifiedConclusionId: null,
        },
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
  };
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,${state.revision},${encode(state)})`;
  const threads = yield* Threads.ThreadManagementService;
  for (const projectId of [deliveryIds.project, apiProject])
    yield* Satellite.recordProject({
      projectId,
      title: projectId,
      workspaceRoot: `/fixture/${projectId}`,
    });
  for (const [threadId, projectId] of [
    [deliveryIds.lead, deliveryIds.project],
    [apiLead, apiProject],
    [deliveryIds.manager, deliveryIds.project],
    [apiManager, apiProject],
  ] as const)
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection: deliverySelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
    });
});
const external = Layer.mergeAll(
  Layer.mock(Boundaries.FactoryBoundaryExecution)({ setIncidentHold: () => Effect.void }),
  Layer.mock(Handover.FactoryHandover)({ stopTeam: () => Effect.void }),
  Layer.mock(Preview.FactoryPreviewService)({ reconcile: Effect.void }),
);
const runtime = Collaboration.layer.pipe(Layer.provide(Access.layer), Layer.provide(external));

it.effect("reconciles a lost peer ACK after request withdrawal without sending a duplicate", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* Store.FactoryStore;
    const threads = yield* Threads.ThreadManagementService;
    yield* store.commit({
      actor: { kind: "thread", threadId: deliveryIds.lead },
      command: {
        type: "collaboration.message.send",
        commandId: CommandId.make("send"),
        requestId: "request",
        fromAssignmentId: deliveryIds.assignment,
        toAssignmentId: apiAssignment,
        text: "Use /v2/profile",
      },
      now: deliveryNow,
    });
    const pending = (yield* store.pending).find(
      (entry) => entry.intent.type === "collaboration.message.deliver",
    )!;
    let sends = 0;
    const intercepted = Layer.succeed(Threads.ThreadManagementService, {
      ...threads,
      sendToThread: (input) =>
        Effect.gen(function* () {
          sends++;
          yield* threads.sendToThread(input);
          yield* store
            .commit({
              actor: { kind: "human" },
              command: {
                type: "collaboration.request.withdraw",
                commandId: CommandId.make("withdraw"),
                requestId: "request",
                reason: "Outcome changed",
              },
              now: deliveryNow,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new Threads.ThreadManagementProjectionLoadError({
                    projectId: input.projectId,
                    threadId: input.threadId,
                    cause,
                  }),
              ),
            );
          return yield* new Threads.ThreadManagementProjectionLoadError({
            projectId: input.projectId,
            threadId: input.threadId,
            cause: "Lost response",
          });
        }),
    });
    yield* Effect.gen(function* () {
      const effects = yield* Collaboration.FactoryCollaborationEffects;
      yield* effects.handle(pending);
    }).pipe(Effect.provide(runtime.pipe(Layer.provide(intercepted))));
    const message = (yield* store.snapshot).collaborationMessages[0]!;
    assert.equal(message.delivery.phase, "delivered");
    yield* Effect.gen(function* () {
      const access = yield* Access.FactoryControlAccess;
      assert.equal(
        (yield* access
          .assertDirection({ threadId: apiLead, senderThreadId: deliveryIds.lead })
          .pipe(Effect.flip)).code,
        "permission-denied",
      );
    }).pipe(Effect.provide(Access.layer));
    yield* Effect.gen(function* () {
      const effects = yield* Collaboration.FactoryCollaborationEffects;
      yield* effects.handle(pending);
    }).pipe(Effect.provide(runtime.pipe(Layer.provide(intercepted))));
    assert.equal(sends, 1);
    const records = yield* threads.getThreadRecords(apiLead, ["messages"]);
    assert.equal(records.messages.filter((entry) => entry.text === "Use /v2/profile").length, 1);
  }).pipe(Effect.provide(base)),
);

it.effect("holds peer delivery during project pause and resumes the same durable message", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* Store.FactoryStore;
    const threads = yield* Threads.ThreadManagementService;
    yield* store.commit({
      actor: { kind: "thread", threadId: deliveryIds.lead },
      command: {
        type: "collaboration.message.send",
        commandId: CommandId.make("send"),
        requestId: "request",
        fromAssignmentId: deliveryIds.assignment,
        toAssignmentId: apiAssignment,
        text: "Confirm response fields",
      },
      now: deliveryNow,
    });
    const pending = (yield* store.pending).find(
      (entry) => entry.intent.type === "collaboration.message.deliver",
    )!;
    yield* store.commit({
      actor: { kind: "human" },
      command: { type: "project.pause", commandId: CommandId.make("pause"), projectId: apiProject },
      now: deliveryNow,
    });
    yield* Effect.gen(function* () {
      const effects = yield* Collaboration.FactoryCollaborationEffects;
      yield* effects.handle(pending);
    }).pipe(Effect.provide(runtime));
    assert.equal((yield* threads.getThreadRecords(apiLead, ["messages"])).messages.length, 0);
    assert.equal((yield* store.snapshot).collaborationMessages[0]!.delivery.phase, "pending");
    const sql = yield* SqlClient.SqlClient;
    const paused = yield* store.snapshot;
    const resumed = {
      ...paused,
      controls: paused.controls.filter((entry) => entry.kind !== "project-pause"),
    };
    yield* sql`UPDATE factory_state SET payload_json=${encode(resumed)} WHERE id=1`;
    yield* Effect.gen(function* () {
      const effects = yield* Collaboration.FactoryCollaborationEffects;
      yield* effects.handle(pending);
    }).pipe(Effect.provide(runtime));
    assert.equal((yield* store.snapshot).collaborationMessages[0]!.delivery.phase, "delivered");
  }).pipe(Effect.provide(base)),
);

it.effect(
  "notifies unpaused peers independently and deduplicates their receipts while another manager is paused",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.FactoryStore;
      const threads = yield* Threads.ThreadManagementService;
      yield* store.commit({
        actor: { kind: "thread", threadId: deliveryIds.lead },
        command: {
          type: "collaboration.plan.propose",
          commandId: CommandId.make("plan"),
          requestIds: ["request"],
          text: "An additional endpoint needs approval",
          changes: { kind: "boundary", reason: "Outside original API path" },
        },
        now: deliveryNow,
      });
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "manager.pause",
          commandId: CommandId.make("pause-manager"),
          managerId: deliveryIds.manager,
        },
        now: deliveryNow,
      });
      const pending = (yield* store.pending).find(
        (entry) => entry.intent.type === "collaboration.notify",
      )!;
      const deliver = Effect.gen(function* () {
        const effects = yield* Collaboration.FactoryCollaborationEffects;
        yield* effects.handle(pending);
      }).pipe(Effect.provide(runtime));
      yield* deliver;
      assert.equal(
        (yield* threads.getThreadRecords(deliveryIds.manager, ["messages"])).messages.length,
        0,
      );
      for (const threadId of [apiManager, deliveryIds.lead, apiLead])
        assert.equal((yield* threads.getThreadRecords(threadId, ["messages"])).messages.length, 1);
      yield* deliver;
      for (const threadId of [apiManager, deliveryIds.lead, apiLead])
        assert.equal((yield* threads.getThreadRecords(threadId, ["messages"])).messages.length, 1);
      assert.isTrue((yield* store.pending).some((entry) => entry.id === pending.id));
      const sql = yield* SqlClient.SqlClient;
      const paused = yield* store.snapshot;
      yield* sql`UPDATE factory_state SET payload_json=${encode({ ...paused, controls: paused.controls.filter((entry) => entry.kind !== "manager-pause") })} WHERE id=1`;
      yield* deliver;
      assert.equal(
        (yield* threads.getThreadRecords(deliveryIds.manager, ["messages"])).messages.length,
        1,
      );
      assert.isFalse((yield* store.pending).some((entry) => entry.id === pending.id));
    }).pipe(Effect.provide(base)),
);

it.effect(
  "persists incident targets and retries a failed boundary stop without skipping the team",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.FactoryStore;
      const threads = yield* Threads.ThreadManagementService;
      const stopped: ThreadId[] = [];
      let failBoundary = true;
      const holds: boolean[] = [];
      const adapters = Layer.mergeAll(
        Layer.mock(Boundaries.FactoryBoundaryExecution)({
          setIncidentHold: (input) =>
            Effect.gen(function* () {
              holds.push(input.held);
              if (failBoundary)
                return yield* new FactoryError({
                  code: "execution-unavailable",
                  detail: "Docker unavailable",
                });
            }),
        }),
        Layer.mock(Handover.FactoryHandover)({
          stopTeam: (input) =>
            Effect.sync(() => {
              stopped.push(input.threadId);
            }),
        }),
        Layer.mock(Preview.FactoryPreviewService)({ reconcile: Effect.void }),
      );
      const runtime = Collaboration.layer.pipe(
        Layer.provide(Access.layer),
        Layer.provide(adapters),
      );
      const sent = yield* threads.sendToThread({
        projectId: apiProject,
        threadId: apiLead,
        text: "Work waiting for execution",
        commandId: CommandId.make("queued-work"),
        messageId: MessageId.make("queued-work"),
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      });
      const receipt = yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "incident.restrict",
          commandId: CommandId.make("restrict"),
          managerId: apiManager,
          assignmentIds: [apiAssignment],
          activity: "execution",
          reason: "Resolve production outage",
          resumeCondition: { kind: "assignment-concluded", assignmentId: deliveryIds.assignment },
        },
        now: deliveryNow,
      });
      const pending = (yield* store.pending).find(
        (entry) => entry.intent.type === "incident.stop",
      )!;
      const run = (pending: Store.PendingFactoryEffect) =>
        Effect.gen(function* () {
          const effects = yield* Collaboration.FactoryCollaborationEffects;
          yield* effects.handle(pending);
        }).pipe(Effect.provide(runtime));
      yield* run(pending);
      assert.deepEqual(stopped, [apiLead]);
      const failed = (yield* store.snapshot).incidentRestrictions[0]!;
      assert.equal(failed.stop.phase, "failed");
      assert.isDefined(failed.resumeThreadIds);
      const captured = { threads: failed.resumeThreadIds, queues: failed.resumeQueues };
      assert.isTrue(
        failed.resumeQueues?.some((entry) => entry.runIds.includes(sent.run.id)) ||
          failed.resumeThreadIds!.includes(apiLead),
      );
      failBoundary = false;
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "incident.retry",
          commandId: CommandId.make("retry"),
          restrictionId: receipt.restrictionId!,
        },
        now: deliveryNow,
      });
      yield* run((yield* store.pending).find((entry) => entry.intent.type === "incident.stop")!);
      const confirmed = (yield* store.snapshot).incidentRestrictions[0]!;
      assert.equal(confirmed.stop.phase, "confirmed");
      assert.deepEqual(
        { threads: confirmed.resumeThreadIds, queues: confirmed.resumeQueues },
        captured,
      );
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "incident.release",
          commandId: CommandId.make("release"),
          restrictionId: receipt.restrictionId!,
        },
        now: deliveryNow,
      });
      yield* run((yield* store.pending).find((entry) => entry.intent.type === "incident.resume")!);
      assert.equal((yield* store.snapshot).incidentRestrictions[0]!.phase, "released");
      assert.deepEqual(holds, [true, true, false]);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "holds outbound and inbound peer messages during human takeover and delivers once after both handbacks",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.FactoryStore;
      const threads = yield* Threads.ThreadManagementService;
      yield* store.commit({
        actor: { kind: "thread", threadId: deliveryIds.lead },
        command: {
          type: "collaboration.message.send",
          commandId: CommandId.make("send-takeover"),
          requestId: "request",
          fromAssignmentId: deliveryIds.assignment,
          toAssignmentId: apiAssignment,
          text: "Peer coordination waits for handback",
        },
        now: deliveryNow,
      });
      const pending = (yield* store.pending).find(
        (entry) => entry.intent.type === "collaboration.message.deliver",
      )!;
      const deliver = Effect.gen(function* () {
        const effects = yield* Collaboration.FactoryCollaborationEffects;
        yield* effects.handle(pending);
      }).pipe(Effect.provide(runtime));
      const take = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const assignment = (yield* store.snapshot).assignments.find(
            (entry) => entry.threadId === threadId,
          )!;
          yield* store.commit({
            actor: { kind: "human" },
            command: {
              type: "thread.takeover",
              commandId: CommandId.make(`take:${threadId}`),
              threadId,
            },
            controlTarget: {
              threadId,
              assignmentId: assignment.id,
              managerId: assignment.managerId,
              projectId: assignment.projectId,
              ancestorThreadIds: [],
            },
            now: deliveryNow,
          });
        });
      yield* take(apiLead);
      yield* deliver;
      assert.equal((yield* threads.getThreadRecords(apiLead, ["messages"])).messages.length, 0);
      yield* take(deliveryIds.lead);
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "thread.handback",
          commandId: CommandId.make("return-recipient"),
          threadId: apiLead,
        },
        now: deliveryNow,
      });
      yield* deliver;
      assert.equal((yield* threads.getThreadRecords(apiLead, ["messages"])).messages.length, 0);
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "thread.handback",
          commandId: CommandId.make("return-source"),
          threadId: deliveryIds.lead,
        },
        now: deliveryNow,
      });
      yield* deliver;
      yield* deliver;
      assert.equal((yield* threads.getThreadRecords(apiLead, ["messages"])).messages.length, 1);
      assert.equal((yield* store.snapshot).collaborationMessages[0]!.delivery.phase, "delivered");
    }).pipe(Effect.provide(base)),
);
