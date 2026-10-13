import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryControlId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryAssignment,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import {
  factoryDockerArguments,
  FACTORY_AGENT_IMAGE,
  FactoryExecutionProfile,
} from "./FactoryExecutionProfile.ts";
import { assertFactoryProfileActive } from "./FactoryProfileAuthority.ts";
import * as FactorySource from "./FactorySource.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";
import * as FactoryStore from "./FactoryStore.ts";

const live = process.env.SATELLITE_FACTORY_LIVE_TEST === "1" ? it.effect : it.effect.skip;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionProfile));

live(
  "diagnosis freezes unfinished edits read-only and a fresh lead keeps the original volume and authority",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workflowBytes = Buffer.from("Pinned skill");
      const workflowFile = {
        path: "skills/SKILL.md",
        content: workflowBytes.toString("base64"),
        digest: Buffer.from(
          yield* (yield* Crypto.Crypto).digest("SHA-256", workflowBytes),
        ).toString("hex"),
        mode: "100644" as const,
      };
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const root = yield* fs.makeTempDirectoryScoped();
      const docker = (args: ReadonlyArray<string>) =>
        runner.run({ command: "docker", args, timeout: 30_000 });
      const dockerContext = (yield* docker(["context", "show"])).stdout.trim();
      const imageId = (yield* docker([
        "image",
        "inspect",
        FACTORY_AGENT_IMAGE,
        "--format",
        "{{.Id}}",
      ])).stdout.trim();
      const profileId = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const projectId = ProjectId.make("recovery-project");
      const managerId = ThreadId.make("recovery-manager");
      const assignmentId = FactoryAssignmentId.make(`recovery-${profileId}`);
      const leadId = ThreadId.make("original-lead");
      const replacementId = ThreadId.make("replacement-lead");
      const model = { instanceId: ProviderInstanceId.make("codex"), model: "approved" };
      const workflow = { repositoryRoot: "/owned-workflow", revision: "a".repeat(40) };
      const now = "2026-10-10T12:00:00.000Z";
      const initial = initialFactorySnapshot();
      const onboarding: FactoryAssignment = {
        id: FactoryAssignmentId.make("onboarding"),
        managerId,
        threadId: ThreadId.make("discovery"),
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
            name: "Recovery",
            modelSelection: model,
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
      let gatesRun = 0;
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const execution = yield* FactoryBoundaryExecution.FactoryBoundaryExecution;
        const directory = path.join(config.stateDir, "factory", "execution", profileId);
        const original: FactoryExecutionProfile = {
          boundaryId: profileId,
          dockerContext,
          imageId,
          projectSnapshotPath: path.join(directory, "project"),
          workflowSnapshotPath: path.join(directory, "workflow"),
          runtimePath: path.join(directory, "sessions"),
          sourceRevision: "b".repeat(40),
        };
        for (const [file, content] of [
          ["src/value.cjs", "module.exports = 1;"],
          [
            "tests/required.cjs",
            "require('node:assert/strict').equal(require('../src/value.cjs'), 2);",
          ],
          ["AGENTS.md", "Preserve protected tests"],
        ]) {
          const target = path.join(original.projectSnapshotPath, file!);
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFileString(target, content!);
        }
        yield* fs.makeDirectory(path.join(original.workflowSnapshotPath, "skills"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(original.workflowSnapshotPath, "skills", "SKILL.md"),
          "Pinned skill",
        );
        yield* fs.writeFileString(path.join(directory, "profile.json"), json(original));
        const boundary = yield* execution.approve({
          managerId,
          configuration: {
            protectedPaths: ["tests/required.cjs"],
            writablePaths: ["src/value.cjs"],
            creatableDirectories: [],
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
          },
        });
        const assignment: FactoryAssignment = {
          ...onboarding,
          id: assignmentId,
          threadId: leadId,
          kind: "implementation",
          status: "running",
          modelSelection: model,
          modelPolicy: { approvedModels: [model], preferences: [] },
          oversight: { recovery: { cyclesUsed: 1, history: [] } },
          scope: {
            description: "Change the value",
            completionCondition: "The required test passes",
            requiresPullRequest: true,
          },
          authorization: { kind: "human", commandId: CommandId.make("commission") },
          grant: {
            boundaryId: boundary.id,
            epoch: 0,
            sourcePaths: ["src/value.cjs"],
            creatableDirectories: [],
            controlChange: null,
          },
        };
        state = { ...state, boundaries: [boundary], assignments: [onboarding, assignment] };
        const qualification = yield* execution.prepare({
          assignmentId,
          threadId: leadId,
          boundaryId: boundary.id,
          grant: assignment.grant!,
        });
        if (qualification.status !== "qualified") return assert.fail(qualification.reason);
        const profile = (id: string) =>
          fs
            .readFileString(path.join(config.stateDir, "factory", "execution", id, "profile.json"))
            .pipe(Effect.flatMap(decodeProfile));
        const prepared = yield* profile(qualification.profileId);
        yield* Effect.addFinalizer(() =>
          docker(["volume", "rm", "--force", prepared.assignmentWorkspace!.volumeName]).pipe(
            Effect.ignore,
          ),
        );
        state = { ...state, assignments: [onboarding, { ...assignment, qualification }] };
        yield* execution.mutate({
          assignmentId,
          expectedEpoch: 0,
          commandId: CommandId.make("earlier-good-edit"),
          operation: { kind: "write", path: "src/value.cjs", content: "module.exports = 2;" },
        });
        const historical = yield* execution.verify({ assignmentId, expectedEpoch: 0 });
        assert.equal(historical.gates[0]?.status, "passed");
        yield* execution.mutate({
          assignmentId,
          expectedEpoch: 0,
          commandId: CommandId.make("unfinished-edit"),
          operation: { kind: "write", path: "src/value.cjs", content: "module.exports = 7;" },
        });
        const verification = yield* execution.verify({ assignmentId, expectedEpoch: 0 });
        assert.equal(verification.gates[0]?.status, "failed");
        state = {
          ...state,
          assignments: [onboarding, { ...assignment, qualification, verification }],
        };
        const gateCount = gatesRun;
        const request = { assignmentId, threadId: ThreadId.make("diagnosis"), expectedEpoch: 0 };
        const inspection = yield* execution.inspect(request);
        const inspectionProfile = yield* profile(inspection.qualification.profileId);
        const evidence = yield* fs
          .readFileString(path.join(inspectionProfile.inspection!.evidencePath, "assignment.json"))
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(
                  Schema.Struct({
                    sourceDigest: Schema.String,
                    oversight: Schema.Struct({
                      recovery: Schema.Struct({ cyclesUsed: Schema.Number }),
                    }),
                  }),
                ),
              ),
            ),
          );
        assert.equal(evidence.sourceDigest, inspection.sourceDigest);
        assert.equal(evidence.oversight.recovery.cyclesUsed, 1);
        assert.equal(
          gatesRun,
          gateCount,
          "Reading a failed candidate must not run or require passing gates",
        );
        const inspected = yield* docker([
          ...factoryDockerArguments(inspectionProfile).slice(2),
          "--entrypoint",
          "node",
          imageId,
          "-e",
          "const f=require('node:fs');const a=require('node:assert/strict');a.equal(require('/workspace/src/value.cjs'),7);const e=JSON.parse(f.readFileSync('/evidence/assignment.json','utf8'));a.equal(e.verification.gates[0].status,'failed');for(const p of ['/workspace/src/value.cjs','/workspace/new.cjs','/evidence/assignment.json','/controls/tests/required.cjs','/workflow/skills/SKILL.md'])a.throws(()=>f.writeFileSync(p,'forbidden'),e=>['EROFS','EACCES','EPERM'].includes(e.code));a.equal(f.existsSync('/var/run/docker.sock'),false);",
        ]);
        assert.equal(inspected.code, 0, inspected.stderr);
        state = {
          ...state,
          assignments: [onboarding, { ...assignment, qualification: inspection.qualification }],
        };
        assert.equal(
          (yield* execution
            .mutate({
              assignmentId,
              expectedEpoch: 0,
              commandId: CommandId.make("inspection-cannot-mutate"),
              operation: { kind: "write", path: "src/value.cjs", content: "forbidden" },
            })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.equal(
          (yield* execution.verify({ assignmentId, expectedEpoch: 0 }).pipe(Effect.flip)).code,
          "permission-denied",
        );
        state = {
          ...state,
          assignments: [onboarding, { ...assignment, qualification, verification }],
        };
        assert.equal(
          (yield* execution
            .rebind({ assignmentId, threadId: replacementId, expectedEpoch: 1 })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        const replacement = yield* execution.rebind({
          assignmentId,
          threadId: replacementId,
          expectedEpoch: 0,
        });
        const rebound = yield* profile(replacement.profileId);
        assert.notEqual(replacement.profileId, qualification.profileId);
        assert.notEqual(rebound.runtimePath, prepared.runtimePath);
        assert.deepEqual(rebound.assignmentWorkspace, prepared.assignmentWorkspace);
        assert.equal(rebound.boundaryId, prepared.boundaryId);
        assert.equal(rebound.workflowSnapshotPath, prepared.workflowSnapshotPath);
        assert.equal((yield* fs.readDirectory(path.join(rebound.runtimePath, "codex"))).length, 0);
        const preserved = yield* docker([
          ...factoryDockerArguments(rebound).slice(2),
          "--entrypoint",
          "node",
          imageId,
          "-e",
          "const f=require('node:fs');const a=require('node:assert/strict');a.equal(require('/workspace/src/value.cjs'),7);f.writeFileSync('/workspace/src/value.cjs','module.exports = 2;');a.throws(()=>f.writeFileSync('/controls/tests/required.cjs','bad'));",
        ]);
        assert.equal(preserved.code, 0, preserved.stderr);
        state = {
          ...state,
          assignments: [
            onboarding,
            { ...assignment, threadId: replacementId, qualification: replacement, verification },
          ],
        };
        yield* Effect.gen(function* () {
          const restarted = yield* FactoryBoundaryExecution.FactoryBoundaryExecution;
          const retry = yield* restarted.rebind({
            assignmentId,
            threadId: replacementId,
            expectedEpoch: 0,
          });
          assert.equal(retry.profileId, replacement.profileId);
          const repeatedInspection = yield* restarted.inspect(request);
          assert.equal(repeatedInspection.sourceDigest, inspection.sourceDigest);
          assert.equal(
            repeatedInspection.qualification.profileId,
            inspection.qualification.profileId,
          );
          assert.equal(
            yield* fs.readFileString(
              path.join(inspectionProfile.projectSnapshotPath, "src", "value.cjs"),
            ),
            "module.exports = 7;",
          );
          assert.equal(
            (yield* restarted.verify({ assignmentId, expectedEpoch: 0 })).gates[0]?.status,
            "passed",
          );
        }).pipe(Effect.provide(FactoryBoundaryExecution.layer));
        const saved = state;
        yield* execution.suspend({ assignmentId, generation: 1 });
        yield* execution.inspect(request).pipe(Effect.flip);
        yield* execution
          .rebind({ assignmentId, threadId: replacementId, expectedEpoch: 0 })
          .pipe(Effect.flip);
        yield* assertFactoryProfileActive(inspectionProfile).pipe(Effect.flip);
        yield* execution.resume({ assignmentId, generation: 1 });
        state = {
          ...state,
          assignments: state.assignments.map((entry) =>
            entry.id === assignmentId
              ? {
                  ...entry,
                  outcome: {
                    kind: "cancelled",
                    controlId: FactoryControlId.make("cancel-recovery"),
                  },
                }
              : entry,
          ),
        };
        assert.equal(
          (yield* execution
            .rebind({
              assignmentId,
              threadId: ThreadId.make("forbidden-replacement"),
              expectedEpoch: 0,
            })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.equal(
          (yield* execution
            .inspect({ ...request, threadId: ThreadId.make("forbidden-diagnosis") })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        state = saved;
        yield* execution.stop(assignmentId);
        yield* assertFactoryProfileActive(inspectionProfile).pipe(Effect.flip);
        yield* assertFactoryProfileActive(rebound).pipe(Effect.flip);
        yield* Effect.gen(function* () {
          const restarted = yield* FactoryBoundaryExecution.FactoryBoundaryExecution;
          yield* restarted
            .rebind({ assignmentId, threadId: replacementId, expectedEpoch: 0 })
            .pipe(Effect.flip);
        }).pipe(Effect.provide(FactoryBoundaryExecution.layer));
      }).pipe(
        Effect.provide(
          FactoryBoundaryExecution.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                ServerConfig.layerTest(root, root),
                Layer.mock(FactoryStore.FactoryStore)({ snapshot: Effect.sync(() => state) }),
                Layer.mock(FactorySource.FactorySource)({
                  readRevision: () => Effect.succeed({ files: [workflowFile], excludedPaths: [] }),
                  read: () => Effect.die("Recovery must not recapture the original repository"),
                }),
                Layer.succeed(ProcessRunner.ProcessRunner, {
                  run: (input) => {
                    if (input.args?.includes("--workdir")) gatesRun++;
                    return runner.run(input);
                  },
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  120000,
);
