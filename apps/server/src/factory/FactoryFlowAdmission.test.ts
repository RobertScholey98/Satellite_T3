import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  CommandId,
  type FactoryAssignmentDelivery,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as Boundary from "./FactoryBoundaryExecution.ts";
import { prepareFactoryCodexLaunch } from "./FactoryCodexLaunch.ts";
import {
  deliveryActors,
  deliveryFixture,
  deliveryIds,
  deliveryNow,
} from "./FactoryDelivery.testkit.ts";
import * as Execution from "./FactoryExecution.ts";
import { FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";
import * as FactorySourceTestkit from "./FactorySource.testkit.ts";
import { decide } from "./FactoryState.ts";
import { FactoryStore } from "./FactoryStore.ts";

const profileId = "e4556207-a1c8-4b22-861c-4f835a64b713";
const planningId = "b3b85fdc-cdd0-416f-8cf2-8a4dfb204054";
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const mutation = {
  type: "assignment.file.mutate" as const,
  assignmentId: deliveryIds.assignment,
  commandId: CommandId.make("write-after-admission"),
  expectedEpoch: 1,
  operation: { kind: "write" as const, path: "src/feature.ts", content: "changed" },
};

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(root, root)),
  );
  const directory = path.join(config.stateDir, "factory", "execution", profileId);
  const initial = deliveryFixture();
  let state: FactorySnapshot = {
    ...initial,
    assignments: initial.assignments.map((assignment) => ({
      ...assignment,
      qualification: { status: "qualified", profileId, checkedAt: deliveryNow },
      authorization: { kind: "human", commandId: CommandId.make("authorize") },
    })),
    boundaries: [
      {
        id: deliveryIds.boundary,
        projectId: deliveryIds.project,
        sourceRevision: "base",
        workflow: initial.assignments[0]!.workflow,
        profileId,
        approvedAt: deliveryNow,
        protectedPaths: [],
        writablePaths: ["src/feature.ts"],
        creatableDirectories: [],
        gates: [],
      },
    ],
  };
  const profile: FactoryExecutionProfile = {
    boundaryId: profileId,
    dockerContext: "test",
    imageId: "sha256:approved",
    projectSnapshotPath: path.join(directory, "project"),
    workflowSnapshotPath: path.join(directory, "workflow"),
    runtimePath: path.join(directory, "sessions"),
    startingSourceId: "source",
    startingSourceDigest: "source-digest",
    assignmentWorkspace: {
      assignmentId: deliveryIds.assignment,
      boundaryId: deliveryIds.boundary,
      grantEpoch: 1,
      volumeName: "owned-volume",
      controlsPath: path.join(directory, "controls"),
      revocationPath: path.join(directory, "authority", "revoked.json"),
      workerUid: 10001,
      workerGid: 10001,
    },
  };
  yield* fs.makeDirectory(profile.projectSnapshotPath, { recursive: true });
  yield* fs.makeDirectory(path.dirname(profile.assignmentWorkspace!.revocationPath), {
    recursive: true,
  });
  yield* fs.writeFileString(path.join(directory, "profile.json"), json(profile));
  yield* fs.writeFileString(path.join(directory, "source-paths.json"), json(["src/feature.ts"]));
  const flow = (status: NonNullable<FactoryAssignmentDelivery["flow"]>["status"]) => {
    state = {
      ...state,
      assignments: state.assignments.map((assignment) => ({
        ...assignment,
        delivery: {
          ...assignment.delivery!,
          flow: {
            holdId: "flow-one",
            status,
            qualification: { status: "qualified", profileId: planningId, checkedAt: deliveryNow },
            sourceDigest: "held-source",
          },
        },
      })),
    };
  };
  const processes: string[] = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerConfig.ServerConfig, config),
    Layer.mock(FactoryStore)({ snapshot: Effect.sync(() => state) }),
    Layer.mock(ProjectStoreV2)({}),
    Layer.mock(ProjectionStoreV2)({}),
    Layer.mock(ProviderInstanceRegistry)({}),
    Layer.mock(ProcessRunner)({
      run: (input) =>
        Effect.sync(() => {
          processes.push(input.command);
        }).pipe(Effect.andThen(Effect.die("Unexpected host process"))),
    }),
    FactorySourceTestkit.layerUnused,
  );
  return { root, directory, state: () => state, flow, profile, processes, dependencies };
});

