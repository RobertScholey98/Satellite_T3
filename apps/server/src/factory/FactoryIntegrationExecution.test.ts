import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, FactoryControlId, type FactorySnapshot } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import { type FactoryCandidateArtifact } from "./FactoryCandidate.ts";
import {
  FACTORY_CODEX_IMAGE,
  FactoryExecutionProfile,
  factoryDockerArguments,
} from "./FactoryExecutionProfile.ts";
import * as Execution from "./FactoryIntegrationExecution.ts";
import {
  integrationDigest,
  integrationId as profileIdentity,
} from "./FactoryIntegrationRuntime.ts";
import { granted, apply, actor, host, integrated, api } from "./FactoryIntegration.testkit.ts";
import { deliveryIds, deliveryNow } from "./FactoryDelivery.testkit.ts";
import * as FactorySource from "./FactorySource.ts";
import * as FactoryStore from "./FactoryStore.ts";
import * as Workflow from "./FactoryWorkflowExecution.ts";
import { assertFactoryProfileActive } from "./FactoryProfileAuthority.ts";
import { startedMergeOperationFixture } from "./FactoryMergeOperation.testkit.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const helperInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("initialize"),
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        content: Schema.String,
        digest: Schema.String,
        mode: Schema.Literals(["100644", "100755"]),
      }),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("capture") }),
  Schema.Struct({
    kind: Schema.Literal("mutate"),
    operation: Schema.Struct({
      kind: Schema.String,
      path: Schema.String,
      content: Schema.optionalKey(Schema.String),
      to: Schema.optionalKey(Schema.String),
    }),
  }),
]);
const coordinator = `const fs=require('node:fs');const {spawn}=require('node:child_process');const m=JSON.parse(fs.readFileSync(process.env.SATELLITE_INTEGRATION_MANIFEST,'utf8'));const api=m.projects.find(p=>p.projectId==='api');const web=m.projects.find(p=>p.projectId!=='api');const server=spawn(process.execPath,[api.root+'/src/service.js'],{cwd:api.root,stdio:['ignore','inherit','inherit','ipc']});server.on('message',port=>{console.log('combined-flow-start');const client=spawn(process.execPath,[web.root+'/test/check.js',String(port)],{cwd:web.root,stdio:'inherit'});client.on('exit',code=>{server.kill();process.exit(code??1)})});server.on('error',()=>process.exit(1));`;
const server = `const http=require('node:http');const fs=require('node:fs');const server=http.createServer((_req,res)=>setTimeout(()=>res.end(fs.readFileSync('fixtures/input.json','utf8')),JSON.parse(fs.readFileSync('fixtures/input.json','utf8')).delay??0));server.listen(0,'127.0.0.1',()=>process.send(server.address().port));`;
const client = `const http=require('node:http');http.get('http://127.0.0.1:'+process.argv[2],res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>{const ok=JSON.parse(body).message==='ok';console.log(ok?'combined-flow-ok':'combined-flow-failed');process.exit(ok?0:1)})}).on('error',()=>process.exit(1));`;

