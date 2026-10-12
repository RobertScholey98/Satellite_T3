import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  FactoryAssignmentId,
  FactoryControlId,
  FactorySourceId,
  type FactorySnapshot,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import { FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";
import * as FactoryStore from "./FactoryStore.ts";
import * as FactorySource from "./FactorySource.ts";

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
  "isolates persisted and pending descendants while rejecting lineage and source mismatches",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const now = yield* DateTime.now;
      const workflowContent = Buffer.from("Approved workflow baseline");
      const workflowFile = {
        path: "skills/implementation/SKILL.md",
        content: workflowContent.toString("base64"),
        digest: Buffer.from(
          yield* (yield* Crypto.Crypto).digest("SHA-256", workflowContent),
        ).toString("hex"),
        mode: "100644" as const,
      };
      const initial = initialFactorySnapshot();
      let snapshot: FactorySnapshot = {
        ...initial,
        managers: [
          {
            id: ThreadId.make("manager"),
            threadId: ThreadId.make("manager"),
            role: "project",
            projectId,
            name: "Manager",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
            workflow: { repositoryRoot: "/owned", revision: "pinned" },
            overrides: {},
            status: "active",
            threadStatus: "created",
            launchStatus: "delivered",
            wait: null,
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
          },
        ],
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
        Layer.mock(FactoryStore.FactoryStore)({ snapshot: Effect.sync(() => snapshot) }),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(undefined),
        }),
        Layer.mock(ProcessRunner.ProcessRunner)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: (id) => {
            const persisted = fixtures.get(id);
            return Effect.succeed(
              persisted === undefined ? null : { ...liveThreadShell(id), ...persisted },
            );
          },
          getThread: (id) =>
            fixtures.has(id)
              ? Effect.succeed(fixtures.get(id)!)
              : Effect.fail(
                  new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }),
                ),
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
        yield* fs.makeDirectory(
          path.join(profile.workflowSnapshotPath, "skills", "implementation"),
          { recursive: true },
        );
        yield* fs.writeFile(
          path.join(profile.workflowSnapshotPath, workflowFile.path),
          workflowContent,
        );
        yield* fs.writeFileString(
          path.join(directory, "profile.json"),
          yield* encodeProfile(profile),
        );
        const projectSnapshot = snapshot;
        const systemId = ThreadId.make("system-manager");
        snapshot = {
          ...snapshot,
          assignments: [],
          managers: [
            {
              ...snapshot.managers[0]!,
              id: systemId,
              threadId: systemId,
              role: "system",
              projectId: null,
              workspaceProjectId: projectId,
              qualification: { status: "qualified", profileId, checkedAt: DateTime.formatIso(now) },
            },
          ],
          controls: [
            {
              id: FactoryControlId.make("workspace-pause"),
              generation: 1,
              kind: "project-pause",
              projectId,
              status: "active",
              stop: { status: "confirmed", stoppedAt: DateTime.formatIso(now) },
              requestedAt: DateTime.formatIso(now),
              updatedAt: DateTime.formatIso(now),
            },
          ],
        };
        const systemPolicy = yield* execution.runtimePolicyFor(systemId);
        assert.equal(systemPolicy?.projectSnapshotPath, profile.projectSnapshotPath);
        assert.isDefined(systemPolicy?.workflow);
        assert.isUndefined(systemPolicy?.assignmentWorkspace);
        yield* execution.assertSelectionFor(systemId, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "test",
        });
        assert.equal(
          (yield* execution
            .assertDelegationFor(systemId, {
              instanceId: ProviderInstanceId.make("codex"),
              model: "test",
            })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.equal(
          (yield* execution
            .runtimePolicyFor(ThreadId.make("system-child"), systemId)
            .pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        snapshot = {
          ...snapshot,
          controls: [
            ...snapshot.controls,
            {
              id: FactoryControlId.make("system-pause"),
              kind: "manager-pause",
              managerId: systemId,
              priorStatus: "active",
              status: "active",
              generation: 1,
              stop: { status: "pending" },
              requestedAt: DateTime.formatIso(now),
              updatedAt: DateTime.formatIso(now),
            },
          ],
        };
        // The pause refusal keeps its code and reason rather than reading as unavailable.
        const paused = yield* execution.runtimePolicyFor(systemId).pipe(Effect.flip);
        assert.equal(paused.code, "permission-denied");
        assert.isDefined(paused.detail);
        snapshot = {
          ...snapshot,
          controls: [],
          modelDefaults: { approvedModels: [], preferences: [] },
        };
        assert.equal(
          (yield* execution.runtimePolicyFor(systemId).pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.equal(
          (yield* execution
            .assertSelectionFor(systemId, {
              instanceId: ProviderInstanceId.make("codex"),
              model: "test",
            })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        snapshot = {
          ...snapshot,
          modelDefaults: {
            approvedModels: [{ instanceId: ProviderInstanceId.make("codex"), model: "test" }],
            preferences: [],
          },
        };
        yield* fs.writeFileString(
          path.join(directory, "profile.json"),
          yield* encodeProfile({
            ...profile,
            projectSnapshotPath: path.join(directory, "another-project"),
          }),
        );
        assert.equal(
          (yield* execution.runtimePolicyFor(systemId).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        yield* fs.writeFileString(
          path.join(directory, "profile.json"),
          yield* encodeProfile(profile),
        );
        snapshot = projectSnapshot;
        const parentPolicy = yield* execution.runtimePolicyFor(owner);
        const childPolicy = yield* execution.runtimePolicyFor(child);
        assert.isDefined(parentPolicy);
        assert.isDefined(childPolicy);
        assert.equal(childPolicy?.projectSnapshotPath, parentPolicy?.projectSnapshotPath);
        assert.notEqual(childPolicy?.boundaryId, parentPolicy?.boundaryId);
        assert.notEqual(childPolicy?.runtimePath, parentPolicy?.runtimePath);
        const pendingChild = ThreadId.make("pending-child");
        const pendingPolicy = yield* execution.runtimePolicyFor(pendingChild, owner);
        assert.isDefined(pendingPolicy);
        assert.equal(pendingPolicy?.projectSnapshotPath, parentPolicy?.projectSnapshotPath);
        assert.notEqual(pendingPolicy?.runtimePath, parentPolicy?.runtimePath);
        assert.equal(pendingPolicy?.boundaryId, `${profileId}:${pendingChild}`);
        assert.isUndefined(yield* execution.runtimePolicyFor(ordinary));
        assert.isUndefined(yield* execution.runtimePolicyFor(ordinary, owner));
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
        const startingSource = {
          id: FactorySourceId.make("captured-source"),
          projectId,
          revision: "project-commit",
          sourceDigest: "captured-digest",
          branch: "feature/work",
          origin: "handover" as const,
          threadId: owner,
          capturedAt: DateTime.formatIso(now),
          fileCount: 1,
          stagedPaths: [],
          unstagedPaths: ["src/app.ts"],
          untrackedPaths: [],
          deletedPaths: [],
          excludedPaths: [],
        };
        snapshot = {
          ...snapshot,
          assignments: [{ ...snapshot.assignments[0]!, kind: "implementation", startingSource }],
        };
        assert.equal(
          (yield* execution.runtimePolicyFor(owner).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        const prepared = {
          ...profile,
          startingSourceId: startingSource.id,
          startingSourceDigest: startingSource.sourceDigest,
        };
        yield* fs.writeFileString(
          path.join(directory, "profile.json"),
          yield* encodeProfile(prepared),
        );
        assert.isDefined(yield* execution.runtimePolicyFor(owner));
        yield* fs.writeFileString(
          path.join(directory, "profile.json"),
          yield* encodeProfile({ ...prepared, startingSourceDigest: "other-source" }),
        );
        assert.equal(
          (yield* execution.runtimePolicyFor(owner).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        yield* fs.writeFileString(
          path.join(directory, "profile.json"),
          yield* encodeProfile(prepared),
        );
        const diagnosisId = ThreadId.make("diagnosis");
        const inspectionId = "b3b85fdc-cdd0-416f-8cf2-8a4dfb204054";
        const inspectionDirectory = path.join(
          config.stateDir,
          "factory",
          "execution",
          inspectionId,
        );
        const inspection = {
          ...prepared,
          boundaryId: inspectionId,
          projectSnapshotPath: path.join(inspectionDirectory, "project"),
          runtimePath: path.join(inspectionDirectory, "sessions"),
          inspection: {
            sourceDigest: "current-edited-bytes",
            evidencePath: path.join(inspectionDirectory, "evidence"),
          },
        };
        yield* fs.makeDirectory(inspectionDirectory, { recursive: true });
        yield* fs.writeFileString(
          path.join(inspectionDirectory, "profile.json"),
          yield* encodeProfile(inspection),
        );
        snapshot = {
          ...snapshot,
          assignments: snapshot.assignments.map((entry) => ({
            ...entry,
            oversight: {
              recovery: {
                cyclesUsed: 1,
                history: [],
                incident: {
                  id: "incident",
                  phase: "diagnosing",
                  diagnosisThreadId: diagnosisId,
                  reason: "Investigate the stopped team",
                  evidence: [],
                },
              },
            },
          })),
          auxiliaryThreads: [
            {
              threadId: diagnosisId,
              assignmentId: snapshot.assignments[0]!.id,
              managerId: ThreadId.make("manager"),
              projectId,
              kind: "diagnosis",
              incidentId: "incident",
              cycle: 1,
              status: "running",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
              qualification: {
                status: "qualified",
                profileId: inspectionId,
                checkedAt: DateTime.formatIso(now),
              },
              sourceDigest: "current-edited-bytes",
              createdAt: DateTime.formatIso(now),
              updatedAt: DateTime.formatIso(now),
            },
          ],
        };
        const diagnosisPolicy = yield* execution.runtimePolicyFor(diagnosisId);
        assert.equal(diagnosisPolicy?.projectSnapshotPath, inspection.projectSnapshotPath);
        assert.notEqual(diagnosisPolicy?.runtimePath, parentPolicy?.runtimePath);
        assert.equal(diagnosisPolicy?.inspection?.sourceDigest, "current-edited-bytes");
        const diagnosing = snapshot;
        const incident = diagnosing.assignments[0]!.oversight!.recovery.incident!;
        for (const status of ["pending", "running"] as const) {
          for (const stale of [
            { ...incident, phase: "continuing" as const },
            { ...incident, id: "different-incident" },
            { ...incident, diagnosisThreadId: ThreadId.make("different-diagnosis") },
          ]) {
            snapshot = {
              ...diagnosing,
              assignments: diagnosing.assignments.map((entry) => ({
                ...entry,
                oversight: { recovery: { cyclesUsed: 1, history: [], incident: stale } },
              })),
              auxiliaryThreads: diagnosing.auxiliaryThreads.map((entry) => ({ ...entry, status })),
            };
            assert.equal(
              (yield* execution.runtimePolicyFor(diagnosisId).pipe(Effect.flip)).code,
              "permission-denied",
            );
          }
        }
        snapshot = diagnosing;
        yield* fs.writeFileString(
          path.join(inspectionDirectory, "profile.json"),
          yield* encodeProfile(prepared),
        );
        assert.equal(
          (yield* execution.runtimePolicyFor(diagnosisId).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        yield* fs.writeFileString(
          path.join(inspectionDirectory, "profile.json"),
          yield* encodeProfile({
            ...inspection,
            inspection: { ...inspection.inspection, sourceDigest: "foreign-bytes" },
          }),
        );
        assert.equal(
          (yield* execution.runtimePolicyFor(diagnosisId).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        const replacement = ThreadId.make("replacement");
        fixtures.set(child, thread(child, owner, now));
        snapshot = {
          ...snapshot,
          assignments: [
            { ...snapshot.assignments[0]!, threadId: replacement, previousLeadThreadIds: [owner] },
          ],
        };
        assert.equal(
          (yield* execution.runtimePolicyFor(owner).pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.equal(
          (yield* execution.runtimePolicyFor(child).pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.isUndefined(yield* execution.runtimePolicyFor(ordinary));
      }).pipe(
        Effect.provide(
          FactoryExecution.layer.pipe(
            Layer.provide(
              Layer.mock(FactorySource.FactorySource)({
                readRevision: () => Effect.succeed({ files: [workflowFile], excludedPaths: [] }),
              }),
            ),
            Layer.provideMerge(dependencies),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
