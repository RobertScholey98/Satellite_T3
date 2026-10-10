import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryAssignment,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
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
      const executionRunner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          if (rejectDocker && input.command === "docker")
            return Effect.succeed({ ...imageInspection, code: null });
          return runner.run(input).pipe(
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
        }).pipe(Effect.provide(FactoryBoundaryExecution.layer));
      }).pipe(
        Effect.provide(
          FactoryBoundaryExecution.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                ServerConfig.layerTest(root, root),
                Layer.mock(FactoryStore)({ snapshot: Effect.sync(() => state) }),
                Layer.succeed(ProcessRunner.ProcessRunner, executionRunner),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(ProcessRunner.layer), Effect.provide(NodeServices.layer)),
  120000,
);
