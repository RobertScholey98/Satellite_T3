import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  FactoryAssignmentId,
  type FactorySnapshot,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import {
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreV2,
} from "../orchestration-v2/ProjectionStore.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import { FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";
import { FactoryStore } from "./FactoryStore.ts";

const owner = ThreadId.make("managed-owner");
const child = ThreadId.make("native-child");
const ordinary = ThreadId.make("ordinary-thread");
const projectId = ProjectId.make("factory-project");
const profileId = "e4556207-a1c8-4b22-861c-4f835a64b713";
const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(FactoryExecutionProfile));

const thread = (
  id: ThreadId,
  parent: ThreadId | null,
  now: DateTime.Utc,
): OrchestrationV2AppThread => ({
  id,
  projectId,
  createdBy: "user",
  creationSource: "web",
  title: id,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: parent,
    relationshipToParent: parent === null ? null : "subagent",
    rootThreadId: parent ?? id,
  },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

it.effect(
  "restored native descendants inherit a separate runtime inside their original qualified boundary",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const now = yield* DateTime.now;
      const initial = initialFactorySnapshot();
      const snapshot: FactorySnapshot = {
        ...initial,
        assignments: [
          {
            id: FactoryAssignmentId.make("assignment"),
            managerId: ThreadId.make("manager"),
            threadId: owner,
            projectId,
            kind: "onboarding",
            status: "running",
            threadStatus: "created",
            launchStatus: "delivered",
            qualification: { status: "qualified", profileId, checkedAt: DateTime.formatIso(now) },
            workflow: { repositoryRoot: "/owned", revision: "pinned" },
            grantedPolicy: initial.defaults,
            wait: null,
            report: null,
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
          },
        ],
      };
      const fixtures = new Map([
        [child, thread(child, owner, now)],
        [ordinary, thread(ordinary, null, now)],
      ]);
      const dependencies = Layer.mergeAll(
        Layer.mock(FactoryStore)({ snapshot: Effect.succeed(snapshot) }),
        Layer.mock(ProjectStoreV2)({}),
        Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(undefined) }),
        Layer.mock(ProcessRunner)({}),
        Layer.mock(ProjectionStoreV2)({
          getThread: (id) =>
            fixtures.has(id)
              ? Effect.succeed(fixtures.get(id)!)
              : Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId: id })),
        }),
        ServerConfig.layerTest(root, root),
      );
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const execution = yield* FactoryExecution.FactoryExecution;
        const directory = path.join(config.stateDir, "factory", "execution", profileId);
        const profile = {
          boundaryId: profileId,
          dockerContext: "local",
          imageId: "sha256:verified",
          projectSnapshotPath: path.join(directory, "project"),
          workflowSnapshotPath: path.join(directory, "workflow"),
          runtimePath: path.join(directory, "sessions"),
        };
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(
          path.join(directory, "profile.json"),
          yield* encodeProfile(profile),
        );
        const parentPolicy = yield* execution.runtimePolicyFor(owner);
        const childPolicy = yield* execution.runtimePolicyFor(child);
        assert.isDefined(parentPolicy);
        assert.isDefined(childPolicy);
        assert.equal(childPolicy?.projectSnapshotPath, parentPolicy?.projectSnapshotPath);
        assert.notEqual(childPolicy?.boundaryId, parentPolicy?.boundaryId);
        assert.notEqual(childPolicy?.runtimePath, parentPolicy?.runtimePath);
        assert.isUndefined(yield* execution.runtimePolicyFor(ordinary));
        assert.isUndefined(yield* execution.runtimePolicyFor(ThreadId.make("not-created-yet")));
        fixtures.set(child, thread(child, ThreadId.make("missing-parent"), now));
        assert.equal(
          (yield* execution.runtimePolicyFor(child).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        const unavailable = yield* execution.qualify({
          projectId,
          modelSelection: { instanceId: ProviderInstanceId.make("unsupported"), model: "test" },
          workflow: { repositoryRoot: "/owned", revision: "pinned" },
        });
        assert.equal(unavailable.status, "unavailable");
      }).pipe(Effect.provide(FactoryExecution.layer.pipe(Layer.provideMerge(dependencies))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
