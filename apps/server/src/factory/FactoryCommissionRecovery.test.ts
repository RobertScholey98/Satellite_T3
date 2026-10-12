import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryBoundaryId,
  FactoryError,
  FactorySnapshot,
  FactorySourceId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryAssignment,
  type FactoryStartingSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  makeProviderAdapter,
  recordProject,
} from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
import { FactoryExecution } from "./FactoryExecution.ts";
import { FactoryHandover } from "./FactoryHandover.ts";
import * as FactoryService from "./FactoryService.ts";
import { FactorySource } from "./FactorySource.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { layerTestDependencies } from "./FactoryService.testkit.ts";

const now = "2026-10-10T12:00:00.000Z";
const projectId = ProjectId.make("factory-recovery-project");
const managerId = ThreadId.make("factory-recovery-manager");
const model = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "approved-complex-lead",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const workflow = { repositoryRoot: "/owned-skills", revision: "a".repeat(40) };
const boundaryId = FactoryBoundaryId.make("factory-recovery-boundary");
const source: FactoryStartingSource = {
  id: FactorySourceId.make("factory-recovery-source"),
  projectId,
  revision: "b".repeat(40),
  sourceDigest: "c".repeat(64),
  branch: "main",
  origin: "project",
  capturedAt: now,
  fileCount: 2,
  stagedPaths: [],
  unstagedPaths: [],
  untrackedPaths: [],
  deletedPaths: [],
  excludedPaths: [],
};
const initial: FactorySnapshot = {
  ...initialFactorySnapshot(),
  modelDefaults: {
    approvedModels: [model],
    preferences: [{ role: "lead", complexity: "complex", selection: model }],
  },
  managers: [
    {
      id: managerId,
      threadId: managerId,
      projectId,
      role: "project",
      name: "Recovery manager",
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
  boundaries: [
    {
      id: boundaryId,
      projectId,
      workflow,
      profileId: "onboarding-profile",
      sourceRevision: "d".repeat(40),
      protectedPaths: ["AGENTS.md"],
      writablePaths: ["src/app.ts"],
      creatableDirectories: ["src/features"],
      gates: [],
      approvedAt: now,
    },
  ],
};
const command = {
  type: "assignment.commission",
  commandId: CommandId.make("factory-recovery-commission"),
  managerId,
  title: "Recover the implementation team",
  scope: {
    description: "Implement the approved application behavior.",
    completionCondition: "Verify behavior and merge the reviewed PR.",
    requiresPullRequest: true,
  },
  complexity: "complex",
  kind: "implementation",
  sourcePaths: ["src/app.ts"],
  creatableDirectories: ["src/features"],
} as const;
const human = { kind: "human" } as const;
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));

const pins = (assignment: FactoryAssignment) => ({
  id: assignment.id,
  threadId: assignment.threadId,
  managerId: assignment.managerId,
  scope: assignment.scope,
  startingSource: assignment.startingSource,
  workflow: assignment.workflow,
  modelSelection: assignment.modelSelection,
  modelChoice: assignment.modelChoice,
  modelPolicy: assignment.modelPolicy,
  grantedPolicy: assignment.grantedPolicy,
  grant: assignment.grant,
  authorization: assignment.authorization,
});

