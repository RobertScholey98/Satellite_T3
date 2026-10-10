import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactoryError,
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
import * as Service from "./FactoryService.ts";
import * as Integration from "./FactoryIntegrationEffects.ts";
import * as IntegrationExecution from "./FactoryIntegrationExecution.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Boundaries from "./FactoryBoundaryExecution.ts";
import * as Execution from "./FactoryExecution.ts";
import * as Source from "./FactorySource.ts";
import * as Handover from "./FactoryHandover.ts";
import {
  deliveryFixture,
  deliveryIds,
  deliveryNow,
  deliverySelection,
} from "./FactoryDelivery.testkit.ts";

const api = {
  project: ProjectId.make("api"),
  manager: ThreadId.make("api-manager"),
  lead: ThreadId.make("api-lead"),
  assignment: FactoryAssignmentId.make("api-assignment"),
  boundary: FactoryBoundaryId.make("api-boundary"),
};
const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const base = Layer.mergeAll(Store.layer, Threads.layer).pipe(
  Layer.provideMerge(Satellite.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "recovers the requester-owned integration thread after a lost receipt while owner grants remain pending",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.FactoryStore;
      const threads = yield* Threads.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const initial = deliveryFixture();
      const manager = initial.managers[0]!;
      const source = initial.assignments[0]!;
      const seed: FactorySnapshot = {
        ...initial,
        managers: [
          ...initial.managers,
          {
            ...manager,
            role: "project",
            id: api.manager,
            threadId: api.manager,
            projectId: api.project,
            name: "API manager",
            boundaryId: api.boundary,
          },
        ],
        assignments: [
          ...initial.assignments,
          {
            ...source,
            id: api.assignment,
            managerId: api.manager,
            threadId: api.lead,
            projectId: api.project,
            grant: { ...source.grant!, boundaryId: api.boundary },
          },
        ],
        boundaries: [deliveryIds, api].map((ids) => ({
          id: ids.boundary,
          projectId: ids.project,
          profileId: `discovery:${ids.project}`,
          sourceRevision: "base",
          workflow: manager.workflow,
          approvedAt: deliveryNow,
          writablePaths: ["src/feature.ts", "tests/contract.ts"],
          protectedPaths: ["AGENTS.md"],
          creatableDirectories: [],
          gates: [],
        })),
        crossProjectRequests: [
          {
            id: "request-api",
            origin: { kind: "assignment", assignmentId: deliveryIds.assignment },
            originManagerId: deliveryIds.manager,
            originThreadId: deliveryIds.manager,
            originalLeadThreadId: deliveryIds.lead,
            receiverManagerId: api.manager,
            outcome: "Expose the feature API",
            acceptanceConditions: "Both implementations agree",
            compatibility: "Preserve existing clients",
            generation: 1,
            lifecycle: {
              phase: "accepted",
              support: { assignmentId: api.assignment, dedicated: false },
              notifiedConclusionId: null,
            },
            createdAt: deliveryNow,
            updatedAt: deliveryNow,
          },
        ],
      };
      yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,${seed.revision},${encode(seed)})`;
      for (const projectId of [deliveryIds.project, api.project])
        yield* Satellite.recordProject({
          projectId,
          title: projectId,
          workspaceRoot: `/fixture/${projectId}`,
        });
      for (const [threadId, projectId] of [
        [deliveryIds.manager, deliveryIds.project],
        [deliveryIds.lead, deliveryIds.project],
        [api.manager, api.project],
        [api.lead, api.project],
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
        Layer.mock(Execution.FactoryExecution)({ assertSelectionFor: () => Effect.void }),
        Layer.mock(Source.FactorySource)({}),
        Layer.mock(Boundaries.FactoryBoundaryExecution)({ stop: () => Effect.void }),
        Layer.mock(Handover.FactoryHandover)({ stopTeam: () => Effect.void }),
        Layer.mock(IntegrationExecution.FactoryIntegrationExecution)({}),
      );
      const runtime = Service.layer.pipe(
        Layer.provideMerge(Integration.layer.pipe(Layer.provide(Access.layer))),
        Layer.provide(external),
      );
      let refuseReceipt = true;
      const uncertainStore = Layer.succeed(Store.FactoryStore, {
        ...store,
        finishEffect: (input) =>
          input.command.type === "integration.thread.created" && refuseReceipt
            ? Effect.fail(
                new FactoryError({ code: "persistence", detail: "Injected lost creation receipt" }),
              )
            : store.finishEffect(input),
      });
      const commission = {
        type: "integration.commission",
        commandId: CommandId.make("commission-integration"),
        managerId: deliveryIds.manager,
        requestIds: ["request-api"],
        title: "Verify frontend and API together",
        description: "Check the shared contract with project-owned test access",
        complexity: "standard",
        coordinatorProjectId: deliveryIds.project,
      } as const;
      const result = yield* Effect.gen(function* () {
        const factory = yield* Service.FactoryService;
        const result = yield* factory.dispatch(
          { kind: "thread", threadId: deliveryIds.manager },
          commission,
        );
        yield* factory.drain;
        const state = yield* store.snapshot;
        const assignment = state.assignments.find((entry) => entry.id === result.assignmentId)!;
        assert.isDefined(assignment);
        assert.equal(assignment.managerId, deliveryIds.manager);
        assert.equal(assignment.projectId, deliveryIds.project);
        assert.equal(assignment.threadStatus, "pending");
        assert.equal(
          (yield* threads.getThreadShell(assignment.threadId))?.projectId,
          deliveryIds.project,
        );
        assert.equal(
          (yield* threads.getThreadRecords(assignment.threadId, ["runs"])).runs.length,
          0,
        );
        return result;
      }).pipe(Effect.provide(runtime.pipe(Layer.provide(uncertainStore))), Effect.scoped);
      refuseReceipt = false;
      yield* Effect.gen(function* () {
        const factory = yield* Service.FactoryService;
        yield* factory.recover;
        yield* factory.drain;
        assert.deepEqual(
          yield* factory.dispatch({ kind: "thread", threadId: deliveryIds.manager }, commission),
          result,
        );
        const state = yield* store.snapshot;
        const integration = state.integrations.find((entry) => entry.id === result.integrationId)!;
        const assignment = state.assignments.find((entry) => entry.id === result.assignmentId)!;
        assert.equal(integration.phase, "awaiting-grants");
        assert.equal(assignment.threadStatus, "created");
        assert.equal(assignment.launchStatus, "pending");
        const group = state.mergeGroups.find((entry) => entry.integrationId === integration.id)!;
        assert.isDefined(group);
        const review = yield* factory.mergeGroupGet({ groupId: group.id });
        assert.equal(review.integrationLeadThreadId, assignment.threadId);
        assert.equal(review.readiness.status, "waiting");
        assert.equal(review.readiness.canApprove, false);
        assert.equal(review.readiness.canRequestMerge, false);
        assert.equal(review.readiness.members.length, 2);
        assert.equal(review.currentReview, null);
        assert.equal(
          state.assignments.filter((entry) => entry.integrationId === integration.id).length,
          1,
        );
        assert.deepEqual(assignment.grant?.sourcePaths, []);
        assert.equal(
          (yield* threads.getThreadRecords(assignment.threadId, ["runs"])).runs.length,
          0,
        );
        assert.equal(
          (yield* factory.snapshot({ projectId: api.project })).integrations[0]?.id,
          integration.id,
        );
        assert.equal(
          (yield* factory.snapshot({ projectId: ProjectId.make("unrelated") })).integrations.length,
          0,
        );
        assert.equal(
          (yield* factory.snapshot({ projectId: api.project })).mergeGroups[0]?.id,
          group.id,
        );
        assert.deepEqual(
          (yield* factory.snapshot({ projectId: ProjectId.make("unrelated") })).mergeGroups,
          [],
        );
        assert.equal(
          (yield* factory.mergeGroupGet({ groupId: "unrelated" }).pipe(Effect.flip)).code,
          "invalid-state",
        );
      }).pipe(Effect.provide(runtime), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(base)),
);