it.effect(
  "rejects mutation and verification throughout flow suspension before a marker exists",
  () =>
    Effect.gen(function* () {
      const test = yield* setup;
      yield* Effect.gen(function* () {
        const boundary = yield* Boundary.FactoryBoundaryExecution;
        for (const status of ["stopping", "held", "releasing"] as const) {
          test.flow(status);
          for (const command of [mutation, { ...mutation, type: "assignment.verify" as const }]) {
            for (const actor of [deliveryActors.lead, deliveryActors.human])
              assert.isTrue(
                Result.isFailure(decide({ state: test.state(), actor, command, now: deliveryNow })),
              );
          }
          assert.equal(
            (yield* boundary.mutate(mutation).pipe(Effect.flip)).code,
            "execution-unavailable",
          );
          assert.equal(
            (yield* boundary.verify(mutation).pipe(Effect.flip)).code,
            "execution-unavailable",
          );
        }
        assert.deepEqual(test.processes, []);
        test.flow("released");
        assert.isTrue(
          Result.isSuccess(
            decide({
              state: test.state(),
              actor: deliveryActors.lead,
              command: mutation,
              now: deliveryNow,
            }),
          ),
        );
      }).pipe(Effect.provide(Boundary.layer.pipe(Layer.provide(test.dependencies))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "rechecks a previously admitted mutation after the flow stops during filesystem preparation",
  () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const preparing = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const delayedFiles = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        exists: (file) =>
          file.includes(`${path.sep}mutations${path.sep}`)
            ? Deferred.succeed(preparing, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(fs.exists(file)),
              )
            : fs.exists(file),
      });
      assert.isTrue(
        Result.isSuccess(
          decide({
            state: test.state(),
            actor: deliveryActors.lead,
            command: mutation,
            now: deliveryNow,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const boundary = yield* Boundary.FactoryBoundaryExecution;
        const pending = yield* boundary.mutate(mutation).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(preparing);
        test.flow("stopping");
        yield* Deferred.succeed(resume, undefined);
        const result = yield* Fiber.join(pending);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.equal(result.failure.code, "execution-unavailable");
        assert.deepEqual(test.processes, []);
      }).pipe(
        Effect.provide(
          Boundary.layer.pipe(Layer.provide(test.dependencies), Layer.provide(delayedFiles)),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "launches the resolved held-flow planning profile while rejecting foreign or released profiles",
  () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(path.dirname(test.directory), planningId);
      const planning: FactoryExecutionProfile = {
        ...test.profile,
        boundaryId: planningId,
        projectSnapshotPath: path.join(directory, "project"),
        runtimePath: path.join(directory, "sessions"),
        inspection: {
          deliveryHoldId: "flow-one",
          sourceDigest: "held-source",
          evidencePath: path.join(directory, "evidence"),
        },
      };
      yield* fs.makeDirectory(directory);
      yield* fs.writeFileString(path.join(directory, "profile.json"), json(planning));
      const markerPath = path.join(
        path.dirname(test.profile.assignmentWorkspace!.revocationPath),
        "delivery-hold.json",
      );
      const marker = {
        holdId: "flow-one",
        epoch: 1,
        state: "held",
        profileId: planningId,
        sourceDigest: "held-source",
      };
      yield* fs.writeFileString(markerPath, json(marker));
      test.flow("held");
      yield* Effect.gen(function* () {
        const execution = yield* Execution.FactoryExecution;
        const resolved = yield* execution.runtimePolicyFor(deliveryIds.lead);
        assert.isDefined(resolved);
        const launch = (profile: FactoryExecutionProfile) =>
          prepareFactoryCodexLaunch({
            profile,
            settings: decodeCodexSettings({
              homePath: path.join(test.root, "no-auth"),
            }),
            environment: { OPENAI_API_KEY: "test-model-key" },
            containerName: "held-planning",
          });
        const started = yield* launch(resolved!);
        assert.include(
          started.args,
          `type=bind,source=${planning.projectSnapshotPath},target=/workspace,readonly`,
        );
        assert.notInclude(
          started.args,
          "type=volume,source=owned-volume,target=/workspace,volume-nocopy",
        );
        yield* launch({ ...resolved!, profileId }).pipe(Effect.flip);
        yield* fs.writeFileString(markerPath, json({ ...marker, state: "released" }));
        yield* launch(resolved!).pipe(Effect.flip);
      }).pipe(Effect.provide(Execution.layer.pipe(Layer.provide(test.dependencies))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