it.effect(
  "recovers persisted implementation preparation and an accepted launch across SQLite and service recreation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "satellite-factory-recovery-",
      });
      const filename = path.join(directory, "state.sqlite");
      const captures = yield* Ref.make(0);
      const preparations = yield* Ref.make(0);
      const sends = yield* Ref.make(0);

      const phase = <A, E, R>(
        body: Effect.Effect<A, E, R>,
        lostReceipt?: "assignment.prepared" | "thread.launch.recorded",
        seed = false,
      ) => {
        const database = SqlitePersistence.layerFromPath(filename).pipe(
          Layer.provide(NodeServices.layer),
        );
        const registry = ProviderAdapterRegistry.layerFromAdapters([
          makeProviderAdapter(model.instanceId),
        ]);
        const orchestration = ProviderReplayHarness.layerWithRegistry(
          { name: "factory-commission-recovery" },
          registry,
          { databaseLayer: database, runEffectWorker: false },
        );
        const runtime = Layer.mergeAll(
          FactoryStore.layer,
          ProjectionStore.layer,
          ProjectStore.layer,
          ThreadManagement.layer,
        ).pipe(Layer.provideMerge(orchestration), Layer.provideMerge(database));
        return Effect.gen(function* () {
          const store = yield* FactoryStore.FactoryStore;
          const threads = yield* ThreadManagement.ThreadManagementService;
          if (seed) {
            yield* recordProject({
              projectId,
              title: "Recovery project",
              workspaceRoot: "/project",
            });
            yield* threads.dispatch({
              type: "thread.create",
              commandId: CommandId.make("recovery-manager-create"),
              threadId: managerId,
              projectId,
              title: "Recovery manager",
              modelSelection: model,
              runtimeMode: "approval-required",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO factory_state (id, revision, payload_json)
            VALUES (1, ${initial.revision}, ${encodeSnapshot(initial)})`;
          }
          return yield* body.pipe(
            Effect.provide(FactoryService.layer.pipe(Layer.provide(layerTestDependencies))),
            Effect.provideService(FactoryStore.FactoryStore, {
              ...store,
              finishEffect: (input) =>
                input.command.type === lostReceipt
                  ? Effect.fail(
                      new FactoryError({
                        code: "persistence",
                        detail: "Lost acknowledgement at process exit.",
                      }),
                    )
                  : store.finishEffect(input),
            }),
            Effect.provideService(ThreadManagement.ThreadManagementService, {
              ...threads,
              sendToThread: (input) =>
                Ref.update(sends, (count) => count + 1).pipe(
                  Effect.andThen(threads.sendToThread(input)),
                ),
            }),
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(ProjectService)({}),
                Layer.succeed(FactoryExecution, {
                  qualify: () => Effect.die("Recovery must not repeat onboarding."),
                  assertSelectionFor: () => Effect.void,
                  assertDelegationFor: () => Effect.void,
                  runtimePolicyFor: () =>
                    Effect.succeed({
                      boundaryId: "implementation-profile",
                      dockerContext: "default",
                      imageId: "image",
                      projectSnapshotPath: "/confined/project",
                      workflowSnapshotPath: "/confined/workflow",
                      runtimePath: "/confined/runtime",
                    }),
                }),
                Layer.mock(FactoryBoundaryExecution)({
                  prepare: (input) =>
                    Effect.gen(function* () {
                      assert.equal(input.startingSourceId, source.id);
                      assert.equal(input.boundaryId, boundaryId);
                      assert.deepStrictEqual(input.grant.sourcePaths, command.sourcePaths);
                      yield* Ref.update(preparations, (count) => count + 1);
                      return {
                        status: "qualified" as const,
                        profileId: "implementation-profile",
                        checkedAt: now,
                      };
                    }),
                }),
                Layer.mock(FactorySource)({
                  capture: () =>
                    Effect.gen(function* () {
                      assert.equal(
                        yield* Ref.get(captures),
                        0,
                        "Restart must reuse the captured source.",
                      );
                      yield* Ref.update(captures, (count) => count + 1);
                      return source;
                    }),
                }),
                Layer.mock(FactoryHandover)({}),
              ),
            ),
          );
        }).pipe(Effect.provide(runtime));
      };

      const before = yield* phase(
        Effect.gen(function* () {
          const factory = yield* FactoryService.FactoryService;
          yield* factory.drain;
          const accepted = yield* factory.dispatch(human, command);
          yield* factory.drain;
          const assignment = (yield* factory.snapshot({})).assignments[0]!;
          assert.equal(assignment.id, accepted.assignmentId);
          assert.equal(assignment.preparation, "preparing");
          assert.equal(assignment.threadStatus, "pending");
          assert.deepStrictEqual(assignment.startingSource, source);
          assert.deepStrictEqual(assignment.modelSelection, model);
          assert.equal(assignment.modelChoice?.source, "default-preference");
          assert.deepStrictEqual(assignment.scope, command.scope);
          assert.deepStrictEqual(assignment.workflow, workflow);
          const pending = yield* (yield* FactoryStore.FactoryStore).pending;
          assert.equal(pending.length, 1);
          assert.equal(pending[0]!.intent.type, "assignment.prepare");
          assert.equal(yield* Ref.get(sends), 0);
          return pins(assignment);
        }),
        "assignment.prepared",
        true,
      );

      yield* phase(
        Effect.gen(function* () {
          const factory = yield* FactoryService.FactoryService;
          yield* factory.drain;
          const assignment = (yield* factory.snapshot({})).assignments[0]!;
          assert.deepStrictEqual(pins(assignment), before);
          assert.equal(assignment.preparation, "ready");
          assert.equal(assignment.threadStatus, "created");
          assert.equal(assignment.launchStatus, "pending");
          const projection =
            yield* (yield* ThreadManagement.ThreadManagementService).getThreadProjection(
              assignment.threadId,
            );
          assert.equal(projection.messages.length, 1);
          assert.equal(projection.runs.length, 1);
          const pending = yield* (yield* FactoryStore.FactoryStore).pending;
          assert.equal(pending.length, 1);
          assert.equal(pending[0]!.intent.type, "thread.launch");
        }),
        "thread.launch.recorded",
      );

      yield* phase(
        Effect.gen(function* () {
          const factory = yield* FactoryService.FactoryService;
          yield* factory.drain;
          const snapshot = yield* factory.snapshot({});
          assert.equal(snapshot.assignments.length, 1);
          const assignment = snapshot.assignments[0]!;
          assert.deepStrictEqual(pins(assignment), before);
          assert.equal(assignment.status, "running");
          assert.equal(assignment.launchStatus, "delivered");
          assert.equal((yield* factory.dispatch(human, command)).assignmentId, before.id);
          yield* factory.drain;
          const projection =
            yield* (yield* ThreadManagement.ThreadManagementService).getThreadProjection(
              assignment.threadId,
            );
          assert.equal(projection.messages.length, 1);
          assert.equal(projection.runs.length, 1);
          assert.equal(projection.messages[0]!.id, `factory:${before.threadId}:initial-message`);
          assert.equal(projection.thread.lineage.parentThreadId, null);
          assert.equal((yield* (yield* FactoryStore.FactoryStore).pending).length, 0);
        }),
      );
      assert.equal(yield* Ref.get(captures), 1);
      assert.equal(yield* Ref.get(preparations), 2);
      assert.equal(yield* Ref.get(sends), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
