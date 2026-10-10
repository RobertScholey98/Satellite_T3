import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactorySourceId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryAssignment,
  type FactoryStartingSource,
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
  FACTORY_CODEX_IMAGE,
  FactoryExecutionProfile,
} from "./FactoryExecutionProfile.ts";
import { assertFactoryProfileActive } from "./FactoryProfileAuthority.ts";
import { FactorySource, type FactorySourceArtifact } from "./FactorySource.ts";
import * as FactoryPublication from "./FactoryPublication.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";
import { FactoryStore } from "./FactoryStore.ts";

const live = process.env.SATELLITE_FACTORY_LIVE_TEST === "1" ? it.effect : it.effect.skip;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionProfile));

live(
  "candidate verification and review use the immutable selected publication tree",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const root = yield* fs.makeTempDirectoryScoped();
      const docker = (args: ReadonlyArray<string>) =>
        runner.run({ command: "docker", args, timeout: 30_000 });
      const dockerContext = (yield* docker(["context", "show"])).stdout.trim();
      const imageId = (yield* docker([
        "image",
        "inspect",
        FACTORY_CODEX_IMAGE,
        "--format",
        "{{.Id}}",
      ])).stdout.trim();
      const profileId = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const projectId = ProjectId.make("recovery-project");
      const managerId = ThreadId.make("recovery-manager");
      const assignmentId = FactoryAssignmentId.make(`recovery-${profileId}`);
      const leadId = ThreadId.make("original-lead");
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
      let startingArtifact: FactorySourceArtifact | undefined;
      let publicationArtifact: FactoryPublication.FactoryPublicationArtifact | undefined;
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
          ["src/unselected.cjs", "module.exports = 1;"],
          ["src/remove.cjs", "delete me"],
          ["src/data.bin", "binary\0content"],
          [
            "tests/required.cjs",
            "require('node:assert/strict').equal(require('../src/value.cjs'), 2);require('node:assert/strict').equal(require('../src/unselected.cjs'),1);",
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
            writablePaths: [
              "src/value.cjs",
              "src/unselected.cjs",
              "src/remove.cjs",
              "src/data.bin",
            ],
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
        const crypto = yield* Crypto.Crypto;
        const digest = (bytes: Uint8Array) =>
          crypto
            .digest("SHA-256", bytes)
            .pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
        const manifestDigest = (files: FactorySourceArtifact["files"]) =>
          digest(
            Buffer.from(json(files.map(({ path, digest, mode }) => ({ path, digest, mode })))),
          );
        const file = (name: string, content: string, mode: "100644" | "100755" = "100644") =>
          Effect.gen(function* () {
            const bytes = Buffer.from(content);
            return {
              path: name,
              content: bytes.toString("base64"),
              digest: yield* digest(bytes),
              mode,
            };
          });
        const startingFiles = yield* Effect.all([
          file("AGENTS.md", "Preserve protected tests"),
          file("src/data.bin", "binary\0content", "100755"),
          file("src/remove.cjs", "delete me"),
          file("src/unselected.cjs", "module.exports = 9;"),
          file("src/value.cjs", "module.exports = 1;"),
          file(
            "tests/required.cjs",
            "require('node:assert/strict').equal(require('../src/value.cjs'), 2);require('node:assert/strict').equal(require('../src/unselected.cjs'),1);",
          ),
        ]);
        const cleanUnselected = yield* file("src/unselected.cjs", "module.exports = 1;");
        const source: FactoryStartingSource = {
          id: FactorySourceId.make(yield* crypto.randomUUIDv4),
          projectId,
          revision: "b".repeat(40),
          sourceDigest: "starting-evidence",
          branch: "feature",
          origin: "handover",
          threadId: leadId,
          capturedAt: now,
          fileCount: startingFiles.length,
          stagedPaths: ["src/value.cjs"],
          unstagedPaths: ["src/unselected.cjs"],
          untrackedPaths: [],
          deletedPaths: [],
          excludedPaths: [".env"],
        };
        startingArtifact = {
          source,
          request: { requestId: CommandId.make("source"), projectId, threadId: leadId },
          workspaceRoot: "/original-project",
          files: startingFiles,
          indexFiles: startingFiles.map((entry) =>
            entry.path === cleanUnselected.path ? cleanUnselected : entry,
          ),
          indexData: "index-evidence",
        };
        const assignment: FactoryAssignment = {
          ...onboarding,
          id: assignmentId,
          startingSource: source,
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
            sourcePaths: ["src/value.cjs", "src/unselected.cjs", "src/remove.cjs", "src/data.bin"],
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
          startingSourceId: source.id,
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
          commandId: CommandId.make("selected-edit"),
          operation: { kind: "write", path: "src/value.cjs", content: "module.exports = 2;" },
        });
        yield* execution.mutate({
          assignmentId,
          expectedEpoch: 0,
          commandId: CommandId.make("delete"),
          operation: { kind: "delete", path: "src/remove.cjs" },
        });
        const binary = yield* docker([
          ...factoryDockerArguments(prepared).slice(2),
          "--entrypoint",
          "node",
          imageId,
          "-e",
          "const f=require('fs');f.writeFileSync('/workspace/src/data.bin',Buffer.from([0,255,13,10]))",
        ]);
        assert.equal(binary.code, 0, binary.stderr);
        const captureInput = {
          assignmentId,
          expectedEpoch: 0,
          commandId: CommandId.make("candidate"),
          selectedPaths: ["src/value.cjs", "src/data.bin", "src/remove.cjs"],
        };
        yield* execution
          .captureCandidate({ ...captureInput, selectedPaths: ["AGENTS.md"] })
          .pipe(Effect.flip);
        const raw = yield* execution.captureCandidate(captureInput);
        yield* execution
          .captureCandidate({ ...captureInput, selectedPaths: ["src/unselected.cjs"] })
          .pipe(Effect.flip);
        assert.equal(
          raw.files.find((entry) => entry.path === "src/data.bin")!.content,
          Buffer.from([0, 255, 13, 10]).toString("base64"),
        );
        assert.equal(raw.files.find((entry) => entry.path === "src/data.bin")!.mode, "100755");
        assert.include(raw.deletedPaths, "src/remove.cjs");
        assert.deepEqual(raw.startingSource.stagedPaths, ["src/value.cjs"]);
        assert.deepEqual(raw.startingSource.unstagedPaths, ["src/unselected.cjs"]);
        const request = { assignmentId, expectedEpoch: 0, candidateId: raw.id };
        yield* execution.verifyCandidate(request).pipe(Effect.flip);
        const exactFiles = raw.files.map((entry) =>
          entry.path === cleanUnselected.path ? cleanUnselected : entry,
        );
        publicationArtifact = {
          reservation: {
            id: "reservation",
            assignmentId,
            sourceId: source.id,
            boundaryId: boundary.id,
            epoch: 0,
            parentCommit: source.revision,
            destination: { kind: "local", repositoryPath: "/broker-owned" },
            branch: "factory/candidate",
            baseBranch: "main",
            expectedTip: null,
            author: { name: "Factory", email: "factory@example.test", timestamp: now },
            committer: { name: "Factory", email: "factory@example.test", timestamp: now },
            message: "Feature",
          },
          candidate: raw,
          prepared: {
            reservationId: "reservation",
            candidateId: raw.id,
            candidateDigest: raw.sourceDigest,
            startingIndexTreeOid: "c".repeat(40),
            startingWorkTreeOid: "d".repeat(40),
            treeOid: "e".repeat(40),
            commitOid: "f".repeat(40),
            publishedSourceDigest: yield* manifestDigest(exactFiles),
            selectedPaths: raw.selectedPaths,
          },
          publishedFiles: exactFiles,
        };
        const validPublication = publicationArtifact;
        publicationArtifact = {
          ...validPublication,
          prepared: { ...validPublication.prepared, reservationId: "different-reservation" },
        };
        yield* execution
          .finalizeCandidate({ ...request, reservationId: "reservation" })
          .pipe(Effect.flip);
        publicationArtifact = validPublication;
        const finalized = yield* execution.finalizeCandidate({
          ...request,
          reservationId: "reservation",
        });
        assert.notEqual(finalized.finalized!.sourceDigest, raw.sourceDigest);
        yield* execution.mutate({
          assignmentId,
          expectedEpoch: 0,
          commandId: CommandId.make("later-edit"),
          operation: { kind: "write", path: "src/value.cjs", content: "module.exports = 7;" },
        });
        assert.equal(
          (yield* execution.captureCandidate(captureInput)).sourceDigest,
          raw.sourceDigest,
        );
        const verification = yield* execution.verifyCandidate(request);
        assert.equal(verification.sourceDigest, finalized.finalized!.sourceDigest);
        assert.equal(verification.gates[0]!.status, "passed");
        assert.equal(
          (yield* execution.verify({ assignmentId, expectedEpoch: 0 })).gates[0]!.status,
          "failed",
        );
        const review = yield* execution.inspectCandidate({
          ...request,
          threadId: ThreadId.make("reviewer"),
        });
        const reviewProfile = yield* profile(review.qualification.profileId);
        assert.equal(reviewProfile.inspection!.candidateId, raw.id);
        const reviewed = yield* docker([
          ...factoryDockerArguments(reviewProfile).slice(2),
          "--entrypoint",
          "node",
          imageId,
          "-e",
          "const f=require('fs'),a=require('assert/strict');a.equal(require('/workspace/src/value.cjs'),2);a.equal(require('/workspace/src/unselected.cjs'),1);a.equal(f.existsSync('/workspace/src/remove.cjs'),false);a.deepEqual(f.readFileSync('/workspace/src/data.bin'),Buffer.from([0,255,13,10]));a.throws(()=>f.writeFileSync('/workspace/src/value.cjs','bad'));a.throws(()=>f.writeFileSync('/evidence/candidate.json','bad'));",
        ]);
        assert.equal(reviewed.code, 0, reviewed.stderr);
        yield* Effect.gen(function* () {
          const reopened = yield* FactoryBoundaryExecution.FactoryBoundaryExecution;
          assert.deepEqual(yield* reopened.readCandidate(raw.id), finalized);
          assert.equal(
            (yield* reopened.verifyCandidate(request)).sourceDigest,
            verification.sourceDigest,
          );
          yield* reopened
            .finalizeCandidate({ ...request, reservationId: "another-reservation" })
            .pipe(Effect.flip);
          yield* reopened.verifyCandidate({ ...request, expectedEpoch: 1 }).pipe(Effect.flip);
        }).pipe(Effect.provide(Layer.fresh(FactoryBoundaryExecution.layer)));
        state = {
          ...state,
          assignments: state.assignments.map((entry) =>
            entry.id === assignmentId
              ? {
                  ...entry,
                  delivery: {
                    revisions: [],
                    directionHeld: false,
                    readiness: [],
                    retroFindings: [],
                    flow: { holdId: "flow-one", status: "stopping" },
                  },
                }
              : entry,
          ),
        };
        const holdInput = {
          assignmentId,
          threadId: leadId,
          expectedEpoch: 0,
          holdId: "flow-one",
          held: true,
        };
        const held = yield* execution.setDeliveryHold(holdInput);
        assert.isDefined(held);
        const heldProfile = yield* profile(held!.qualification.profileId);
        yield* assertFactoryProfileActive(heldProfile);
        yield* assertFactoryProfileActive(prepared).pipe(Effect.flip);
        yield* execution.verifyCandidate(request).pipe(Effect.flip);
        yield* execution
          .mutate({
            assignmentId,
            expectedEpoch: 0,
            commandId: CommandId.make("held-write"),
            operation: { kind: "write", path: "src/value.cjs", content: "forbidden" },
          })
          .pipe(Effect.flip);
        const planning = yield* docker([
          ...factoryDockerArguments(heldProfile).slice(2),
          "--entrypoint",
          "node",
          imageId,
          "-e",
          "const f=require('fs'),a=require('assert/strict');a.equal(require('/workspace/src/value.cjs'),7);a.throws(()=>f.writeFileSync('/workspace/src/value.cjs','forbidden'));a.equal(JSON.parse(f.readFileSync('/evidence/flow.json','utf8')).holdId,'flow-one');",
        ]);
        assert.equal(planning.code, 0, planning.stderr);
        const retryHold = yield* execution.setDeliveryHold(holdInput);
        assert.equal(retryHold!.qualification.profileId, held!.qualification.profileId);
        yield* execution.suspend({ assignmentId, generation: 1 });
        yield* assertFactoryProfileActive(heldProfile).pipe(Effect.flip);
        state = {
          ...state,
          assignments: state.assignments.map((entry) =>
            entry.id === assignmentId
              ? {
                  ...entry,
                  delivery: {
                    ...entry.delivery!,
                    flow: { ...entry.delivery!.flow!, status: "releasing" },
                  },
                }
              : entry,
          ),
        };
        yield* execution
          .setDeliveryHold({ ...holdInput, holdId: "wrong", held: false })
          .pipe(Effect.flip);
        yield* execution.setDeliveryHold({ ...holdInput, held: false });
        yield* assertFactoryProfileActive(prepared).pipe(Effect.flip);
        yield* execution.resume({ assignmentId, generation: 1 });
        yield* assertFactoryProfileActive(prepared);
        yield* assertFactoryProfileActive(heldProfile).pipe(Effect.flip);
        const unchanged = yield* docker([
          ...factoryDockerArguments(prepared).slice(2),
          "--entrypoint",
          "node",
          imageId,
          "-e",
          "require('assert/strict').equal(require('/workspace/src/value.cjs'),7)",
        ]);
        assert.equal(unchanged.code, 0, unchanged.stderr);
        yield* execution.stop(assignmentId);
        yield* execution.verifyCandidate(request).pipe(Effect.flip);
        yield* assertFactoryProfileActive(reviewProfile).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          FactoryBoundaryExecution.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                ServerConfig.layerTest(root, root),
                Layer.mock(FactoryStore)({ snapshot: Effect.sync(() => state) }),
                Layer.mock(FactorySource)({
                  read: () =>
                    startingArtifact
                      ? Effect.succeed(startingArtifact)
                      : Effect.die("Source not prepared"),
                  validateCurrent: () => Effect.void,
                }),
                Layer.mock(FactoryPublication.FactoryPublication)({
                  read: () =>
                    publicationArtifact
                      ? Effect.succeed(publicationArtifact)
                      : Effect.die("Publication not prepared"),
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(ProcessRunner.layer), Effect.provide(NodeServices.layer)),
  120000,
);
