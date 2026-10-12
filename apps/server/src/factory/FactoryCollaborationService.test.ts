import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactorySnapshot,
  FactorySourceId,
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
import * as Service from "./FactoryService.ts";
import * as Collaboration from "./FactoryCollaborationEffects.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Boundaries from "./FactoryBoundaryExecution.ts";
import * as Execution from "./FactoryExecution.ts";
import * as Source from "./FactorySource.ts";
import * as Handover from "./FactoryHandover.ts";
import * as Preview from "./FactoryPreviewService.ts";
import {
  deliveryFixture,
  deliveryIds,
  deliveryNow,
  deliverySelection,
} from "./FactoryDelivery.testkit.ts";
import { layerTestDependencies } from "./FactoryService.testkit.ts";

const apiProject = ProjectId.make("api-project");
const apiManager = ThreadId.make("api-manager");
const apiBoundary = FactoryBoundaryId.make("api-boundary");
const human = { kind: "human" } as const;
const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const base = Layer.mergeAll(Store.layer, Threads.layer).pipe(
  Layer.provideMerge(Satellite.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "commissions one receiver-owned lead and keeps direct collaboration and persisted requests scoped",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.FactoryStore;
      const threads = yield* Threads.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const initial = deliveryFixture();
      const manager = initial.managers[0]!;
      assert.equal(manager.role, "project");
      const seed: FactorySnapshot = {
        ...initial,
        managers: [
          ...initial.managers,
          {
            ...manager,
            role: "project",
            id: apiManager,
            threadId: apiManager,
            projectId: apiProject,
            name: "API manager",
            boundaryId: apiBoundary,
          },
        ],
        boundaries: [
          {
            id: apiBoundary,
            projectId: apiProject,
            profileId: "api-discovery",
            sourceRevision: "api-base",
            workflow: manager.workflow,
            approvedAt: deliveryNow,
            writablePaths: ["src/api.ts"],
            protectedPaths: ["AGENTS.md"],
            creatableDirectories: [],
            gates: [],
          },
        ],
      };
      yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,${seed.revision},${encode(seed)})`;
      for (const projectId of [deliveryIds.project, apiProject])
        yield* Satellite.recordProject({
          projectId,
          title: projectId,
          workspaceRoot: `/fixture/${projectId}`,
        });
      for (const [threadId, projectId] of [
        [deliveryIds.manager, deliveryIds.project],
        [deliveryIds.lead, deliveryIds.project],
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
      const external = Layer.mergeAll(
        Layer.mock(Execution.FactoryExecution)({
          assertSelectionFor: () => Effect.void,
          runtimePolicyFor: (threadId) =>
            Effect.succeed({
              boundaryId: `profile:${threadId}`,
              dockerContext: "fixture",
              imageId: "fixture",
              projectSnapshotPath: "/fixture/api",
              workflowSnapshotPath: "/fixture/workflow",
              runtimePath: "/fixture/runtime",
            }),
        }),
        Layer.mock(Source.FactorySource)({
          capture: (input) =>
            Effect.succeed({
              id: FactorySourceId.make(`source:${input.requestId}`),
              projectId: input.projectId,
              revision: "api-base",
              sourceDigest: "api-source",
              branch: "main",
              origin: "project",
              capturedAt: deliveryNow,
              fileCount: 2,
              stagedPaths: [],
              unstagedPaths: [],
              untrackedPaths: [],
              deletedPaths: [],
              excludedPaths: [],
            }),
        }),
        Layer.mock(Boundaries.FactoryBoundaryExecution)({
          prepare: () =>
            Effect.succeed({
              status: "qualified",
              profileId: "api-implementation",
              checkedAt: deliveryNow,
            }),
          stop: () => Effect.void,
          setIncidentHold: () => Effect.void,
        }),
        Layer.mock(Handover.FactoryHandover)({ stopTeam: () => Effect.void }),
        Layer.mock(Preview.FactoryPreviewService)({ reconcile: Effect.void }),
      );
      const runtime = Service.layer.pipe(
        Layer.provideMerge(Collaboration.layer.pipe(Layer.provide(Access.layer))),
        Layer.provide(external),
        Layer.provide(layerTestDependencies),
      );
      yield* Effect.gen(function* () {
        const factory = yield* Service.FactoryService;
        const request = yield* factory.dispatch(
          { kind: "thread", threadId: deliveryIds.manager },
          {
            type: "collaboration.request.create",
            commandId: CommandId.make("request-api"),
            origin: { kind: "assignment", assignmentId: deliveryIds.assignment },
            receiverManagerId: apiManager,
            outcome: "Expose the feature API",
            acceptanceConditions: "Return the agreed response shape",
            compatibility: "Keep the existing endpoint compatible",
          },
        );
        assert.isDefined(request.requestId);
        const accept = {
          type: "collaboration.request.respond",
          commandId: CommandId.make("accept-api"),
          requestId: request.requestId!,
          response: {
            kind: "accept",
            support: {
              kind: "commission",
              work: {
                title: "Implement the API",
                kind: "implementation",
                complexity: "standard",
                sourcePaths: ["src/api.ts"],
                creatableDirectories: [],
                scope: {
                  description: "Expose the agreed API",
                  completionCondition: "Reviewed PR merged",
                  requiresPullRequest: true,
                },
              },
            },
          },
        } as const;
        const accepted = yield* factory.dispatch({ kind: "thread", threadId: apiManager }, accept);
        assert.deepEqual(
          yield* factory.dispatch({ kind: "thread", threadId: apiManager }, accept),
          accepted,
        );
        yield* factory.drain;
        const snapshot = yield* store.snapshot;
        const support = snapshot.assignments.find((entry) => entry.id === accepted.assignmentId)!;
        assert.isDefined(support);
        assert.equal(support.managerId, apiManager);
        assert.equal(support.projectId, apiProject);
        assert.equal(support.threadStatus, "created");
        assert.equal(support.launchStatus, "delivered");
        assert.deepEqual(support.grant?.sourcePaths, ["src/api.ts"]);
        assert.equal(
          snapshot.assignments.filter((entry) => entry.managerId === apiManager).length,
          1,
        );
        const shell = yield* threads.getThreadShell(support.threadId);
        assert.equal(shell?.projectId, apiProject);
        assert.equal(shell?.lineage.parentThreadId, null);
        yield* factory.dispatch(
          { kind: "thread", threadId: deliveryIds.lead },
          {
            type: "collaboration.message.send",
            commandId: CommandId.make("api-question"),
            requestId: request.requestId!,
            fromAssignmentId: deliveryIds.assignment,
            toAssignmentId: support.id,
            text: "Can this response include the stable item ID?",
          },
        );
        yield* factory.drain;
        const delivered = (yield* store.snapshot).collaborationMessages[0]!;
        assert.equal(delivered.delivery.phase, "delivered");
        const messages = (yield* threads.getThreadRecords(support.threadId, ["messages"])).messages;
        assert.equal(messages.filter((entry) => entry.text.includes("stable item ID")).length, 1);
        assert.deepEqual(
          (yield* factory.snapshot({ projectId: apiProject })).assignments.map((entry) => entry.id),
          [support.id],
        );
        assert.equal(
          (yield* factory.snapshot({ projectId: apiProject })).crossProjectRequests.length,
          1,
        );
        assert.equal(
          (yield* factory.snapshot({ projectId: ProjectId.make("unrelated") })).crossProjectRequests
            .length,
          0,
        );
        yield* factory.dispatch(human, {
          type: "collaboration.request.withdraw",
          commandId: CommandId.make("withdraw-api"),
          requestId: request.requestId!,
          reason: "Feature no longer needed",
        });
        yield* factory.drain;
        const final = yield* store.snapshot;
        assert.equal(final.crossProjectRequests[0]!.lifecycle.phase, "withdrawn");
        assert.equal(
          final.controls.some(
            (control) => control.kind === "cancellation" && control.assignmentId === support.id,
          ),
          true,
        );
      }).pipe(Effect.provide(runtime));
      yield* Effect.gen(function* () {
        const reopened = yield* Store.FactoryStore;
        const persisted = yield* reopened.snapshot;
        assert.equal(persisted.crossProjectRequests.length, 1);
        assert.equal(persisted.crossProjectRequests[0]!.lifecycle.phase, "withdrawn");
        assert.equal(persisted.collaborationMessages[0]!.delivery.phase, "delivered");
        assert.equal(
          persisted.assignments.filter((entry) => entry.managerId === apiManager).length,
          1,
        );
      }).pipe(Effect.provide(Layer.fresh(Store.layer)));
    }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect(
  "stops dedicated support from a fresh worker after restart and spares shared support",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.FactoryStore;
      const sql = yield* SqlClient.SqlClient;
      const initial = deliveryFixture();
      const manager = initial.managers[0]!;
      assert.equal(manager.role, "project");
      const origin = initial.assignments[0]!;
      const dedicated = FactoryAssignmentId.make("api-dedicated");
      const shared = FactoryAssignmentId.make("api-shared");
      const support = (assignmentId: FactoryAssignmentId) => ({
        ...origin,
        id: assignmentId,
        managerId: apiManager,
        projectId: apiProject,
        threadId: ThreadId.make(`${assignmentId}-lead`),
      });
      const accepted = (id: string, assignmentId: FactoryAssignmentId, isDedicated: boolean) => ({
        id,
        origin: { kind: "assignment" as const, assignmentId: origin.id },
        originManagerId: deliveryIds.manager,
        originThreadId: deliveryIds.lead,
        originalLeadThreadId: deliveryIds.lead,
        receiverManagerId: apiManager,
        outcome: `Outcome ${id}`,
        acceptanceConditions: "Usable by the frontend",
        compatibility: "Additive",
        generation: 1,
        lifecycle: {
          phase: "accepted" as const,
          support: { assignmentId, dedicated: isDedicated },
          notifiedConclusionId: null,
        },
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      });
      const seed: FactorySnapshot = {
        ...initial,
        managers: [
          ...initial.managers,
          {
            ...manager,
            role: "project",
            id: apiManager,
            threadId: apiManager,
            projectId: apiProject,
          },
        ],
        assignments: [...initial.assignments, support(dedicated), support(shared)],
        crossProjectRequests: [
          accepted("request-dedicated", dedicated, true),
          accepted("request-shared", shared, false),
        ],
      };
      yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,${seed.revision},${encode(seed)})`;
      // The cancellation is durable before any worker runs, as if the process stopped here.
      yield* store.commit({
        actor: human,
        command: {
          type: "assignment.cancel",
          commandId: CommandId.make("cancel-origin"),
          assignmentId: origin.id,
        },
        now: deliveryNow,
      });
      assert.isTrue(
        (yield* store.pending).some(
          (entry) =>
            entry.intent.type === "control.stop" &&
            entry.intent.controlId === `cancellation:${dedicated}`,
        ),
      );
      const stopped: FactoryAssignmentId[] = [];
      const external = Layer.mergeAll(
        Layer.mock(Execution.FactoryExecution)({
          assertSelectionFor: () => Effect.void,
        }),
        Layer.mock(Source.FactorySource)({}),
        Layer.mock(Boundaries.FactoryBoundaryExecution)({
          stop: (assignmentId) => Effect.sync(() => void stopped.push(assignmentId)),
          setIncidentHold: () => Effect.void,
        }),
        Layer.mock(Handover.FactoryHandover)({ stopTeam: () => Effect.void }),
        Layer.mock(Preview.FactoryPreviewService)({ reconcile: Effect.void }),
      );
      const restarted = Service.layer.pipe(
        Layer.provideMerge(Collaboration.layer.pipe(Layer.provide(Access.layer))),
        Layer.provide(external),
        Layer.provide(layerTestDependencies),
        Layer.provideMerge(Layer.fresh(Store.layer)),
      );
      yield* Effect.gen(function* () {
        const factory = yield* Service.FactoryService;
        yield* factory.drain;
        const state = yield* (yield* Store.FactoryStore).snapshot;
        assert.sameMembers(stopped, [origin.id, dedicated]);
        assert.deepEqual(
          state.crossProjectRequests.map((entry) => entry.lifecycle.phase),
          ["withdrawn", "withdrawn"],
        );
        const control = state.controls.find((entry) => entry.id === `cancellation:${dedicated}`);
        assert.equal(control?.kind === "cancellation" ? control.stop.status : null, "confirmed");
        assert.isUndefined(state.assignments.find((entry) => entry.id === shared)?.outcome);
      }).pipe(Effect.provide(restarted));
    }).pipe(Effect.scoped, Effect.provide(base)),
);
