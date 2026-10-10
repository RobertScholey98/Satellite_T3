import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryControlId,
  ThreadId,
  type FactorySnapshot,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import {
  ProjectionStoreV2,
  ProjectionStoreThreadNotFoundError,
} from "../orchestration-v2/ProjectionStore.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ProcessRunner } from "../processRunner.ts";
import * as Runtime from "./FactoryExecution.ts";
import { FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";
import { integrationDigest } from "./FactoryIntegrationRuntime.ts";
import { ready, integrated, api } from "./FactoryIntegration.testkit.ts";
import { deliveryIds, deliveryNow, deliverySelection } from "./FactoryDelivery.testkit.ts";
import { FactorySource } from "./FactorySource.ts";
import { FactoryStore } from "./FactoryStore.ts";
import { FactoryControlAccess } from "./FactoryControlAccess.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "gives native and pending integration descendants the pinned multi-project runtime and withdraws it on peer changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fs.makeTempDirectoryScoped();
      const seed = ready();
      let state: FactorySnapshot = seed.state;
      const child = ThreadId.make("integration-native-worker");
      const now = yield* DateTime.now;
      const thread: OrchestrationV2AppThread = {
        id: child,
        projectId: deliveryIds.project,
        createdBy: "user",
        creationSource: "web",
        title: "Integration worker",
        providerInstanceId: deliverySelection.instanceId,
        modelSelection: deliverySelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: integrated.lead,
          rootThreadId: integrated.lead,
          relationshipToParent: "subagent",
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const bytes = Buffer.from("Use approved integration grants.");
      const workflowFile = {
        path: "skills/implementation/SKILL.md",
        content: bytes.toString("base64"),
        digest: Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex"),
        mode: "100644" as const,
      };
      const dependencies = Layer.mergeAll(
        ServerConfig.layerTest(root, root),
        Layer.mock(FactoryStore)({ snapshot: Effect.sync(() => state) }),
        Layer.mock(ProjectStoreV2)({}),
        Layer.mock(ProviderInstanceRegistry)({}),
        Layer.mock(ProcessRunner)({}),
        Layer.mock(FactorySource)({
          readRevision: () => Effect.succeed({ files: [workflowFile], excludedPaths: [] }),
        }),
        Layer.mock(ProjectionStoreV2)({
          getThreadShell: (id) =>
            Effect.succeed(id === child ? { ...liveThreadShell(id), ...thread } : null),
          getThread: (id) =>
            id === child
              ? Effect.succeed(thread)
              : Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId: id })),
        }),
      );
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const runtime = yield* Runtime.FactoryExecution;
        const access = yield* FactoryControlAccess;
        const profileId = "13b2ac6e-1e20-466e-bbbf-c37c29f293da";
        const directory = path.join(config.stateDir, "factory", "execution", profileId);
        const { inputDigest: _ignored, ...manifestFields } = seed.manifest;
        const manifest = {
          ...manifestFields,
          inputDigest: yield* integrationDigest(manifestFields),
        };
        const assignment = state.assignments.find((entry) => entry.id === integrated.assignment)!;
        const profile: FactoryExecutionProfile = {
          boundaryId: profileId,
          profileId,
          dockerContext: "fixture",
          imageId: "sha256:fixture",
          projectSnapshotPath: path.join(directory, "project"),
          workflowSnapshotPath: path.join(directory, "workflow"),
          runtimePath: path.join(directory, "runtime"),
          assignmentWorkspace: {
            assignmentId: assignment.id,
            volumeName: "integration-volume",
            grantEpoch: assignment.grant!.epoch,
            boundaryId: assignment.grant!.boundaryId,
            controlsPath: path.join(directory, "controls"),
            revocationPath: path.join(directory, "authority", "revoked.json"),
            workerUid: 10001,
            workerGid: 10001,
          },
          integration: {
            integrationId: seed.integrationId,
            preparationId: seed.preparationId,
            inputDigest: manifest.inputDigest,
            grantIds: state.integrationGrants.map((entry) => entry.id),
            manifestPath: path.join(directory, "integration.json"),
            stopPath: path.join(directory, "authority", "integration-holds"),
          },
        };
        const identity = {
          profileId,
          assignmentId: assignment.id,
          integrationId: seed.integrationId,
          preparationId: seed.preparationId,
          manifest,
        };
        yield* fs.makeDirectory(
          path.join(profile.workflowSnapshotPath, "skills", "implementation"),
          { recursive: true },
        );
        yield* fs.writeFile(path.join(profile.workflowSnapshotPath, workflowFile.path), bytes);
        yield* fs.writeFileString(path.join(directory, "profile.json"), encode(profile));
        yield* fs.writeFileString(profile.integration!.manifestPath, encode(identity));
        state = {
          ...state,
          assignments: state.assignments.map((entry) =>
            entry.id === assignment.id
              ? {
                  ...entry,
                  qualification: { status: "qualified", profileId, checkedAt: deliveryNow },
                }
              : entry,
          ),
          integrationPreparations: state.integrationPreparations.map((entry) =>
            entry.id === seed.preparationId && entry.lifecycle.phase === "ready"
              ? { ...entry, lifecycle: { ...entry.lifecycle, profileId, manifest } }
              : entry,
          ),
        };
        const approved = state;
        state = {
          ...approved,
          controls: [
            {
              id: FactoryControlId.make("integration-takeover"),
              generation: 1,
              kind: "takeover",
              status: "active",
              threadId: integrated.lead,
              assignmentId: integrated.assignment,
              managerId: deliveryIds.manager,
              parentThreadId: deliveryIds.manager,
              requestedAt: deliveryNow,
              updatedAt: deliveryNow,
            },
          ],
        };
        assert.isDefined(yield* runtime.runtimePolicyFor(child));
        yield* access.assertDirection({ threadId: integrated.lead });
        assert.equal(
          (yield* access
            .assertDirection({ threadId: integrated.lead, senderThreadId: deliveryIds.manager })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.equal(
          (yield* access
            .assertDirection({ threadId: integrated.lead, senderThreadId: deliveryIds.lead })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        state = {
          ...approved,
          controls: [
            {
              id: FactoryControlId.make("requester-takeover"),
              generation: 1,
              kind: "takeover",
              status: "active",
              threadId: deliveryIds.lead,
              assignmentId: deliveryIds.assignment,
              managerId: deliveryIds.manager,
              parentThreadId: deliveryIds.manager,
              requestedAt: deliveryNow,
              updatedAt: deliveryNow,
            },
          ],
        };
        assert.equal(
          (yield* access
            .assertDirection({ threadId: deliveryIds.lead, senderThreadId: integrated.lead })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        state = approved;
        yield* access.assertDirection({
          threadId: deliveryIds.lead,
          senderThreadId: integrated.lead,
        });
        yield* access.assertDirection({
          threadId: integrated.lead,
          senderThreadId: deliveryIds.lead,
        });
        const childPolicy = yield* runtime.runtimePolicyFor(child);
        assert.equal(childPolicy?.integration?.inputDigest, manifest.inputDigest);
        assert.equal(childPolicy?.assignmentWorkspace?.volumeName, "integration-volume");
        assert.equal(
          (yield* runtime.runtimePolicyFor(ThreadId.make("pending-worker"), integrated.lead))
            ?.integration?.preparationId,
          seed.preparationId,
        );
        yield* runtime.assertDelegationFor(integrated.lead, deliverySelection);
        yield* access.assertDirection({ threadId: api.lead, senderThreadId: integrated.lead });
        yield* access.assertDirection({ threadId: integrated.lead, senderThreadId: api.lead });
        state = {
          ...approved,
          controls: [
            {
              id: FactoryControlId.make("peer-pause"),
              kind: "project-pause",
              projectId: api.project,
              generation: 1,
              status: "active",
              stop: { status: "confirmed", stoppedAt: deliveryNow },
              requestedAt: deliveryNow,
              updatedAt: deliveryNow,
            },
          ],
        };
        assert.equal(
          (yield* runtime.runtimePolicyFor(child).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        state = {
          ...approved,
          integrationGrants: approved.integrationGrants.map((entry) =>
            entry.projectId === api.project
              ? {
                  ...entry,
                  lifecycle: {
                    phase: "revoked",
                    reason: "Withdraw access",
                    commandId: CommandId.make("revoke-peer"),
                    revokedAt: deliveryNow,
                  },
                }
              : entry,
          ),
        };
        assert.equal(
          (yield* runtime.runtimePolicyFor(integrated.lead).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        state = {
          ...approved,
          assignments: approved.assignments.map((entry) =>
            entry.id === api.assignment
              ? { ...entry, grant: { ...entry.grant!, epoch: entry.grant!.epoch + 1 } }
              : entry,
          ),
        };
        assert.equal(
          (yield* runtime.runtimePolicyFor(child).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        state = {
          ...approved,
          assignments: approved.assignments.map((entry) =>
            entry.id === api.assignment
              ? { ...entry, threadId: ThreadId.make("replacement-api-lead") }
              : entry,
          ),
        };
        assert.equal(
          (yield* runtime.runtimePolicyFor(child).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        state = approved;
        yield* fs.writeFileString(
          profile.integration!.manifestPath,
          encode({ ...identity, manifest: { ...manifest, planIds: ["unapproved-plan"] } }),
        );
        assert.equal(
          (yield* runtime.runtimePolicyFor(child).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        yield* fs.writeFileString(profile.integration!.manifestPath, encode(identity));
        yield* fs.makeDirectory(profile.integration!.stopPath, { recursive: true });
        assert.isDefined(yield* runtime.runtimePolicyFor(child));
        yield* fs.writeFileString(path.join(profile.integration!.stopPath, "late-hold.json"), "{}");
        assert.equal(
          (yield* runtime.runtimePolicyFor(child).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
      }).pipe(Effect.provide(Runtime.layer.pipe(Layer.provideMerge(dependencies))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
