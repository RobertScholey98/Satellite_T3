import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryControlId,
  FactorySourceId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryAssignment,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import {
  factoryDockerArguments,
  FACTORY_CODEX_IMAGE,
  FactoryExecutionProfile,
} from "./FactoryExecutionProfile.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";
import { FactoryStore } from "./FactoryStore.ts";
import { FactorySource, type FactorySourceArtifact } from "./FactorySource.ts";
import { assertFactoryProfileActive } from "./FactoryProfileAuthority.ts";
import { initialFactoryCompletion } from "./FactoryRetros.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionProfile));
const decodeJournal = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      request: Schema.String,
      before: Schema.NullOr(Schema.String),
      after: Schema.NullOr(Schema.String),
      complete: Schema.Boolean,
    }),
  ),
);
const live = process.env.SATELLITE_FACTORY_LIVE_TEST === "1" ? it.effect : it.effect.skip;

live(
  "confines real Codex workers and verifies frozen candidate source with adopted controls",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const root = yield* fs.makeTempDirectoryScoped();
      const docker = (args: ReadonlyArray<string>) =>
        runner.run({ command: "docker", args, timeout: 30_000 });
      const dockerContext = (yield* docker(["context", "show"])).stdout.trim();
      const imageInspection = yield* docker([
        "image",
        "inspect",
        FACTORY_CODEX_IMAGE,
        "--format",
        "{{.Id}}",
      ]);
      const imageId = imageInspection.stdout.trim();
      let rejectDocker = false;
      let loseMutationResponse = false;
      let preparationBarrier:
        | {
            assignmentId: FactoryAssignmentId;
            entered: Deferred.Deferred<void>;
            release: Deferred.Deferred<void>;
            stopping: Deferred.Deferred<void>;
            volumeName: string | undefined;
          }
        | undefined;
      const executionRunner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          if (rejectDocker && input.command === "docker")
            return Effect.succeed({ ...imageInspection, code: null });
          const barrier = preparationBarrier;
          const preparationProbe =
            barrier !== undefined &&
            input.args?.includes(`satellite.factory.assignment=${barrier.assignmentId}`) &&
            input.args.some((arg) => arg.includes("factory-writable-boundary-ok"));
          if (preparationProbe)
            barrier.volumeName = input.args
              ?.find((arg) => arg.startsWith("type=volume,source="))
              ?.split(",")[1]
              ?.slice("source=".length);
          const before = preparationProbe
            ? Deferred.succeed(barrier.entered, undefined).pipe(
                Effect.andThen(Deferred.await(barrier.release)),
              )
            : Effect.void;
          return before.pipe(
            Effect.andThen(runner.run(input)),
            Effect.tap(() =>
              barrier !== undefined &&
              input.args?.includes("ps") &&
              input.args.includes(`label=satellite.factory.assignment=${barrier.assignmentId}`)
                ? Deferred.succeed(barrier.stopping, undefined)
                : Effect.void,
            ),
            Effect.map((result) => {
              if (loseMutationResponse && input.stdin?.includes('"kind":"mutate"')) {
                loseMutationResponse = false;
                return { ...result, code: null };
              }
              return result;
            }),
          );
        },
      });
      const managerId = ThreadId.make("manager");
      const projectId = ProjectId.make("boundary-fixture");
      const profileId = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const now = "2026-10-10T12:00:00.000Z";
      const workflow = { repositoryRoot: "/owned-workflow", revision: "a".repeat(40) };
      const initial = initialFactorySnapshot();
      const onboarding: FactoryAssignment = {
        id: FactoryAssignmentId.make("onboarding"),
        managerId,
        threadId: ThreadId.make("onboarding-lead"),
        projectId,
        kind: "onboarding",
        status: "complete",
        threadStatus: "created",
        launchStatus: "delivered",
        qualification: { status: "qualified", profileId, checkedAt: now },
        workflow,
        grantedPolicy: initial.defaults,
        wait: null,
        report: null,
        createdAt: now,
        updatedAt: now,
      };
      let state: FactorySnapshot = {
        ...initial,
        managers: [
          {
            id: managerId,
            threadId: managerId,
            projectId,
            role: "project",
            name: "Fixture",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
            workflow,
            overrides: {},
            status: "onboarding",
            threadStatus: "created",
            launchStatus: "delivered",
            wait: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        assignments: [onboarding],
      };
      const volumes: Array<string> = [];
      const sources = new Map<FactorySourceId, FactorySourceArtifact>();
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          volumes,
          (volume) =>
            docker(["--context", dockerContext, "volume", "rm", "--force", volume]).pipe(
              Effect.ignore,
            ),
          { discard: true },
        ),
      );
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const execution = yield* FactoryBoundaryExecution.FactoryBoundaryExecution;
        const directory = path.join(config.stateDir, "factory", "execution", profileId);
        const profile: FactoryExecutionProfile = {
          boundaryId: profileId,
          dockerContext,
          imageId,
          projectSnapshotPath: path.join(directory, "project"),
          workflowSnapshotPath: path.join(directory, "workflow"),
          runtimePath: path.join(directory, "sessions"),
          sourceRevision: "b".repeat(40),
        };
        const fixture = new Map([
          ["src/value.cjs", "module.exports = 1;"],
          ["src/unassigned.cjs", "module.exports = 'outside assignment';"],
          ["src/unapproved.cjs", "module.exports = 'outside baseline';"],
          [
            "tests/required.cjs",
            "require('node:assert/strict').equal(require('../src/value.cjs'), 2);",
          ],
          ["package.json", '{"scripts":{"test":"node tests/required.cjs"}}'],
          ["AGENTS.md", "Required tests cannot be weakened by source assignments."],
        ]);
        for (const [file, content] of fixture) {
          const target = path.join(profile.projectSnapshotPath, file);
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFileString(target, content);
        }
        yield* fs.makeDirectory(path.join(profile.workflowSnapshotPath, "skills"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(profile.workflowSnapshotPath, "skills", "SKILL.md"),
          "Owned immutable skill",
        );
        yield* fs.writeFileString(path.join(directory, "profile.json"), json(profile));
        const configuration = {
          protectedPaths: ["tests/required.cjs"],
          writablePaths: ["src/value.cjs", "src/unassigned.cjs"],
          creatableDirectories: ["src"],
          gates: [
            {
              id: "required",
              label: "Required test",
              executable: "/usr/local/bin/node",
              args: ["/workspace/tests/required.cjs"],
              cwd: ".",
              timeoutMs: 10000,
              protectedInputs: ["tests/required.cjs"],
            },
          ],
        };
        assert.equal(
          (yield* execution
            .approve({
              managerId,
              configuration: {
                ...configuration,
                gates: [{ ...configuration.gates[0]!, executable: "npm" }],
              },
            })
            .pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        const boundary = yield* execution.approve({ managerId, configuration });
        yield* fs.writeFileString(
          path.join(profile.projectSnapshotPath, "src", "value.cjs"),
          "module.exports = 99;",
        );
        assert.deepEqual(yield* execution.approve({ managerId, configuration }), boundary);
        assert.equal(
          yield* fs.readFileString(
            path.join(
              config.stateDir,
              "factory",
              "boundaries",
              boundary.id,
              "source",
              "src",
              "value.cjs",
            ),
          ),
          "module.exports = 1;",
        );
        rejectDocker = true;
        assert.equal(
          (yield* execution.approve({ managerId, configuration }).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        rejectDocker = false;
        assert.include(boundary.protectedPaths, "package.json");
        const assignment: FactoryAssignment = {
          ...onboarding,
          id: FactoryAssignmentId.make(`implementation-${profileId}`),
          threadId: ThreadId.make("implementation-lead"),
          kind: "implementation",
          authorization: { kind: "human", commandId: CommandId.make("commission") },
          status: "running",
          grant: {
            boundaryId: boundary.id,
            epoch: 0,
            sourcePaths: ["src/value.cjs"],
            creatableDirectories: ["src"],
            controlChange: null,
          },
        };
        state = { ...state, boundaries: [boundary], assignments: [onboarding, assignment] };
        const cancelledDuringPreparation: FactoryAssignment = {
          ...assignment,
          id: FactoryAssignmentId.make(`cancel-preparing-${profileId}`),
          threadId: ThreadId.make("cancel-preparing-lead"),
          qualification: { status: "unavailable", reason: "Preparing the workspace" },
        };
        state = { ...state, assignments: [...state.assignments, cancelledDuringPreparation] };
        const prepareCancelled = {
          assignmentId: cancelledDuringPreparation.id,
          threadId: cancelledDuringPreparation.threadId,
          boundaryId: boundary.id,
          grant: cancelledDuringPreparation.grant!,
        };
        const barrier = {
          assignmentId: cancelledDuringPreparation.id,
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
          stopping: yield* Deferred.make<void>(),
          volumeName: undefined as string | undefined,
        };
        preparationBarrier = barrier;
        const preparing = yield* execution
          .prepare(prepareCancelled)
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(barrier.entered);
        state = {
          ...state,
          assignments: state.assignments.map((entry) =>
            entry.id === cancelledDuringPreparation.id
              ? {
                  ...entry,
                  outcome: {
                    kind: "cancelled",
                    controlId: FactoryControlId.make("cancel-preparing"),
                  },
                }
              : entry,
          ),
        };
        const stopping = yield* execution
          .stop(cancelledDuringPreparation.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(barrier.stopping);
        assert.isUndefined(
          stopping.pollUnsafe(),
          "Stop cannot confirm while preparation still holds its operation permit",
        );
        yield* Deferred.succeed(barrier.release, undefined);
        assert.equal((yield* Fiber.join(preparing))._tag, "Failure");
        yield* Fiber.join(stopping);
        preparationBarrier = undefined;
        assert.isDefined(barrier.volumeName);
        assert.notEqual((yield* docker(["volume", "inspect", barrier.volumeName!])).code, 0);
        const cancelledProfileId = barrier.volumeName!.slice("satellite-factory-".length);
        assert.isFalse(
          yield* fs.exists(
            path.join(config.stateDir, "factory", "execution", cancelledProfileId, "profile.json"),
          ),
        );
        yield* Effect.gen(function* () {
          const recreated = yield* FactoryBoundaryExecution.FactoryBoundaryExecution;
          assert.equal(
            (yield* recreated.prepare(prepareCancelled).pipe(Effect.flip)).code,
            "permission-denied",
          );
        }).pipe(Effect.provide(FactoryBoundaryExecution.layer));
        const qualification = yield* execution.prepare({
          assignmentId: assignment.id,
          threadId: assignment.threadId,
          boundaryId: boundary.id,
          grant: assignment.grant!,
        });
        if (qualification.status !== "qualified") return assert.fail(qualification.reason);
        const prepared = yield* fs
          .readFileString(
            path.join(
              config.stateDir,
              "factory",
              "execution",
              qualification.profileId,
              "profile.json",
            ),
          )
          .pipe(Effect.flatMap(decodeProfile));
        volumes.push(prepared.assignmentWorkspace!.volumeName);
        state = { ...state, assignments: [onboarding, { ...assignment, qualification }] };
        assert.deepEqual(
          (yield* execution.prepare({
            assignmentId: assignment.id,
            threadId: assignment.threadId,
            boundaryId: boundary.id,
            grant: assignment.grant!,
          })).status,
          "qualified",
        );
        const failed = yield* execution.verify({ assignmentId: assignment.id, expectedEpoch: 0 });
        assert.equal(failed.gates[0]?.status, "failed");
        const worker = yield* docker([
          ...factoryDockerArguments(prepared).slice(2),
          "--entrypoint",
          "node",
          prepared.imageId,
          "-e",
          "require('node:fs').writeFileSync('/workspace/src/value.cjs', 'module.exports = 2;')",
        ]);
        assert.equal(worker.code, 0, worker.stderr);
        const runningBeforePause = yield* docker([
          ...factoryDockerArguments(prepared).slice(2),
          "--detach",
          "--entrypoint",
          "node",
          prepared.imageId,
          "-e",
          "setInterval(()=>{},1000)",
        ]);
        assert.equal(runningBeforePause.code, 0, runningBeforePause.stderr);
        const pausedContainerId = runningBeforePause.stdout.trim();
        const unaffected = yield* docker([
          "run",
          "--rm",
          "--detach",
          "--entrypoint",
          "node",
          prepared.imageId,
          "-e",
          "setInterval(()=>{},1000)",
        ]);
        assert.equal(unaffected.code, 0, unaffected.stderr);
        const unaffectedId = unaffected.stdout.trim();
        yield* Effect.addFinalizer(() =>
          docker(["rm", "--force", pausedContainerId, unaffectedId]).pipe(Effect.ignore),
        );
        rejectDocker = true;
        assert.equal(
          (yield* execution
            .suspend({ assignmentId: assignment.id, generation: 1 })
            .pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        assert.include(
          (yield* assertFactoryProfileActive(prepared).pipe(Effect.flip)).detail!,
          "paused",
        );
        rejectDocker = false;
        yield* execution.suspend({ assignmentId: assignment.id, generation: 1 });
        assert.notEqual((yield* docker(["inspect", pausedContainerId])).code, 0);
        assert.equal(
          (yield* docker([
            "inspect",
            "--format",
            "{{.State.Running}}",
            unaffectedId,
          ])).stdout.trim(),
          "true",
        );
        yield* Effect.gen(function* () {
          const restarted = yield* FactoryBoundaryExecution.FactoryBoundaryExecution;
          assert.include(
            (yield* restarted
              .verify({ assignmentId: assignment.id, expectedEpoch: 0 })
              .pipe(Effect.flip)).detail!,
            "paused",
          );
          assert.include(
            (yield* restarted
              .mutate({
                assignmentId: assignment.id,
                expectedEpoch: 0,
                commandId: CommandId.make("denied-while-paused"),
                operation: { kind: "write", path: "src/value.cjs", content: "module.exports = 9;" },
              })
              .pipe(Effect.flip)).detail!,
            "paused",
          );
          assert.include(
            (yield* restarted
              .prepare({
                assignmentId: assignment.id,
                threadId: assignment.threadId,
                boundaryId: boundary.id,
                grant: assignment.grant!,
              })
              .pipe(Effect.flip)).detail!,
            "paused",
          );
          assert.equal(
            (yield* restarted
              .resume({ assignmentId: assignment.id, generation: 0 })
              .pipe(Effect.flip)).code,
            "invalid-state",
          );
          yield* restarted.resume({ assignmentId: assignment.id, generation: 1 });
          yield* restarted.resume({ assignmentId: assignment.id, generation: 1 });
          yield* restarted.suspend({ assignmentId: assignment.id, generation: 1 });
          yield* assertFactoryProfileActive(prepared);
          yield* restarted.suspend({ assignmentId: assignment.id, generation: 2 });
          assert.equal(
            (yield* restarted
              .resume({ assignmentId: assignment.id, generation: 1 })
              .pipe(Effect.flip)).code,
            "invalid-state",
          );
          assert.equal(
            (yield* restarted
              .suspend({ assignmentId: assignment.id, generation: 1 })
              .pipe(Effect.flip)).code,
            "invalid-state",
          );
          assert.include(
            (yield* assertFactoryProfileActive(prepared).pipe(Effect.flip)).detail!,
            "paused",
          );
          yield* restarted.resume({ assignmentId: assignment.id, generation: 2 });
          const preserved = yield* restarted.verify({
            assignmentId: assignment.id,
            expectedEpoch: 0,
          });
          assert.equal(preserved.gates[0]?.status, "passed");
          const artifact = yield* restarted.exportArtifact({
            assignmentId: assignment.id,
            artifactId: preserved.artifactId,
          });
          assert.equal(
            yield* fs.readFileString(path.join(artifact.sourcePath, "src", "value.cjs")),
            "module.exports = 2;",
          );
          assert.equal(
            state.assignments.find((entry) => entry.id === assignment.id)?.grant?.epoch,
            0,
          );
        }).pipe(Effect.provide(FactoryBoundaryExecution.layer));
        const narrowed = yield* docker([
          ...factoryDockerArguments(prepared).slice(2),
          "--entrypoint",
          "node",
          prepared.imageId,
          "-e",
          "const f=require('node:fs');for(const path of ['/workspace/src/unassigned.cjs','/workspace/src/unapproved.cjs']){let denied=false;try{f.writeFileSync(path,'forbidden')}catch(e){denied=e.code==='EACCES'}if(!denied)throw Error('existing file escaped grant')} ",
        ]);
        assert.equal(narrowed.code, 0, narrowed.stderr);
        const passed = yield* execution.verify({ assignmentId: assignment.id, expectedEpoch: 0 });
        assert.equal(passed.gates[0]?.status, "passed");
        assert.equal(
          (yield* execution.exportArtifact({
            assignmentId: assignment.id,
            artifactId: passed.artifactId,
          })).sourceDigest,
          passed.sourceDigest,
        );
        const freshId = FactorySourceId.make(yield* (yield* Crypto.Crypto).randomUUIDv4);
        const freshFiles = yield* Effect.forEach(
          [
            ...fixture,
            ["src/new-existing.cjs", "module.exports = 'fresh';"],
            ["src/new-unassigned.cjs", "module.exports = 'unassigned';"],
          ] as ReadonlyArray<readonly [string, string]>,
          ([name, initialContent]) =>
            Effect.gen(function* () {
              const content = name === "src/value.cjs" ? "module.exports = 2;" : initialContent;
              return {
                path: name,
                content: Buffer.from(content).toString("base64"),
                digest: Buffer.from(
                  yield* (yield* Crypto.Crypto).digest("SHA-256", Buffer.from(content)),
                ).toString("hex"),
                mode: name === "src/new-existing.cjs" ? ("100755" as const) : ("100644" as const),
              };
            }),
        );
        const freshArtifact: FactorySourceArtifact = {
          source: {
            id: freshId,
            projectId,
            revision: "c".repeat(40),
            sourceDigest: "fresh-source-digest",
            branch: "main",
            origin: "project",
            capturedAt: now,
            fileCount: freshFiles.length,
            stagedPaths: [],
            unstagedPaths: [],
            untrackedPaths: [],
            deletedPaths: [],
            excludedPaths: [],
          },
          request: { requestId: CommandId.make("fresh-source"), projectId },
          workspaceRoot: "/original",
          files: freshFiles,
          indexFiles: freshFiles,
          indexData: null,
        };
        sources.set(freshId, freshArtifact);
        const freshAssignment: FactoryAssignment = {
          ...assignment,
          id: FactoryAssignmentId.make(`fresh-${profileId}`),
          threadId: ThreadId.make("fresh-lead"),
          startingSource: freshArtifact.source,
          grant: { ...assignment.grant!, sourcePaths: ["src/value.cjs", "src/new-existing.cjs"] },
        };
        state = { ...state, assignments: [...state.assignments, freshAssignment] };
        const freshInput = {
          assignmentId: freshAssignment.id,
          threadId: freshAssignment.threadId,
          boundaryId: boundary.id,
          grant: freshAssignment.grant!,
          startingSourceId: freshId,
        };
        assert.equal(
          (yield* execution
            .prepare({
              assignmentId: freshInput.assignmentId,
              threadId: freshInput.threadId,
              boundaryId: freshInput.boundaryId,
              grant: freshInput.grant,
            })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        const changedControls = freshFiles.map((file) =>
          file.path === "package.json"
            ? { ...file, content: Buffer.from("{}").toString("base64") }
            : file,
        );
        sources.set(freshId, { ...freshArtifact, files: changedControls });
        assert.include(
          (yield* execution.prepare(freshInput).pipe(Effect.flip)).detail!,
          "protected control package.json",
        );
        sources.set(freshId, { ...freshArtifact, indexFiles: changedControls });
        assert.include(
          (yield* execution.prepare(freshInput).pipe(Effect.flip)).detail!,
          "protected control package.json",
        );
        sources.set(freshId, freshArtifact);
        const freshQualification = yield* execution.prepare(freshInput);
        if (freshQualification.status !== "qualified")
          return assert.fail(freshQualification.reason);
        const freshProfile = yield* fs
          .readFileString(
            path.join(
              config.stateDir,
              "factory",
              "execution",
              freshQualification.profileId,
              "profile.json",
            ),
          )
          .pipe(Effect.flatMap(decodeProfile));
        volumes.push(freshProfile.assignmentWorkspace!.volumeName);
        state = {
          ...state,
          assignments: state.assignments.map((entry) =>
            entry.id === freshAssignment.id
              ? { ...entry, qualification: freshQualification }
              : entry,
          ),
        };
        assert.equal(freshProfile.sourceRevision, freshArtifact.source.revision);
        assert.equal(freshProfile.startingSourceDigest, freshArtifact.source.sourceDigest);
        const collectingState = state;
        for (const phase of ["concluding", "concluded"] as const) {
          state = {
            ...collectingState,
            assignments: collectingState.assignments.map((entry) =>
              entry.id === freshAssignment.id
                ? { ...entry, completion: { ...initialFactoryCompletion(entry.scope), phase } }
                : entry,
            ),
          };
          assert.equal(
            (yield* execution
              .verify({ assignmentId: freshAssignment.id, expectedEpoch: 0 })
              .pipe(Effect.flip)).code,
            "permission-denied",
          );
          assert.equal(
            (yield* execution
              .mutate({
                assignmentId: freshAssignment.id,
                expectedEpoch: 0,
                commandId: CommandId.make(`late-mutate:${phase}`),
                operation: { kind: "write", path: "src/value.cjs", content: "module.exports=99;" },
              })
              .pipe(Effect.flip)).code,
            "permission-denied",
          );
        }
        state = collectingState;
        assert.equal(
          (yield* execution.verify({ assignmentId: freshAssignment.id, expectedEpoch: 0 })).gates[0]
            ?.status,
          "passed",
        );
        const freshWorker = yield* docker([
          ...factoryDockerArguments(freshProfile).slice(2),
          "--entrypoint",
          "node",
          freshProfile.imageId,
          "-e",
          "const f=require('node:fs');if(require('/workspace/src/value.cjs')!==2)throw Error('stale source');f.accessSync('/workspace/src/new-existing.cjs',f.constants.X_OK);f.writeFileSync('/workspace/src/new-existing.cjs','updated');for(const p of ['new-unassigned','unapproved']){let denied=false;try{f.writeFileSync('/workspace/src/'+p+'.cjs','forbidden')}catch(e){denied=e.code==='EACCES'}if(!denied)throw Error('fresh existing file escaped grant')}",
        ]);
        assert.equal(freshWorker.code, 0, freshWorker.stderr);
        for (const kind of ["create-only", "deleted-only"] as const) {
          const captured = {
            ...freshArtifact,
            source: {
              ...freshArtifact.source,
              id: FactorySourceId.make(`${freshId}:${kind}`),
              sourceDigest: `digest:${kind}`,
            },
            files:
              kind === "create-only"
                ? freshFiles
                : freshFiles.filter((file) => file.path !== "src/value.cjs"),
            indexFiles:
              kind === "create-only"
                ? freshFiles
                : freshFiles.filter((file) => file.path !== "src/value.cjs"),
          };
          sources.set(captured.source.id, captured);
          const narrow: FactoryAssignment = {
            ...freshAssignment,
            id: FactoryAssignmentId.make(`${freshAssignment.id}:${kind}`),
            threadId: ThreadId.make(`lead:${kind}`),
            startingSource: captured.source,
            grant: {
              boundaryId: boundary.id,
              epoch: 0,
              sourcePaths: kind === "create-only" ? [] : ["src/value.cjs"],
              creatableDirectories: kind === "create-only" ? ["src"] : [],
              controlChange: null,
            },
          };
          state = { ...state, assignments: [...state.assignments, narrow] };
          const qualified = yield* execution.prepare({
            assignmentId: narrow.id,
            threadId: narrow.threadId,
            boundaryId: boundary.id,
            grant: narrow.grant!,
            startingSourceId: captured.source.id,
          });
          if (qualified.status !== "qualified") return assert.fail(qualified.reason);
          const narrowProfile = yield* fs
            .readFileString(
              path.join(
                config.stateDir,
                "factory",
                "execution",
                qualified.profileId,
                "profile.json",
              ),
            )
            .pipe(Effect.flatMap(decodeProfile));
          volumes.push(narrowProfile.assignmentWorkspace!.volumeName);
          state = {
            ...state,
            assignments: state.assignments.map((entry) =>
              entry.id === narrow.id ? { ...entry, qualification: qualified } : entry,
            ),
          };
          const inspected = yield* docker([
            ...factoryDockerArguments(narrowProfile).slice(2),
            "--entrypoint",
            "node",
            narrowProfile.imageId,
            "-e",
            `const f=require('node:fs');if(f.readdirSync('/workspace/src').some(p=>p.startsWith('factory-runtime-probe-')))throw Error('probe leaked');${kind === "deleted-only" ? "if(f.existsSync('/workspace/src/value.cjs'))throw Error('deletion lost')" : "try{f.writeFileSync('/workspace/src/value.cjs','bad');throw Error('existing file exposed')}catch(e){if(e.code!=='EACCES')throw e}"}`,
          ]);
          assert.equal(inspected.code, 0, inspected.stderr);
          yield* execution.mutate({
            assignmentId: narrow.id,
            expectedEpoch: 0,
            commandId: CommandId.make(`create:${kind}`),
            operation: {
              kind: "create",
              path: kind === "create-only" ? "src/new-component.cjs" : "src/value.cjs",
              content: "module.exports = 2;",
            },
          });
          assert.equal(
            (yield* execution.verify({ assignmentId: narrow.id, expectedEpoch: 0 })).gates[0]
              ?.status,
            "passed",
          );
        }
        assert.equal(
          (yield* execution
            .mutate({
              assignmentId: freshAssignment.id,
              expectedEpoch: 0,
              commandId: CommandId.make("fresh-unassigned"),
              operation: { kind: "write", path: "src/new-unassigned.cjs", content: "forbidden" },
            })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        const create = {
          assignmentId: assignment.id,
          expectedEpoch: 0,
          commandId: CommandId.make("create"),
          operation: {
            kind: "create" as const,
            path: "src/created.cjs",
            content: "module.exports = true;",
          },
        };
        loseMutationResponse = true;
        assert.equal(
          (yield* execution.mutate(create).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        const journalDirectory = path.join(
          path.dirname(path.dirname(prepared.assignmentWorkspace!.revocationPath)),
          "journal",
        );
        const journalFile = path.join(
          journalDirectory,
          (yield* fs.readDirectory(journalDirectory)).find((entry) => entry.endsWith(".json"))!,
        );
        const journal = yield* fs.readFileString(journalFile).pipe(Effect.flatMap(decodeJournal));
        yield* fs.writeFileString(journalFile, json({ ...journal, complete: false }));
        yield* execution.mutate(create);
        yield* execution.mutate(create);
        assert.equal(
          (yield* execution
            .exportArtifact({ assignmentId: assignment.id, artifactId: passed.artifactId })
            .pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        const rename = {
          ...create,
          commandId: CommandId.make("rename"),
          operation: { kind: "rename" as const, path: "src/created.cjs", to: "src/renamed.cjs" },
        };
        loseMutationResponse = true;
        assert.equal(
          (yield* execution.mutate(rename).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        yield* execution.mutate(rename);
        const remove = {
          ...create,
          commandId: CommandId.make("delete"),
          operation: { kind: "delete" as const, path: "src/renamed.cjs" },
        };
        loseMutationResponse = true;
        assert.equal(
          (yield* execution.mutate(remove).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        yield* execution.mutate(remove);
        for (const file of [
          "src/new/AGENTS.md",
          "src/new/package.json",
          "src/new/eslint.config.js",
          "src/../tests/required.cjs",
          "/host/secret",
          "tests/required.cjs",
          "src/unassigned.cjs",
          "src/unapproved.cjs",
        ]) {
          assert.equal(
            (yield* execution
              .mutate({
                ...create,
                commandId: CommandId.make(`denied-${file}`),
                operation: { kind: "create", path: file, content: "forbidden" },
              })
              .pipe(Effect.flip)).code,
            "permission-denied",
          );
        }
        assert.equal(
          (yield* execution.mutate({ ...create, expectedEpoch: 1 }).pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.equal(
          yield* fs.readFileString(
            path.join(prepared.assignmentWorkspace!.controlsPath, "tests", "required.cjs"),
          ),
          fixture.get("tests/required.cjs"),
        );
        const ruleAssignment: FactoryAssignment = {
          ...assignment,
          id: FactoryAssignmentId.make(`rule-${profileId}`),
          threadId: ThreadId.make("rule-lead"),
          kind: "rule-change",
          authorization: { kind: "human", commandId: CommandId.make("rule-authorization") },
          grant: {
            boundaryId: boundary.id,
            epoch: 0,
            sourcePaths: [],
            creatableDirectories: [],
            controlChange: { authorizationId: "rule-authorization", paths: ["tests/required.cjs"] },
          },
        };
        state = { ...state, assignments: [...state.assignments, ruleAssignment] };
        const ruleQualification = yield* execution.prepare({
          assignmentId: ruleAssignment.id,
          threadId: ruleAssignment.threadId,
          boundaryId: boundary.id,
          grant: ruleAssignment.grant!,
        });
        if (ruleQualification.status !== "qualified") return assert.fail(ruleQualification.reason);
        const ruleProfile = yield* fs
          .readFileString(
            path.join(
              config.stateDir,
              "factory",
              "execution",
              ruleQualification.profileId,
              "profile.json",
            ),
          )
          .pipe(Effect.flatMap(decodeProfile));
        volumes.push(ruleProfile.assignmentWorkspace!.volumeName);
        state = {
          ...state,
          assignments: state.assignments.map((entry) =>
            entry.id === ruleAssignment.id ? { ...entry, qualification: ruleQualification } : entry,
          ),
        };
        const weaken = {
          assignmentId: ruleAssignment.id,
          expectedEpoch: 0,
          commandId: CommandId.make("candidate-rule-change"),
          operation: {
            kind: "write" as const,
            path: "tests/required.cjs",
            content: "process.exit(0);",
          },
        };
        yield* execution.mutate(weaken);
        assert.equal(
          (yield* execution.verify({ assignmentId: ruleAssignment.id, expectedEpoch: 0 })).gates[0]
            ?.status,
          "failed",
        );
        assert.equal(
          (yield* execution.verify({ assignmentId: assignment.id, expectedEpoch: 0 })).gates[0]
            ?.status,
          "passed",
        );
        state = {
          ...state,
          assignments: state.assignments.map((entry) =>
            entry.id === ruleAssignment.id
              ? {
                  ...entry,
                  authorization: {
                    kind: "manager" as const,
                    commandId: CommandId.make("rule-authorization"),
                    threadId: managerId,
                  },
                }
              : entry,
          ),
        };
        assert.equal(
          (yield* execution
            .mutate({ ...weaken, commandId: CommandId.make("manager-cannot-weaken") })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        const running = yield* docker([
          ...factoryDockerArguments(prepared).slice(2),
          "--detach",
          "--entrypoint",
          "node",
          prepared.imageId,
          "-e",
          "const f=require('node:fs');const fd=f.openSync('/workspace/src/value.cjs','a');setInterval(()=>f.writeSync(fd,'\\n//live'),20)",
        ]);
        assert.equal(running.code, 0, running.stderr);
        const containerId = running.stdout.trim();
        assert.match(containerId, /^[a-f0-9]{64}$/);
        yield* Effect.addFinalizer(() =>
          docker(["rm", "--force", containerId]).pipe(Effect.ignore),
        );
        state = {
          ...state,
          assignments: state.assignments.map((entry) =>
            entry.id === assignment.id
              ? {
                  ...entry,
                  grant: { ...entry.grant!, epoch: 1, sourcePaths: [], creatableDirectories: [] },
                }
              : entry,
          ),
        };
        yield* execution.stop(assignment.id);
        assert.notEqual((yield* docker(["inspect", containerId])).code, 0);
        assert.equal(
          (yield* execution
            .verify({ assignmentId: assignment.id, expectedEpoch: 0 })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.isTrue(yield* fs.exists(prepared.assignmentWorkspace!.revocationPath));
        state = {
          ...state,
          assignments: state.assignments.map((entry) =>
            entry.id === assignment.id ? { ...entry, grant: assignment.grant! } : entry,
          ),
        };
        yield* Effect.gen(function* () {
          const restarted = yield* FactoryBoundaryExecution.FactoryBoundaryExecution;
          assert.equal(
            (yield* restarted
              .verify({ assignmentId: assignment.id, expectedEpoch: 0 })
              .pipe(Effect.flip)).code,
            "permission-denied",
          );
          assert.equal(
            (yield* restarted
              .resume({ assignmentId: assignment.id, generation: 2 })
              .pipe(Effect.flip)).code,
            "permission-denied",
          );
        }).pipe(Effect.provide(FactoryBoundaryExecution.layer));
        yield* execution.suspend({ assignmentId: freshAssignment.id, generation: 1 });
        assert.equal(
          (yield* docker(["volume", "rm", freshProfile.assignmentWorkspace!.volumeName])).code,
          0,
        );
        assert.equal(
          (yield* execution
            .resume({ assignmentId: freshAssignment.id, generation: 1 })
            .pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        assert.include(
          (yield* assertFactoryProfileActive(freshProfile).pipe(Effect.flip)).detail!,
          "paused",
        );
      }).pipe(
        Effect.provide(
          FactoryBoundaryExecution.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                ServerConfig.layerTest(root, root),
                Layer.mock(FactoryStore)({ snapshot: Effect.sync(() => state) }),
                Layer.succeed(ProcessRunner.ProcessRunner, executionRunner),
                Layer.mock(FactorySource)({
                  read: (id) =>
                    sources.has(id)
                      ? Effect.succeed(sources.get(id)!)
                      : Effect.die("Missing source fixture"),
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(ProcessRunner.layer), Effect.provide(NodeServices.layer)),
  180000,
);
