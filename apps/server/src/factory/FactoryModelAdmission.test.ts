import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  FactoryAssignmentId,
  FactoryError,
  FactorySnapshot,
  ProjectId,
  ProviderDriverKind,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type FactoryModelPolicy,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { makeProviderAdapter } from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import migrateFactory from "../persistence/Migrations/067_EngineeringFactory.ts";
import * as FactoryModelAdmission from "./FactoryModelAdmission.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { FactoryExecution } from "./FactoryExecution.ts";
import type { FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";

const now = "2026-10-10T12:00:00.000Z";
const projectId = ProjectId.make("web");
const managerId = ThreadId.make("manager");
const leadId = ThreadId.make("lead");
const onboardingId = ThreadId.make("onboarding");
const childId = ThreadId.make("child");
const grandchildId = ThreadId.make("grandchild");
const independentId = ThreadId.make("independent");
const managerModel = { instanceId: ProviderInstanceId.make("codex"), model: "manager" };
const leadModel = { instanceId: ProviderInstanceId.make("codex"), model: "lead" };
const workerModel = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "worker",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const outsideModel = { instanceId: ProviderInstanceId.make("codex"), model: "outside" };
const unusedProvider = () => Effect.die("Unexpected provider operation in model admission test");
const runtimeProvider: ProviderInstance = {
  instanceId: leadModel.instanceId,
  driverKind: ProviderDriverKind.make("codex"),
  continuationIdentity: {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: "factory-admission",
  },
  displayName: undefined,
  enabled: true,
  orchestrationAdapter: makeProviderAdapter(leadModel.instanceId),
  snapshot: {
    getSnapshot: Effect.succeed({
      instanceId: leadModel.instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "test",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: now,
      models: [],
      slashCommands: [],
      skills: [],
    }),
    resolveMaintenance: unusedProvider,
    refresh: unusedProvider(),
    streamChanges: Stream.empty,
    applyUsageLimits: unusedProvider,
  },
  textGeneration: {
    generateBranchName: unusedProvider,
    generateCommitMessage: unusedProvider,
    generatePrContent: unusedProvider,
    generateThreadTitle: unusedProvider,
  },
};
const policy = {
  approvedModels: [leadModel, workerModel],
  preferences: [],
} satisfies FactoryModelPolicy;
const base = initialFactorySnapshot();
const assignment = {
  id: FactoryAssignmentId.make("implementation"),
  managerId,
  threadId: leadId,
  projectId,
  kind: "implementation",
  status: "running",
  threadStatus: "created",
  launchStatus: "delivered",
  qualification: { status: "qualified", profileId: "qualified", checkedAt: now },
  workflow: { repositoryRoot: "/owned-skills", revision: "workflow-revision" },
  modelSelection: leadModel,
  modelPolicy: policy,
  grantedPolicy: base.defaults,
  wait: null,
  report: null,
  createdAt: now,
  updatedAt: now,
} satisfies FactorySnapshot["assignments"][number];
const snapshot = {
  ...base,
  modelDefaults: policy,
  managers: [
    {
      id: managerId,
      threadId: managerId,
      role: "project",
      projectId,
      name: "Web manager",
      modelSelection: managerModel,
      workflow: assignment.workflow,
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
    assignment,
    {
      ...assignment,
      id: FactoryAssignmentId.make("onboarding"),
      threadId: onboardingId,
      kind: "onboarding",
      modelSelection: managerModel,
    },
  ],
} satisfies FactorySnapshot;

const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const isFactoryError = Schema.is(FactoryError);
const saveSnapshot = (state: FactorySnapshot) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO factory_state (id, revision, payload_json)
      VALUES (1, ${state.revision}, ${encodeSnapshot(state)})
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json`;
  });

const admissionLayer = FactoryModelAdmission.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(FactoryStore.layer, ProjectionStore.layerMemory)),
);
const scenario = <A, E>(
  state: FactorySnapshot,
  effect: Effect.Effect<
    A,
    E,
    | FactoryModelAdmission.FactoryModelAdmission
    | ProjectionStore.ProjectionStoreV2
    | SqlClient.SqlClient
  >,
) =>
  migrateFactory.pipe(
    Effect.andThen(saveSnapshot(state)),
    Effect.andThen(effect.pipe(Effect.provide(admissionLayer))),
    Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

const createThread = (
  threadId: ThreadId,
  lineage: OrchestrationV2AppThread["lineage"] = {
    rootThreadId: threadId,
    parentThreadId: null,
    relationshipToParent: null,
  },
  threadProjectId = projectId,
) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const timestamp = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`create:${threadId}`),
      type: "thread.created",
      threadId,
      occurredAt: timestamp,
      payload: {
        id: threadId,
        projectId: threadProjectId,
        title: threadId,
        createdBy: "user",
        creationSource: "web",
        providerInstanceId: managerModel.instanceId,
        modelSelection: managerModel,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage,
        forkedFrom: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
  });

const persistedStores = Layer.mergeAll(FactoryStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const executionFor = (profile?: FactoryExecutionProfile) =>
  Layer.effect(
    FactoryExecution,
    Effect.gen(function* () {
      const admission = yield* FactoryModelAdmission.FactoryModelAdmission;
      return FactoryExecution.of({
        qualify: () => Effect.die("Unexpected qualification in model admission test"),
        runtimePolicyFor: (threadId, pendingParentThreadId) =>
          Effect.succeed(
            threadId === leadId || pendingParentThreadId === leadId ? profile : undefined,
          ),
        assertSelectionFor: admission.assertSelectionFor,
        assertDelegationFor: admission.assertDelegationFor,
      });
    }),
  ).pipe(Layer.provide(FactoryModelAdmission.layer), Layer.provide(persistedStores));
const execution = executionFor();
const orchestrationLayer = ProviderReplayHarness.layerWithRegistry(
  { name: "factory-model-admission" },
  ProviderAdapterRegistry.layerFromAdapters([makeProviderAdapter(leadModel.instanceId)]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
).pipe(Layer.provide(execution), Layer.provideMerge(persistedStores));
const createLead = (threadId = leadId, selection = leadModel) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Implementation",
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

describe("factory model admission", () => {
  it.effect(
    "restricts independent diagnosis to its pinned model and prohibits delegated children",
    () => {
      const diagnosisId = ThreadId.make("diagnosis");
      const state: FactorySnapshot = {
        ...snapshot,
        auxiliaryThreads: [
          {
            threadId: diagnosisId,
            assignmentId: assignment.id,
            managerId,
            projectId,
            kind: "diagnosis",
            incidentId: "incident",
            cycle: 1,
            status: "running",
            modelSelection: workerModel,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
      return scenario(
        state,
        Effect.gen(function* () {
          const admission = yield* FactoryModelAdmission.FactoryModelAdmission;
          yield* admission.assertSelectionFor(diagnosisId, workerModel);
          assert.equal(
            (yield* admission.assertSelectionFor(diagnosisId, leadModel).pipe(Effect.flip)).code,
            "permission-denied",
          );
          assert.equal(
            (yield* admission.assertDelegationFor(diagnosisId, workerModel).pipe(Effect.flip)).code,
            "permission-denied",
          );
          assert.equal(
            (yield* admission
              .assertSelectionFor(childId, workerModel, diagnosisId)
              .pipe(Effect.flip)).code,
            "permission-denied",
          );
          yield* createThread(childId, {
            rootThreadId: diagnosisId,
            parentThreadId: diagnosisId,
            relationshipToParent: "subagent",
          });
          assert.equal(
            (yield* admission.assertSelectionFor(childId, workerModel).pipe(Effect.flip)).code,
            "permission-denied",
          );
        }),
      );
    },
  );

  it.effect("keeps old leads and descendants managed after replacement", () => {
    const replacementId = ThreadId.make("replacement");
    const state: FactorySnapshot = {
      ...snapshot,
      assignments: snapshot.assignments.map((entry) =>
        entry.id === assignment.id
          ? { ...entry, threadId: replacementId, previousLeadThreadIds: [leadId] }
          : entry,
      ),
    };
    return scenario(
      state,
      Effect.gen(function* () {
        const admission = yield* FactoryModelAdmission.FactoryModelAdmission;
        yield* createThread(childId, {
          rootThreadId: leadId,
          parentThreadId: leadId,
          relationshipToParent: "subagent",
        });
        for (const id of [leadId, childId]) {
          assert.equal(
            (yield* admission.assertSelectionFor(id, leadModel).pipe(Effect.flip)).code,
            "permission-denied",
          );
          assert.equal(
            (yield* admission.assertDelegationFor(id, workerModel).pipe(Effect.flip)).code,
            "permission-denied",
          );
        }
        yield* admission.assertSelectionFor(replacementId, leadModel);
      }),
    );
  });
  it.effect(
    "admits an unpersisted child through its parent without overriding persisted lineage",
    () =>
      scenario(
        snapshot,
        Effect.gen(function* () {
          const admission = yield* FactoryModelAdmission.FactoryModelAdmission;
          yield* admission.assertSelectionFor(childId, workerModel, leadId);
          const unapproved = yield* admission
            .assertSelectionFor(childId, outsideModel, leadId)
            .pipe(Effect.flip);
          assert.equal(unapproved.code, "permission-denied");
          const missing = yield* admission
            .assertSelectionFor(childId, workerModel)
            .pipe(Effect.flip);
          assert.equal(missing.code, "execution-unavailable");
          const unauthorizedParent = yield* admission
            .assertSelectionFor(childId, managerModel, managerId)
            .pipe(Effect.flip);
          assert.equal(unauthorizedParent.code, "permission-denied");
          yield* createThread(
            childId,
            {
              rootThreadId: leadId,
              parentThreadId: leadId,
              relationshipToParent: "subagent",
            },
            ProjectId.make("foreign"),
          );
          const foreign = yield* admission
            .assertSelectionFor(childId, workerModel, leadId)
            .pipe(Effect.flip);
          assert.equal(foreign.code, "execution-unavailable");
          yield* createThread(grandchildId, {
            rootThreadId: onboardingId,
            parentThreadId: onboardingId,
            relationshipToParent: "subagent",
          });
          const substituted = yield* admission
            .assertSelectionFor(grandchildId, workerModel, leadId)
            .pipe(Effect.flip);
          assert.equal(substituted.code, "permission-denied");
        }),
      ),
  );

  it.effect("rejects an unapproved managed startup through the runtime policy boundary", () =>
    Effect.gen(function* () {
      yield* saveSnapshot(snapshot);
      yield* createLead();
      yield* createLead(independentId);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtime = yield* RuntimePolicy.RuntimePolicyV2;
      const lead = yield* projections.getThread(leadId);
      const pending = {
        ...lead,
        id: childId,
        lineage: {
          rootThreadId: leadId,
          parentThreadId: leadId,
          relationshipToParent: "subagent" as const,
        },
      };
      const authorizedChild = yield* runtime.resolve({
        thread: pending,
        modelSelection: workerModel,
      });
      assert.equal(authorizedChild.cwd, "/managed/project");
      assert.isDefined(authorizedChild.factoryExecution);
      const error = yield* runtime
        .resolve({ thread: lead, modelSelection: outsideModel })
        .pipe(Effect.flip);
      assert.equal(error._tag, "RuntimePolicyResolveError");
      assert.instanceOf(error.cause, FactoryError);
      if (isFactoryError(error.cause)) assert.equal(error.cause.code, "permission-denied");
      const independent = yield* projections.getThread(independentId);
      const ordinary = yield* runtime.resolve({
        thread: { ...independent, worktreePath: "/ordinary-worktree" },
        modelSelection: outsideModel,
      });
      assert.equal(ordinary.cwd, "/ordinary-worktree");
      assert.isUndefined(ordinary.factoryExecution);
    }).pipe(
      Effect.provide(
        Layer.merge(
          orchestrationLayer,
          RuntimePolicy.layerFromProjectStore.pipe(
            Layer.provide(
              executionFor({
                boundaryId: "qualified:lead",
                dockerContext: "local",
                imageId: "sha256:verified",
                projectSnapshotPath: "/managed/project",
                workflowSnapshotPath: "/managed/workflow",
                runtimePath: "/managed/lead",
              }),
            ),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                  getInstance: () => Effect.succeed(runtimeProvider),
                }),
                Layer.mock(ProjectStore.ProjectStoreV2)({
                  get: () => Effect.die("Unexpected checkout access"),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("rejects model changes and turn overrides before changing a managed thread", () =>
    Effect.gen(function* () {
      yield* saveSnapshot(snapshot);
      yield* createLead();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      for (const type of ["thread.model-selection.set", "provider.switch"] as const) {
        const denied = yield* orchestrator
          .dispatch({
            type,
            commandId: CommandId.make(`forbidden:${type}`),
            threadId: leadId,
            modelSelection: outsideModel,
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(denied));
      }
      const deniedTurn = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("forbidden:turn"),
          threadId: leadId,
          messageId: MessageId.make("forbidden:message"),
          text: "Use an unapproved model",
          attachments: [],
          modelSelection: outsideModel,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(deniedTurn));
      const unchanged = yield* projections.getThreadProjection(leadId);
      assert.deepStrictEqual(unchanged.thread.modelSelection, leadModel);
      assert.lengthOf(unchanged.runs, 0);
      assert.lengthOf(unchanged.messages, 0);
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("approved:selection"),
        threadId: leadId,
        modelSelection: workerModel,
      });
      assert.deepStrictEqual((yield* projections.getThread(leadId)).modelSelection, workerModel);
      yield* createLead(independentId, outsideModel);
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("ordinary:selection"),
        threadId: independentId,
        modelSelection: managerModel,
      });
      assert.deepStrictEqual(
        (yield* projections.getThread(independentId)).modelSelection,
        managerModel,
      );
    }).pipe(Effect.provide(orchestrationLayer)),
  );

  it.effect(
    "admits only approved delegated workers and does not create rejected child threads",
    () =>
      Effect.gen(function* () {
        yield* saveSnapshot(snapshot);
        yield* createLead();
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start:lead"),
          threadId: leadId,
          messageId: MessageId.make("message:lead"),
          text: "Implement the task with a worker",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const parent = yield* projections.getThreadProjection(leadId);
        const run = parent.runs[0]!;
        const command = {
          type: "delegated_task.request",
          commandId: CommandId.make("delegate:forbidden"),
          parentThreadId: leadId,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: "Implement a focused part",
          modelSelection: outsideModel,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
        } as const;
        const denied = yield* orchestrator.dispatch(command).pipe(Effect.result);
        assert.isTrue(Result.isFailure(denied));
        assert.lengthOf((yield* projections.getThreadProjection(leadId)).subagents, 0);
        assert.deepStrictEqual(
          (yield* projections.getProjectThreads(projectId)).map((thread) => thread.id),
          [leadId],
        );
        yield* orchestrator.dispatch({
          ...command,
          commandId: CommandId.make("delegate:approved"),
          modelSelection: workerModel,
        });
        const updated = yield* projections.getThreadProjection(leadId);
        assert.lengthOf(updated.subagents, 1);
        const worker = yield* projections.getThread(updated.subagents[0]!.childThreadId!);
        assert.deepStrictEqual(worker.modelSelection, workerModel);
        assert.equal(worker.lineage.parentThreadId, leadId);
        yield* saveSnapshot({
          ...snapshot,
          modelDefaults: { approvedModels: [leadModel], preferences: [] },
        });
        const revoked = yield* orchestrator
          .dispatch({
            ...command,
            commandId: CommandId.make("delegate:revoked"),
            modelSelection: workerModel,
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(revoked));
        assert.lengthOf((yield* projections.getThreadProjection(leadId)).subagents, 1);
        assert.lengthOf(yield* projections.getProjectThreads(projectId), 2);
      }).pipe(Effect.provide(orchestrationLayer)),
  );

  it.effect("retains explicit discovery approval without granting managers a worker team", () =>
    scenario(
      { ...snapshot, modelDefaults: { approvedModels: [], preferences: [] } },
      Effect.gen(function* () {
        const admission = yield* FactoryModelAdmission.FactoryModelAdmission;
        for (const threadId of [managerId, onboardingId]) {
          yield* admission.assertSelectionFor(threadId, managerModel);
          const changed = yield* admission
            .assertSelectionFor(threadId, leadModel)
            .pipe(Effect.flip);
          assert.equal(changed.code, "permission-denied");
          const delegated = yield* admission
            .assertDelegationFor(threadId, managerModel)
            .pipe(Effect.flip);
          assert.equal(delegated.code, "permission-denied");
        }
      }),
    ),
  );

  it.effect(
    "allows approved lead and nested team selections while rejecting account and option changes",
    () =>
      scenario(
        snapshot,
        Effect.gen(function* () {
          const admission = yield* FactoryModelAdmission.FactoryModelAdmission;
          yield* createThread(childId, {
            rootThreadId: leadId,
            parentThreadId: leadId,
            relationshipToParent: "subagent",
          });
          yield* createThread(grandchildId, {
            rootThreadId: leadId,
            parentThreadId: childId,
            relationshipToParent: "subagent",
          });
          yield* admission.assertSelectionFor(leadId, leadModel);
          yield* admission.assertDelegationFor(leadId, workerModel);
          for (const threadId of [childId, grandchildId]) {
            yield* admission.assertSelectionFor(threadId, workerModel);
            yield* admission.assertDelegationFor(threadId, workerModel);
            for (const selection of [
              outsideModel,
              { ...workerModel, instanceId: ProviderInstanceId.make("another-account") },
              { ...workerModel, options: [{ id: "reasoningEffort", value: "low" }] },
            ]) {
              const denied = yield* admission
                .assertSelectionFor(threadId, selection)
                .pipe(Effect.flip);
              assert.equal(denied.code, "permission-denied");
            }
          }
        }),
      ),
  );

  it.effect("rechecks current approval and requires the pinned assignment grant", () =>
    scenario(
      snapshot,
      Effect.gen(function* () {
        const admission = yield* FactoryModelAdmission.FactoryModelAdmission;
        yield* admission.assertDelegationFor(leadId, workerModel);
        yield* saveSnapshot({
          ...snapshot,
          modelDefaults: { approvedModels: [leadModel, outsideModel], preferences: [] },
        });
        for (const selection of [workerModel, outsideModel]) {
          const denied = yield* admission.assertDelegationFor(leadId, selection).pipe(Effect.flip);
          assert.equal(denied.code, "permission-denied");
        }
        yield* saveSnapshot({
          ...snapshot,
          modelDefaults: { approvedModels: [], preferences: [] },
          managers: [
            { ...snapshot.managers[0]!, modelOverrides: { approvedModels: [workerModel] } },
          ],
        });
        yield* admission.assertDelegationFor(leadId, workerModel);
        const denied = yield* admission.assertSelectionFor(leadId, leadModel).pipe(Effect.flip);
        assert.equal(denied.code, "permission-denied");
      }),
    ),
  );

  it.effect("keeps unrelated ordinary threads outside factory model policy", () =>
    scenario(
      snapshot,
      Effect.gen(function* () {
        const admission = yield* FactoryModelAdmission.FactoryModelAdmission;
        yield* createThread(independentId);
        yield* admission.assertSelectionFor(independentId, outsideModel);
        yield* admission.assertDelegationFor(independentId, outsideModel);
      }),
    ),
  );

  it.effect(
    "fails closed for missing grants, broken lineage, and foreign-project descendants",
    () => {
      const { modelPolicy: _modelPolicy, ...ungranted } = assignment;
      return scenario(
        { ...snapshot, assignments: [ungranted] },
        Effect.gen(function* () {
          const admission = yield* FactoryModelAdmission.FactoryModelAdmission;
          const unapproved = yield* admission
            .assertSelectionFor(leadId, leadModel)
            .pipe(Effect.flip);
          assert.equal(unapproved.code, "permission-denied");
          yield* createThread(childId, {
            rootThreadId: childId,
            parentThreadId: childId,
            relationshipToParent: "subagent",
          });
          yield* createThread(
            grandchildId,
            { rootThreadId: leadId, parentThreadId: leadId, relationshipToParent: "subagent" },
            ProjectId.make("foreign"),
          );
          for (const threadId of [childId, grandchildId, ThreadId.make("missing")]) {
            const denied = yield* admission
              .assertSelectionFor(threadId, leadModel)
              .pipe(Effect.flip);
            assert.equal(denied.code, "execution-unavailable");
          }
        }),
      );
    },
  );
});
