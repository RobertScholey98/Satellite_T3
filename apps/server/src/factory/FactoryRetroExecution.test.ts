import * as Crypto from "effect/Crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactoryControlId,
  ThreadId,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import {
  FACTORY_CODEX_IMAGE,
  FactoryExecutionProfile,
  factoryDockerArguments,
} from "./FactoryExecutionProfile.ts";
import * as FactoryMcpGuard from "./FactoryMcpGuard.ts";
import * as FactoryThreadScope from "./FactoryThreadScope.ts";
import * as FactoryModelAdmission from "./FactoryModelAdmission.ts";
import { assertFactoryProfileActive } from "./FactoryProfileAuthority.ts";
import * as FactoryRetroEvidence from "./FactoryRetroEvidence.ts";
import * as FactoryRetroExecution from "./FactoryRetroExecution.ts";
import * as FactorySource from "./FactorySource.ts";
import * as FactoryWorkflowExecution from "./FactoryWorkflowExecution.ts";
import { FactoryStore } from "./FactoryStore.ts";
import { decide } from "./FactoryState.ts";
import { completedMergeOperationFixture } from "./FactoryMergeOperation.testkit.ts";
import { integrated } from "./FactoryIntegration.testkit.ts";
import { IntegrationRuntimeArtifact, integrationDigest } from "./FactoryIntegrationRuntime.ts";
import {
  deliveryFixture,
  deliveryIds,
  deliveryNow,
  deliverySelection,
} from "./FactoryDelivery.testkit.ts";

const retroThread = ThreadId.make("retro-thread");
const profileId = "a4556207-a1c8-4b22-861c-4f835a64b713";
const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(FactoryExecutionProfile));
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionProfile));
const encodeRuntime = Schema.encodeEffect(Schema.fromJsonString(IntegrationRuntimeArtifact));
const input = {
  assignmentId: deliveryIds.assignment,
  retroId: "retro",
  threadId: retroThread,
  conclusionId: "conclusion",
  evidenceDigest: "pending",
};