const scenario = (live: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const realRunner = yield* ProcessRunner.ProcessRunner;
    const root = yield* fs.makeTempDirectoryScoped();
    const seed = granted();
    let state: FactorySnapshot = seed.state;
    const integrationId = seed.integrationId;
    let command = 0;
    const commandId = () => CommandId.make(`runtime-${++command}`);
    const file = Effect.fn(function* (
      name: string,
      value: string,
    ): Effect.fn.Return<FactorySource.FactorySourceFile> {
      return {
        path: name,
        content: Buffer.from(value).toString("base64"),
        digest: Buffer.from(
          yield* crypto.digest("SHA-256", Buffer.from(value)).pipe(Effect.orDie),
        ).toString("hex"),
        mode: "100644",
      };
    });
    const files: FactorySource.FactorySourceFile[] = [
      yield* file("runner.js", coordinator),
      yield* file("gate.js", "require('node:fs').accessSync('/workspace/fixtures/input.json');"),
      yield* file("test/check.js", client),
      yield* file("fixtures/input.json", '{"message":"ok"}'),
      yield* file("src/service.js", server),
      yield* file("src/feature.ts", "export const feature = true;"),
    ];
    const workflowFile = yield* file(
      "skills/implementation/SKILL.md",
      "Use the approved project boundaries.",
    );
    let dockerContext = "fixture";
    let imageId = "sha256:fixture";
    if (live) {
      dockerContext = (yield* realRunner.run({
        command: "docker",
        args: ["context", "show"],
      })).stdout.trim();
      imageId = (yield* realRunner.run({
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
      })).stdout.trim();
      assert.match(imageId, /^sha256:/);
    }
    const candidates = new Map<string, FactoryCandidateArtifact>();
    const volumes = new Map<string, readonly FactorySource.FactorySourceFile[]>();
    const invocations: ProcessRunner.ProcessRunInput[] = [];
    const ownedVolumes = new Set<string>();
    let runningCheck: Deferred.Deferred<void> | undefined;
    const run = Effect.fn(function* (input: ProcessRunner.ProcessRunInput) {
      invocations.push(input);
      const createAt = input.args.indexOf("volume");
      if (createAt >= 0 && input.args[createAt + 1] === "create")
        ownedVolumes.add(input.args.at(-1)!);
      if (live)
        return yield* realRunner.run({
          ...input,
          onStdoutChunk: (bytes) => {
            input.onStdoutChunk?.(bytes);
            if (runningCheck && Buffer.from(bytes).toString().includes("combined-flow-start"))
              Deferred.doneUnsafe(runningCheck, Effect.void);
          },
        });
      let stdout = "";
      // An owned container that exits on its own while it is being stopped.
      if (input.args.includes("ps")) stdout = "0123456789ab";
      if (input.args.includes("rm") && input.args.includes("0123456789ab"))
        return {
          stdout: "",
          stderr:
            "Error response from daemon: removal of container 0123456789ab is already in progress",
          code: ChildProcessSpawner.ExitCode(1),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      const mount = input.args.find((arg) => arg.startsWith("type=volume,source="));
      const volume = mount?.split(",")[1]!.slice("source=".length);
      if (input.stdin && volume) {
        const operation = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(helperInput))(
          input.stdin,
        ).pipe(Effect.orDie);
        if (operation.kind === "initialize") volumes.set(volume, operation.files);
        if (operation.kind === "capture")
          stdout = json({ files: volumes.get(volume) ?? [], digest: "fixture" });
        if (operation.kind === "mutate") {
          const before = new Map((volumes.get(volume) ?? []).map((entry) => [entry.path, entry]));
          const edit = operation.operation;
          if (edit.kind === "delete") before.delete(edit.path);
          else if (edit.kind === "rename") {
            const previous = before.get(edit.path)!;
            before.delete(edit.path);
            before.set(edit.to!, { ...previous, path: edit.to! });
          } else
            before.set(
              edit.path,
              yield* file(edit.path, Buffer.from(edit.content!, "base64").toString()),
            );
          volumes.set(volume, [...before.values()]);
        }
      }
      if (input.args.some((arg) => arg.includes("integration-boundary-ok")))
        stdout = "integration-boundary-ok";
      return {
        stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    });
    const dependencies = Layer.mergeAll(
      ServerConfig.layerTest(root, root),
      Layer.mock(FactoryStore.FactoryStore)({ snapshot: Effect.sync(() => state) }),
      Layer.mock(FactoryBoundaryExecution.FactoryBoundaryExecution)({
        readCandidate: (id) => Effect.succeed(candidates.get(id)!),
      }),
      Layer.mock(PullRequestService.PullRequestService)({}),
      Layer.succeed(ProcessRunner.ProcessRunner, { run }),
      Layer.mock(FactorySource.FactorySource)({
        readRevision: () => Effect.succeed({ files: [workflowFile], excludedPaths: [] }),
      }),
    );
    yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const execution = yield* Execution.FactoryIntegrationExecution;
      const boundaries = [];
      for (const boundary of state.boundaries) {
        const profileId = yield* profileIdentity(boundary.id);
        const directory = path.join(config.stateDir, "factory", "execution", profileId);
        const project = path.join(directory, "project");
        for (const entry of files) {
          const target = path.join(project, entry.path);
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFile(target, Buffer.from(entry.content, "base64"));
        }
        const profile: FactoryExecutionProfile = {
          boundaryId: profileId,
          profileId,
          dockerContext,
          imageId,
          projectSnapshotPath: project,
          workflowSnapshotPath: path.join(directory, "workflow"),
          runtimePath: path.join(directory, "runtime"),
        };
        yield* fs.writeFileString(path.join(directory, "profile.json"), json(profile));
        boundaries.push({
          ...boundary,
          profileId,
          protectedPaths: ["runner.js", "gate.js"],
          gates: [
            {
              id: "check",
              label: "Project input check",
              protectedInputs: ["gate.js"],
              executable: "/usr/local/bin/node",
              args: ["/workspace/gate.js"],
              cwd: ".",
              timeoutMs: 30000,
            },
          ],
        });
      }
      state = { ...state, boundaries };
      for (const capability of state.integrationCapabilities) {
        const receipt = yield* execution.qualify({ capabilityId: capability.id });
        state = {
          ...state,
          integrationCapabilities: state.integrationCapabilities.map((entry) =>
            entry.id === capability.id
              ? {
                  ...entry,
                  qualification: { status: "qualified", ...receipt, checkedAt: deliveryNow },
                }
              : entry,
          ),
        };
      }
      for (const assignment of state.assignments.filter(
        (entry) => entry.id !== integrated.assignment,
      )) {
        const boundary = state.boundaries.find(
          (entry) => entry.id === assignment.grant!.boundaryId,
        )!;
        const revision = assignment.delivery!.revisions[0]!;
        candidates.set(revision.candidateId!, {
          id: revision.candidateId!,
          assignmentId: assignment.id,
          projectId: assignment.projectId,
          leadThreadId: assignment.threadId,
          startingSource: assignment.startingSource!,
          workflow: assignment.workflow,
          grant: assignment.grant!,
          configuration: boundary,
          sourceDigest: revision.candidateDigest!,
          files,
          deletedPaths: [],
          selectedPaths: [],
          startingFiles: files,
          startingIndexFiles: files,
          capturedAt: deliveryNow,
        });
      }
      const preparationId = state.integrations[0]!.currentPreparationId!;
      const prepared = yield* execution.prepare({ integrationId, preparationId });
      state = apply(
        state,
        { type: "integration.prepared", commandId: commandId(), ...prepared },
        host,
      ).state;
      const readProfile = (id: string) =>
        fs
          .readFileString(path.join(config.stateDir, "factory", "execution", id, "profile.json"))
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionProfile)),
            ),
          );
      const profile = yield* readProfile(prepared.profileId);
      yield* assertFactoryProfileActive(profile);
      assert.equal(profile.integration?.inputDigest, prepared.manifest.inputDigest);
      assert.include(
        factoryDockerArguments(profile),
        `satellite.factory.preparation=${preparationId}`,
      );
      const grant = state.integrationGrants.find((entry) => entry.projectId === api.project)!;
      for (const name of ["src/service.js", "runner.js", "../escape", "test/new/.git/config"]) {
        assert.equal(
          (yield* execution
            .mutate({
              integrationId,
              preparationId,
              grantId: grant.id,
              operationId: name,
              operation: { kind: "write", path: name, content: "bad" },
            })
            .pipe(Effect.flip)).code,
          "execution-unavailable",
        );
      }
      const edited = yield* execution.mutate({
        integrationId,
        preparationId,
        grantId: grant.id,
        operationId: "new-fixture",
        operation: { kind: "create", path: "fixtures/new/case.json", content: "{}" },
      });
      const projectPatch = edited.testArtifact.projects.find(
        (entry) => entry.projectId === api.project,
      )!;
      assert.deepEqual(projectPatch.changedPaths, ["fixtures/new/case.json"]);
      const page = yield* execution.readPatch({
        patchArtifactId: projectPatch.patchArtifactId,
        limit: 16,
      });
      assert.equal(page.text.length, 16);
      assert.equal(page.nextCursor, 16);
      const peerPatch = edited.testArtifact.projects.find(
        (entry) => entry.projectId === deliveryIds.project,
      )!;
      assert.deepEqual(peerPatch.changedPaths, []);
      const requested = apply(
        state,
        { type: "integration.verify", commandId: commandId(), integrationId, preparationId },
        actor(integrated.lead),
      );
      state = requested.state;
      const verificationId = requested.result.integrationVerificationId!;
      yield* execution.stop({ integrationId, preparationId, holdId: verificationId });
      assert.equal(
        (yield* assertFactoryProfileActive(profile).pipe(Effect.flip)).code,
        "execution-unavailable",
      );
      const verified = yield* execution.verify({ verificationId });
      assert.equal(verified.result, "passed");
      assert.equal(verified.checks.length, 3);
      if (live) assert.include(verified.checks.at(-1)!.output, "combined-flow-ok");
      state = apply(
        state,
        { type: "integration.verified", commandId: commandId(), ...verified },
        host,
      ).state;
      yield* execution.release({ integrationId, preparationId, holdId: verificationId });
      yield* assertFactoryProfileActive(profile);
      assert.deepEqual(yield* execution.verify({ verificationId }), verified);
      const beforeMergeHold = state;
      const mergeOperation = startedMergeOperationFixture().state.mergeOperations[0]!;
      state = {
        ...state,
        mergeOperations: [
          { ...mergeOperation, integrationId, integrationAssignmentId: integrated.assignment },
        ],
      };
      yield* execution.stop({ integrationId, preparationId, holdId: mergeOperation.id });
      // State admission keeps the frozen team stopped; only its lead may run to recover the merge.
      yield* assertFactoryProfileActive(profile);
      assert.equal(
        (yield* execution.capture({ integrationId, preparationId })).digest,
        verified.testArtifact.digest,
      );
      assert.equal(
        (yield* execution
          .release({ integrationId, preparationId, holdId: mergeOperation.id })
          .pipe(Effect.flip)).code,
        "execution-unavailable",
      );
      assert.equal(
        (yield* execution
          .mutate({
            integrationId,
            preparationId,
            grantId: grant.id,
            operationId: "merge-held-write",
            operation: { kind: "write", path: "fixtures/input.json", content: "{}" },
          })
          .pipe(Effect.flip)).code,
        "execution-unavailable",
      );
      state = beforeMergeHold;
      yield* execution.release({ integrationId, preparationId, holdId: mergeOperation.id });
      yield* assertFactoryProfileActive(profile);
      const beforePause = state;
      state = {
        ...state,
        controls: [
          {
            id: FactoryControlId.make("api-pause"),
            generation: 1,
            kind: "project-pause",
            projectId: api.project,
            status: "active",
            stop: { status: "confirmed", stoppedAt: deliveryNow },
            requestedAt: deliveryNow,
            updatedAt: deliveryNow,
          },
        ],
      };
      assert.equal(
        (yield* execution
          .mutate({
            integrationId,
            preparationId,
            grantId: grant.id,
            operationId: "paused",
            operation: { kind: "write", path: "fixtures/input.json", content: "{}" },
          })
          .pipe(Effect.flip)).code,
        "execution-unavailable",
      );
      state = beforePause;
      const refreshed = apply(
        state,
        {
          type: "integration.refresh",
          expectedPreparationId: state.integrations[0]!.currentPreparationId,
          commandId: commandId(),
          integrationId,
        },
        actor(integrated.lead),
      );
      state = refreshed.state;
      const secondId = state.integrations[0]!.currentPreparationId!;
      const second = yield* execution.prepare({ integrationId, preparationId: secondId });
      state = apply(
        state,
        { type: "integration.prepared", commandId: commandId(), ...second },
        host,
      ).state;
      assert.deepEqual(
        second.testArtifact.projects.find((entry) => entry.projectId === api.project)!.changedPaths,
        ["fixtures/new/case.json"],
      );
      yield* execution.stop({ integrationId, preparationId, holdId: "late-old-stop" });
      yield* assertFactoryProfileActive(yield* readProfile(second.profileId));
      const stopInvocations = invocations.filter((entry) => entry.args.includes("ps"));
      assert.isTrue(
        stopInvocations.every((entry) =>
          entry.args.some((arg) => arg.startsWith("label=satellite.factory.preparation=")),
        ),
      );
      if (live) {
        yield* execution.mutate({
          integrationId,
          preparationId: secondId,
          grantId: grant.id,
          operationId: "delay-for-revocation",
          operation: {
            kind: "write",
            path: "fixtures/input.json",
            content: '{"message":"ok","delay":60000}',
          },
        });
        const requested = apply(
          state,
          {
            type: "integration.verify",
            commandId: commandId(),
            integrationId,
            preparationId: secondId,
          },
          actor(integrated.lead),
        );
        state = requested.state;
        const verificationId = requested.result.integrationVerificationId!;
        yield* execution.stop({ integrationId, preparationId: secondId, holdId: verificationId });
        runningCheck = yield* Deferred.make<void>();
        const verifying = yield* execution
          .verify({ verificationId })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(runningCheck);
        const unpaused = state;
        state = {
          ...state,
          controls: [
            {
              id: FactoryControlId.make("running-api-pause"),
              generation: 1,
              kind: "project-pause",
              projectId: api.project,
              status: "active",
              stop: { status: "confirmed", stoppedAt: deliveryNow },
              requestedAt: deliveryNow,
              updatedAt: deliveryNow,
            },
          ],
        };
        yield* execution.stop({
          integrationId,
          preparationId: secondId,
          holdId: "running-revocation",
        });
        const stopped = yield* Fiber.join(verifying);
        assert.equal(stopped.result, "stopped");
        assert.equal(stopped.checks.at(-1)!.status, "stopped");
        state = apply(
          unpaused,
          { type: "integration.verified", commandId: commandId(), ...stopped },
          host,
        ).state;
        yield* execution.release({
          integrationId,
          preparationId: secondId,
          holdId: verificationId,
        });
        yield* execution.release({
          integrationId,
          preparationId: secondId,
          holdId: "running-revocation",
        });
        yield* execution.mutate({
          integrationId,
          preparationId: secondId,
          grantId: grant.id,
          operationId: "restore-delay",
          operation: { kind: "write", path: "fixtures/input.json", content: '{"message":"ok"}' },
        });
        runningCheck = undefined;
      }
      const changed = yield* file("fixtures/new/case.json", '{"upstream":true}');
      const candidate = candidates.get(
        grant.participantAssignmentId === api.assignment ? `candidate-${api.assignment}` : "",
      )!;
      candidates.set(candidate.id, { ...candidate, files: [...candidate.files, changed] });
      const next = apply(
        state,
        {
          type: "integration.refresh",
          commandId: commandId(),
          integrationId,
          expectedPreparationId: state.integrations[0]!.currentPreparationId,
        },
        actor(integrated.lead),
      );
      state = next.state;
      const conflict = yield* execution
        .prepare({ integrationId, preparationId: state.integrations[0]!.currentPreparationId! })
        .pipe(Effect.flip);
      assert.include(conflict.detail!, "conflict");
      const protectedChanged = yield* file("runner.js", "process.exit(0)");
      candidates.set(candidate.id, {
        ...candidate,
        files: candidate.files.map((entry) =>
          entry.path === "runner.js" ? protectedChanged : entry,
        ),
      });
      const protectedFailure = yield* execution
        .prepare({ integrationId, preparationId: state.integrations[0]!.currentPreparationId! })
        .pipe(Effect.flip);
      assert.include(protectedFailure.detail!, "protected");
      const patchFile = path.join(
        config.stateDir,
        "factory",
        "integration",
        "patches",
        yield* integrationDigest(projectPatch.patchArtifactId),
        "patch.json",
      );
      const original = yield* fs.readFileString(patchFile);
      yield* fs.writeFileString(
        patchFile,
        original.replace('"deletedPaths":[]', '"deletedPaths":["src/service.js"]'),
      );
      assert.equal(
        (yield* execution
          .readPatch({ patchArtifactId: projectPatch.patchArtifactId })
          .pipe(Effect.flip)).code,
        "execution-unavailable",
      );
    }).pipe(
      Effect.provide(
        Execution.layer.pipe(Layer.provide(Workflow.layer), Layer.provideMerge(dependencies)),
      ),
      Effect.ensuring(
        live
          ? Effect.suspend(() =>
              Effect.forEach(
                [...ownedVolumes],
                (volume) =>
                  realRunner
                    .run({
                      command: "docker",
                      args: ["--context", dockerContext, "volume", "rm", volume],
                    })
                    .pipe(Effect.ignore),
                { discard: true },
              ),
            )
          : Effect.void,
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );

it.effect(
  "pins two-project inputs, preserves scoped overlays, rejects changed authority and reconciles delayed stops",
  () => scenario(false),
);
const live =
  process.env.SATELLITE_FACTORY_INTEGRATION_LIVE_TEST === "1" ? it.effect : it.effect.skip;
live(
  "confines integration workers and executes a real frontend/API loopback flow from sealed inputs",
  () => scenario(true),
  180000,
);