const fixture = Effect.fn(function* (live = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs.makeTempDirectoryScoped();
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(root, root)),
  );
  const dockerContext = live
    ? (yield* runner.run({
        command: "docker",
        args: ["context", "show"],
      })).stdout.trim()
    : "test";
  const imageId = live
    ? (yield* runner.run({
        command: "docker",
        args: [
          "--context",
          dockerContext,
          "image",
          "inspect",
          FACTORY_CODEX_IMAGE,
          "--format",
          "{{.Id}}",
        ],
      })).stdout.trim()
    : `sha256:${"a".repeat(64)}`;
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const directory = path.join(config.stateDir, "factory", "execution", profileId);
  const original: FactoryExecutionProfile = {
    boundaryId: profileId,
    dockerContext,
    imageId,
    projectSnapshotPath: path.join(directory, "project"),
    workflowSnapshotPath: path.join(directory, "workflow"),
    runtimePath: path.join(directory, "sessions"),
    startingSourceId: "source",
    startingSourceDigest: "source-digest",
    assignmentWorkspace: {
      assignmentId: deliveryIds.assignment,
      volumeName: "old-revoked-volume",
      grantEpoch: 1,
      boundaryId: deliveryIds.boundary,
      controlsPath: path.join(directory, "controls"),
      revocationPath: path.join(directory, "revoked.json"),
      workerUid: 1000,
      workerGid: 1000,
    },
  };
  yield* fs.makeDirectory(path.join(original.workflowSnapshotPath, "skills", "retro"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    path.join(original.workflowSnapshotPath, "skills", "retro", "SKILL.md"),
    "Approved immutable retrospective instructions.",
  );
  yield* fs.writeFileString(original.assignmentWorkspace!.revocationPath, "{}");
  yield* fs.writeFileString(path.join(directory, "profile.json"), yield* encodeProfile(original));
  const evidenceLayer = FactoryRetroEvidence.layer.pipe(
    Layer.provide(ServerConfig.layerTest(root, root)),
  );
  const sealed = yield* FactoryRetroEvidence.FactoryRetroEvidence.pipe(
    Effect.flatMap((evidence) =>
      evidence.seal({
        retroId: input.retroId,
        conclusionId: input.conclusionId,
        assignmentId: input.assignmentId,
        documents: [
          { name: "assignment.json", content: "{}" },
          { name: "team.json", content: "[]" },
          { name: "feedback.json", content: "[]" },
        ],
      }),
    ),
    Effect.provide(evidenceLayer),
  );
  const request = { ...input, evidenceDigest: sealed.evidenceDigest };
  const controlId = FactoryControlId.make("cancelled");
  let state: FactorySnapshot = deliveryFixture();
  state = {
    ...state,
    controls: [
      {
        id: controlId,
        kind: "cancellation",
        assignmentId: input.assignmentId,
        managerId: deliveryIds.manager,
        generation: 1,
        requestedAt: deliveryNow,
        updatedAt: deliveryNow,
        stop: { status: "confirmed", stoppedAt: deliveryNow },
        reason: { text: "Changed priority", recordedAt: deliveryNow },
      },
    ],
    assignments: state.assignments.map((assignment) => ({
      ...assignment,
      qualification: { status: "qualified", profileId, checkedAt: deliveryNow },
      outcome: { kind: "cancelled", controlId },
      completion: {
        phase: "concluded",
        waitReason: null,
        plan: {
          kind: "no-pr",
          condition: "Report",
          target: { kind: "report-received", recipientThreadId: deliveryIds.manager },
        },
        deliveries: [],
        waivers: [],
        acceptance: null,
        conclusion: {
          id: request.conclusionId,
          evidenceDigest: request.evidenceDigest,
          concludedAt: deliveryNow,
          kind: "cancelled",
          controlId,
          reasonRecordedAt: deliveryNow,
        },
      },
    })),
    retros: [
      {
        id: request.retroId,
        assignmentId: input.assignmentId,
        threadId: retroThread,
        conclusionId: request.conclusionId,
        evidenceDigest: request.evidenceDigest,
        modelSelection: deliverySelection,
        execution: { status: "preparing" },
        reports: { phase: "team-pending" },
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
  };
  const content = Buffer.from("preserved starting source\n");
  const crypto = yield* Crypto.Crypto;
  const contentDigest = Buffer.from(yield* crypto.digest("SHA-256", content)).toString("hex");
  const workflowBytes = Buffer.from("Approved immutable retrospective instructions.");
  const workflowFile = {
    path: "skills/retro/SKILL.md",
    content: workflowBytes.toString("base64"),
    digest: Buffer.from(yield* crypto.digest("SHA-256", workflowBytes)).toString("hex"),
    mode: "100644" as const,
  };
  const dependencies = Layer.mergeAll(
    ServerConfig.layerTest(root, root),
    evidenceLayer,
    Layer.mock(FactoryStore)({ snapshot: Effect.sync(() => state) }),
    Layer.mock(FactorySource.FactorySource)({
      readRevision: () => Effect.succeed({ files: [workflowFile], excludedPaths: [] }),
      read: () =>
        Effect.succeed({
          source: state.assignments[0]!.startingSource!,
          request: { requestId: CommandId.make("capture"), projectId: deliveryIds.project },
          workspaceRoot: "unused",
          indexData: null,
          indexFiles: [],
          files: [
            {
              path: "README.md",
              content: content.toString("base64"),
              digest: contentDigest,
              mode: "100644",
            },
          ],
        }),
    }),
    Layer.mock(FactoryBoundaryExecution.FactoryBoundaryExecution)({}),
    Layer.mock(ProjectStoreV2)({}),
    Layer.mock(ProviderInstanceRegistry)({}),
    Layer.mock(ProjectionStoreV2)({ getThreadShell: () => Effect.succeed(null) }),
    Layer.mock(ThreadManagementService)({ getThreadShell: () => Effect.succeed(null) }),
  );
  return {
    fs,
    path,
    config,
    original,
    request,
    dependencies,
    getState: () => state,
    setState: (next: FactorySnapshot) => {
      state = next;
    },
    markReady: (prepared: {
      qualification: { status: "qualified"; profileId: string; checkedAt: string };
      sourceDigest: string;
    }) => {
      state = {
        ...state,
        retros: state.retros.map((retro) => ({
          ...retro,
          execution: { status: "ready", ...prepared, launch: "pending" },
        })),
        auxiliaryThreads: [
          {
            threadId: retroThread,
            assignmentId: input.assignmentId,
            incidentId: input.retroId,
            managerId: deliveryIds.manager,
            projectId: deliveryIds.project,
            cycle: 0,
            kind: "retrospective",
            modelSelection: deliverySelection,
            status: "running",
            qualification: prepared.qualification,
            sourceDigest: prepared.sourceDigest,
            createdAt: deliveryNow,
            updatedAt: deliveryNow,
          },
        ],
      };
    },
  };
});

const live = process.env.SATELLITE_FACTORY_LIVE_TEST === "1" ? it.effect : it.effect.skip;
it.effect(
  "retrospectives retain the exact workflow identity without copying or remounting different instructions",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const workflow = yield* FactoryWorkflowExecution.FactoryWorkflowExecution.pipe(
        Effect.flatMap((service) =>
          service.snapshot({ version: f.getState().assignments[0]!.workflow }),
        ),
        Effect.provide(FactoryWorkflowExecution.layer.pipe(Layer.provide(f.dependencies))),
      );
      const original = { ...f.original, workflow, workflowSnapshotPath: workflow.snapshotPath };
      yield* f.fs.writeFileString(
        f.path.join(f.config.stateDir, "factory", "execution", profileId, "profile.json"),
        yield* encodeProfile(original),
      );
      const prepared = yield* FactoryRetroExecution.FactoryRetroExecution.pipe(
        Effect.flatMap((service) => service.prepare(f.request)),
        Effect.provide(
          FactoryRetroExecution.layer.pipe(
            Layer.provide(f.dependencies),
            Layer.provide(
              Layer.mock(ProcessRunner.ProcessRunner)({
                run: () =>
                  Effect.succeed({
                    stdout: "factory-boundary-ok",
                    stderr: "",
                    code: ChildProcessSpawner.ExitCode(0),
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    stdoutInvalidUtf8: false,
                    stderrInvalidUtf8: false,
                  }),
              }),
            ),
          ),
        ),
      );
      const profile = yield* f.fs
        .readFileString(
          f.path.join(
            f.config.stateDir,
            "factory",
            "execution",
            prepared.qualification.profileId,
            "profile.json",
          ),
        )
        .pipe(Effect.flatMap(decodeProfile));
      assert.deepEqual(profile.workflow, workflow);
      assert.equal(profile.workflowSnapshotPath, workflow.snapshotPath);
      assert.isUndefined(profile.assignmentWorkspace);
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);
live(
  "qualifies a fresh read-only retrospective after cancellation and preserves its identity across service recreation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const runtimeLayer = FactoryRetroExecution.layer.pipe(Layer.provide(f.dependencies));
      const prepared = yield* FactoryRetroExecution.FactoryRetroExecution.pipe(
        Effect.flatMap((runtime) => runtime.prepare(f.request)),
        Effect.provide(runtimeLayer),
      );
      f.markReady(prepared);
      const profile = yield* f.fs
        .readFileString(
          f.path.join(
            f.config.stateDir,
            "factory",
            "execution",
            prepared.qualification.profileId,
            "profile.json",
          ),
        )
        .pipe(Effect.flatMap(decodeProfile));
      assert.equal(profile.retro?.sourceBasis, "starting-snapshot");
      assert.isUndefined(profile.assignmentWorkspace);
      assert.notEqual(profile.runtimePath, f.original.runtimePath);
      assert.notEqual(profile.workflowSnapshotPath, f.original.workflowSnapshotPath);
      assert.equal(
        yield* f.fs.readFileString(f.path.join(profile.projectSnapshotPath, "README.md")),
        "preserved starting source\n",
      );
      assert.isFalse(
        factoryDockerArguments(profile).some((arg) => arg.includes("old-revoked-volume")),
      );
      assert.equal(
        (yield* assertFactoryProfileActive(f.original).pipe(Effect.flip)).code,
        "execution-unavailable",
      );
      const again = yield* FactoryRetroExecution.FactoryRetroExecution.pipe(
        Effect.flatMap((runtime) => runtime.prepare(f.request)),
        Effect.provide(runtimeLayer),
      );
      assert.equal(again.qualification.profileId, prepared.qualification.profileId);
      yield* Effect.gen(function* () {
        const execution = yield* FactoryExecution.FactoryExecution;
        assert.equal((yield* execution.runtimePolicyFor(retroThread))?.retro?.retroId, "retro");
        assert.equal(
          (yield* execution.runtimePolicyFor(deliveryIds.lead).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        const models = yield* FactoryModelAdmission.FactoryModelAdmission;
        yield* models.assertSelectionFor(retroThread, deliverySelection);
        assert.equal(
          (yield* models.assertDelegationFor(retroThread, deliverySelection).pipe(Effect.flip))
            .code,
          "permission-denied",
        );
        const access = yield* FactoryControlAccess.FactoryControlAccess;
        const member = yield* access.membership(retroThread);
        assert.isDefined(member);
        f.setState(
          Result.getOrThrow(
            decide({
              state: f.getState(),
              actor: { kind: "human" },
              now: deliveryNow,
              command: {
                type: "thread.takeover",
                commandId: CommandId.make("takeover"),
                threadId: retroThread,
              },
              controlTarget: member!,
            }),
          ).state,
        );
        yield* access.assertExecution(retroThread);
        yield* access.assertDirection({ threadId: retroThread });
        assert.equal(
          (yield* access
            .assertDirection({ threadId: retroThread, senderThreadId: deliveryIds.manager })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        f.setState({
          ...f.getState(),
          controls: [
            {
              id: FactoryControlId.make("pause"),
              kind: "project-pause",
              status: "active",
              projectId: deliveryIds.project,
              stop: { status: "confirmed", stoppedAt: deliveryNow },
              generation: 1,
              requestedAt: deliveryNow,
              updatedAt: deliveryNow,
            },
          ],
        });
        assert.equal(
          (yield* access.assertExecution(retroThread).pipe(Effect.flip)).code,
          "permission-denied",
        );
        f.setState({ ...f.getState(), controls: [] });
        f.setState({
          ...f.getState(),
          controls: [
            {
              id: FactoryControlId.make("manager-pause"),
              kind: "manager-pause",
              managerId: deliveryIds.manager,
              priorStatus: "active",
              generation: 1,
              status: "active",
              requestedAt: deliveryNow,
              updatedAt: deliveryNow,
              stop: { status: "confirmed", stoppedAt: deliveryNow },
            },
          ],
        });
        yield* access.assertExecution(retroThread);
        assert.equal(
          (yield* access
            .assertDirection({ threadId: retroThread, senderThreadId: deliveryIds.manager })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        f.setState({
          ...f.getState(),
          controls: [],
          retros: f.getState().retros.map((retro) => ({ ...retro, evidenceDigest: "superseded" })),
        });
        assert.equal(
          (yield* execution.runtimePolicyFor(retroThread).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            FactoryExecution.layer,
            FactoryControlAccess.layer,
            FactoryModelAdmission.layer,
          ).pipe(Layer.provide(f.dependencies)),
        ),
      );
      yield* FactoryRetroExecution.FactoryRetroExecution.pipe(
        Effect.flatMap((runtime) => runtime.stop({ retroId: input.retroId })),
        Effect.provide(runtimeLayer),
      );
      assert.equal(
        (yield* assertFactoryProfileActive(profile).pipe(Effect.flip)).code,
        "execution-unavailable",
      );
      assert.equal(
        (yield* FactoryRetroExecution.FactoryRetroExecution.pipe(
          Effect.flatMap((runtime) => runtime.prepare(f.request)),
          Effect.provide(runtimeLayer),
          Effect.flip,
        ))._tag,
        "FactoryError",
      );
    }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  60_000,
);

it.effect(
  "admits only scoped retrospective reads and reports through MCP",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.markReady({
        qualification: { status: "qualified", profileId, checkedAt: deliveryNow },
        sourceDigest: "source-digest",
      });
      const invocation = {
        environmentId: EnvironmentId.make("test"),
        issuedAt: 1,
        requestNamespace: "retro-test",
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        thread: {
          threadId: retroThread,
          providerSessionId: "retro-session",
          providerInstanceId: deliverySelection.instanceId,
        },
      };
      const accepted: string[] = [];
      yield* Effect.gen(function* () {
        const policy = yield* McpToolAccess.CallerPolicy;
        const authorize = (tool: string, payload?: unknown) =>
          Effect.flatMap(policy.grant(invocation), (grant) => grant.authorize(tool, payload));
        const scope = yield* FactoryThreadScope.make({
          snapshot: () => Effect.die("unused"),
          mergeGroupGet: () => Effect.die("unused"),
          dispatch: (_actor, command) =>
            Effect.sync(() => {
              accepted.push(command.type);
              return { revision: f.getState().revision };
            }),
        });
        yield* authorize("factory_snapshot");
        yield* authorize("t3_thread_read", { threadId: deliveryIds.lead });
        for (const [tool, payload] of [
          ["t3_thread_read", { threadId: deliveryIds.manager }],
          ["t3_thread_send", { threadId: deliveryIds.lead }],
          ["delegate_task", {}],
          ["factory_preview_action", {}],
          ["http_request", {}],
          ["issue_create", {}],
        ] as const)
          assert.equal(
            (yield* authorize(tool, payload).pipe(Effect.flip)).code,
            "capability_denied",
          );
        for (const command of [
          {
            type: "assignment.verify",
            commandId: CommandId.make("verify"),
            assignmentId: input.assignmentId,
            expectedEpoch: 1,
          },
          {
            type: "delivery.merge",
            commandId: CommandId.make("merge"),
            assignmentId: input.assignmentId,
            revisionId: "revision",
          },
        ] as const)
          assert.equal(
            (yield* scope.threadDispatch(retroThread, command).pipe(Effect.flip)).code,
            "permission-denied",
          );
        yield* scope.threadDispatch(retroThread, {
          type: "retro.team.submit",
          commandId: CommandId.make("report"),
          retroId: input.retroId,
          conclusionId: input.conclusionId,
          report: {
            outcome: "Cancelled as requested",
            helped: "Clear scope",
            hindered: "None",
            learning: { kind: "no-process-change", reason: "No process defect found" },
            contributions: [],
          },
        });
        assert.deepStrictEqual(accepted, ["retro.team.submit"]);
        f.setState({
          ...f.getState(),
          retros: f
            .getState()
            .retros.map((retro) => ({ ...retro, execution: { status: "stopped" } })),
        });
        assert.equal(
          (yield* authorize("factory_snapshot").pipe(Effect.flip)).code,
          "capability_denied",
        );
      }).pipe(
        Effect.provide(
          Layer.merge(FactoryMcpGuard.layer, FactoryControlAccess.layer).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                f.dependencies,
                Layer.mock(FactoryExecution.FactoryExecution)({
                  runtimePolicyFor: () => Effect.succeed(f.original),
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  60_000,
);

const integrationRetroFixture = Effect.fn(function* () {
  const f = yield* fixture();
  const seed = completedMergeOperationFixture();
  const crypto = yield* Crypto.Crypto;
  const originalCompletion = f.getState().assignments[0]!.completion!;
  const requestBase = {
    ...f.request,
    assignmentId: integrated.assignment,
    retroId: "integration-retro",
    conclusionId: "integration-conclusion",
  };
  const sealed = yield* FactoryRetroEvidence.FactoryRetroEvidence.pipe(
    Effect.flatMap((evidence) =>
      evidence.seal({
        ...requestBase,
        documents: [
          { name: "assignment.json", content: "{}" },
          { name: "team.json", content: "[]" },
          { name: "feedback.json", content: "[]" },
        ],
      }),
    ),
    Effect.provide(f.dependencies),
  );
  const request = { ...requestBase, evidenceDigest: sealed.evidenceDigest };
  const { inputDigest: _digest, ...manifestFields } = seed.manifest;
  const manifest = { ...manifestFields, inputDigest: yield* integrationDigest(manifestFields) };
  const profile: FactoryExecutionProfile = {
    ...f.original,
    profileId,
    assignmentWorkspace: {
      ...f.original.assignmentWorkspace!,
      assignmentId: integrated.assignment,
    },
    integration: {
      integrationId: seed.integrationId,
      preparationId: seed.preparationId,
      inputDigest: manifest.inputDigest,
      grantIds: manifest.inputs.map((entry) => entry.integrationGrantId),
      manifestPath: f.path.join(f.config.stateDir, "immutable-manifest.json"),
      stopPath: f.path.join(f.config.stateDir, "stopped-integration.json"),
    },
  };
  const projects: IntegrationRuntimeArtifact["projects"][number][] = [];
  for (const [index, entry] of manifest.inputs.entries()) {
    const grant = seed.state.integrationGrants.find(
      (item) => item.id === entry.integrationGrantId,
    )!;
    const capability = seed.state.integrationCapabilities.find(
      (item) => item.id === entry.capabilityId,
    )!;
    const bytes = Buffer.from(`preserved participant ${entry.projectId}\n`);
    const files = [
      {
        path: "src/feature.ts",
        content: bytes.toString("base64"),
        digest: Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex"),
        mode: "100644" as const,
      },
    ];
    projects.push({
      alias: `project-${String(index).padStart(16, "0")}`,
      grant,
      files,
      capability: {
        capability,
        boundary: seed.state.boundaries.find((item) => item.id === capability.boundaryId)!,
        profile,
        files: [],
        configurationDigest: "configuration",
        coordinatorDigest: null,
      },
    });
  }
  const runtime: IntegrationRuntimeArtifact = {
    integrationId: seed.integrationId,
    preparationId: seed.preparationId,
    profile,
    manifest,
    projects,
    initialTestArtifact: seed.artifact,
  };
  const runtimePath = f.path.join(
    f.config.stateDir,
    "factory",
    "integration",
    "preparations",
    yield* integrationDigest(seed.preparationId),
    "runtime.json",
  );
  yield* f.fs.makeDirectory(f.path.dirname(runtimePath), { recursive: true });
  yield* f.fs.writeFileString(runtimePath, yield* encodeRuntime(runtime));
  yield* f.fs.writeFileString(
    f.path.join(f.config.stateDir, "factory", "execution", profileId, "profile.json"),
    yield* encodeProfile(profile),
  );
  const operation = seed.state.mergeOperations.find((entry) => entry.id === seed.operationId)!;
  if (operation.lifecycle.phase !== "completed")
    return yield* Effect.die("Expected completed merge fixture");
  const receiptDigest = operation.lifecycle.receiptDigest;
  f.setState({
    ...seed.state,
    integrations: seed.state.integrations.map((entry) => ({
      ...entry,
      currentPreparationId: "later-unrelated-preparation",
    })),
    mergeOperations: seed.state.mergeOperations.map((entry) =>
      entry.lifecycle.phase === "completed"
        ? {
            ...entry,
            lifecycle: {
              ...entry.lifecycle,
              frozen: { ...entry.lifecycle.frozen, inputDigest: manifest.inputDigest },
            },
          }
        : entry,
    ),
    assignments: seed.state.assignments.map((assignment) =>
      assignment.id !== integrated.assignment
        ? assignment
        : {
            ...assignment,
            qualification: { status: "qualified", profileId, checkedAt: deliveryNow },
            completion: {
              ...originalCompletion,
              conclusion: {
                kind: "shared-group-delivered",
                id: request.conclusionId,
                evidenceDigest: request.evidenceDigest,
                concludedAt: deliveryNow,
                operationId: seed.operationId,
                groupId: seed.groupId,
                receiptDigest,
              },
            },
          },
    ),
    retros: [
      {
        ...f.getState().retros[0]!,
        id: request.retroId,
        assignmentId: integrated.assignment,
        conclusionId: request.conclusionId,
        evidenceDigest: request.evidenceDigest,
      },
    ],
  });
  assert.isUndefined(
    f.getState().assignments.find((entry) => entry.id === integrated.assignment)!.startingSource,
  );
  const invocations: ProcessRunner.ProcessRunInput[] = [];
  const executionLayer = FactoryRetroExecution.layer.pipe(
    Layer.provide(f.dependencies),
    Layer.provide(
      Layer.mock(ProcessRunner.ProcessRunner)({
        run: (invocation) =>
          Effect.sync(() => {
            invocations.push(invocation);
            assert.equal(invocation.command, "docker");
            assert.isTrue(invocation.args.includes("--entrypoint"));
            assert.isFalse(invocation.args.some((arg) => arg.includes("old-revoked-volume")));
            return {
              stdout: "factory-boundary-ok",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
    ),
  );
  const prepare = FactoryRetroExecution.FactoryRetroExecution.pipe(
    Effect.flatMap((execution) => execution.prepare(request)),
    Effect.provide(executionLayer),
  );
  return { ...f, request, runtime, runtimePath, invocations, prepare };
});

it.effect(
  "qualifies completed integration retros from frozen participant files without reviving implementation volumes",
  () =>
    Effect.gen(function* () {
      const f = yield* integrationRetroFixture();
      const prepared = yield* f.prepare;
      const profile = yield* f.fs
        .readFileString(
          f.path.join(
            f.config.stateDir,
            "factory",
            "execution",
            prepared.qualification.profileId,
            "profile.json",
          ),
        )
        .pipe(Effect.flatMap(decodeProfile));
      assert.equal(profile.retro?.sourceBasis, "integration-inputs");
      assert.isUndefined(profile.startingSourceId);
      assert.isUndefined(profile.assignmentWorkspace);
      assert.isUndefined(profile.integration);
      for (const project of f.runtime.projects) {
        assert.equal(
          yield* f.fs.readFileString(
            f.path.join(
              profile.projectSnapshotPath,
              "participants",
              project.alias,
              "src",
              "feature.ts",
            ),
          ),
          `preserved participant ${project.grant.projectId}\n`,
        );
      }
      const mounts = factoryDockerArguments(profile);
      assert.include(
        mounts,
        `type=bind,source=${profile.projectSnapshotPath},target=/workspace,readonly`,
      );
      assert.isFalse(
        mounts.some((arg) => arg.includes("type=volume") || arg.includes("old-revoked-volume")),
      );
      assert.equal(
        (yield* assertFactoryProfileActive(f.original).pipe(Effect.flip)).code,
        "execution-unavailable",
      );
      const repeated = yield* f.prepare;
      assert.equal(repeated.qualification.profileId, prepared.qualification.profileId);
      assert.equal(repeated.sourceDigest, prepared.sourceDigest);
      assert.lengthOf(f.invocations, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);

it.effect(
  "rejects tampered preserved integration files before probing retrospective execution",
  () =>
    Effect.gen(function* () {
      const f = yield* integrationRetroFixture();
      const tampered = {
        ...f.runtime,
        projects: f.runtime.projects.map((project) => ({
          ...project,
          files: project.files.map((file) => ({
            ...file,
            content: Buffer.from("tampered").toString("base64"),
          })),
        })),
      };
      yield* f.fs.writeFileString(f.runtimePath, yield* encodeRuntime(tampered));
      assert.propertyVal(yield* f.prepare.pipe(Effect.flip), "code", "execution-unavailable");
      assert.lengthOf(f.invocations, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);

it.effect("refuses a delivered integration retro whose completed operation is missing", () =>
  Effect.gen(function* () {
    const f = yield* integrationRetroFixture();
    const state = f.getState();
    f.setState({
      ...state,
      mergeOperations: [],
      integrations: state.integrations.map((entry) => ({
        ...entry,
        currentPreparationId: f.runtime.preparationId,
      })),
    });
    assert.propertyVal(yield* f.prepare.pipe(Effect.flip), "code", "execution-unavailable");
    assert.lengthOf(f.invocations, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

const probeRunner = Layer.mock(ProcessRunner.ProcessRunner)({
  run: () =>
    Effect.succeed({
      stdout: "factory-boundary-ok",
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
});

it.effect("inspects a cancelled restart with the profile the team last ran in", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const state = f.getState();
    const assignment = state.assignments[0]!;
    f.setState({
      ...state,
      assignments: [
        {
          ...assignment,
          qualification: { status: "unavailable", reason: "Preparing the selected profile." },
        },
      ],
      workflowMigrations: [
        {
          id: "restart",
          assignmentId: assignment.id,
          releaseId: null,
          previousVersion: assignment.workflow,
          previousEpoch: 1,
          previousProfileId: profileId,
          preparedEpoch: 2,
          retainedAuthorityReason: null,
          previousState: { status: "running", wait: null },
          kind: "restore",
          reason: "Restart the team",
          commandId: CommandId.make("restart"),
          createdAt: deliveryNow,
          lifecycle: {
            phase: "failed",
            step: "prepare",
            reason: "Docker unavailable",
            startingSource: null,
          },
        },
      ],
    });
    const prepared = yield* FactoryRetroExecution.FactoryRetroExecution.pipe(
      Effect.flatMap((service) => service.prepare(f.request)),
      Effect.provide(
        FactoryRetroExecution.layer.pipe(Layer.provide(f.dependencies), Layer.provide(probeRunner)),
      ),
    );
    const profile = yield* f.fs
      .readFileString(
        f.path.join(
          f.config.stateDir,
          "factory",
          "execution",
          prepared.qualification.profileId,
          "profile.json",
        ),
      )
      .pipe(Effect.flatMap(decodeProfile));
    assert.equal(profile.imageId, f.original.imageId);
    assert.equal(profile.retro?.sourceBasis, "starting-snapshot");
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

it.effect("inspects a cancelled integration whose re-preparation withdrew its qualification", () =>
  Effect.gen(function* () {
    const f = yield* integrationRetroFixture();
    const state = f.getState();
    f.setState({
      ...state,
      assignments: state.assignments.map((entry) => ({
        ...entry,
        qualification: { status: "unavailable" as const, reason: "Preparing the inputs." },
      })),
    });
    const prepared = yield* f.prepare;
    assert.match(prepared.qualification.profileId, /^[a-f0-9-]{36}$/);
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);
