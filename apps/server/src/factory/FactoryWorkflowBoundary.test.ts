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
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Boundary from "./FactoryBoundaryExecution.ts";
import { FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";
import * as FactorySource from "./FactorySource.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { assertFactoryProfileActive } from "./FactoryProfileAuthority.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionProfile));
it.effect(
  "qualifies a shared Markdown boundary, prepares the actual adopted workflow, and captures a stopped migration without restoring revoked permissions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fs.makeTempDirectoryScoped();
      const now = "2026-10-10T00:00:00.000Z";
      const managerId = ThreadId.make("system");
      const projectId = ProjectId.make("skills-project");
      const profileId = "a4556207-a1c8-4b22-861c-4f835a64b713";
      const workflow = { repositoryRoot: "/workflow", revision: "a".repeat(40) };
      const adopted = { ...workflow, revision: "b".repeat(40) };
      const file = Effect.fn(function* (name: string, text: string) {
        return {
          path: name,
          content: Buffer.from(text).toString("base64"),
          digest: Buffer.from(yield* crypto.digest("SHA-256", Buffer.from(text))).toString("hex"),
          mode: "100644" as const,
        };
      });
      const instructions = yield* file("skills/implementation/SKILL.md", "old instructions");
      const newInstructions = yield* file(instructions.path, "adopted instructions");
      const authoring = yield* file(
        "skills/writing-for-agents/SKILL.md",
        "Skill editing instructions",
      );
      const mechanics = yield* file(
        "skills/writing-for-agents/SKILL-MECHANICS.md",
        "Required authoring mechanics",
      );
      const skill = yield* file("example/SKILL.md", "Original skill");
      const agents = yield* file("AGENTS.md", "Protected repository rules");
      const unfinished = yield* file("notes/draft.md", "Work not selected for any PR");
      const initial = initialFactorySnapshot();
      let state: FactorySnapshot = {
        ...initial,
        managers: [
          {
            id: managerId,
            threadId: managerId,
            role: "system",
            projectId: null,
            workspaceProjectId: projectId,
            qualification: { status: "qualified", profileId, checkedAt: now },
            name: "System",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
            workflow,
            overrides: {},
            status: "active",
            threadStatus: "created",
            launchStatus: "delivered",
            wait: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
      const invocations: ProcessRunner.ProcessRunInput[] = [];
      let capturedFiles: ReadonlyArray<FactorySource.FactorySourceFile> = [];
      const sources = new Map<FactorySourceId, FactorySource.FactorySourceArtifact>();
      let volumeFiles: ReadonlyArray<FactorySource.FactorySourceFile> = [skill, agents];
      const dependencies = Layer.mergeAll(
        ServerConfig.layerTest(root, root),
        Layer.mock(FactoryStore.FactoryStore)({ snapshot: Effect.sync(() => state) }),
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: (input) =>
            Effect.sync(() => {
              invocations.push(input);
              const stdout =
                input.stdin === json({ kind: "capture" })
                  ? json({ files: volumeFiles, digest: "capture" })
                  : input.args.some((arg) => arg.includes("factory-writable-boundary-ok"))
                    ? "factory-writable-boundary-ok"
                    : "";
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
            }),
        }),
        Layer.mock(FactorySource.FactorySource)({
          readRevision: (_root, revision) =>
            Effect.succeed({
              files: [
                revision === workflow.revision ? instructions : newInstructions,
                authoring,
                mechanics,
              ],
              excludedPaths: [],
            }),
          read: (id) =>
            sources.has(id) ? Effect.succeed(sources.get(id)!) : Effect.die("Missing source"),
          captureArtifact: (input) =>
            Effect.sync(() => {
              capturedFiles = input.files;
              const prior = sources.get(input.previousSourceId)!;
              return {
                ...prior.source,
                id: FactorySourceId.make("migration-source"),
                origin: "handover" as const,
                threadId: input.threadId,
                sourceDigest: "migrated",
                fileCount: input.files.length,
              };
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const service = yield* Boundary.FactoryBoundaryExecution;
        const directory = path.join(config.stateDir, "factory", "execution", profileId);
        const profile = {
          boundaryId: profileId,
          dockerContext: "local",
          imageId: "verified-image",
          projectSnapshotPath: path.join(directory, "project"),
          workflowSnapshotPath: path.join(directory, "workflow"),
          runtimePath: path.join(directory, "sessions"),
          sourceRevision: "c".repeat(40),
        };
        for (const [base, files] of [
          [profile.projectSnapshotPath, [skill, agents]],
          [profile.workflowSnapshotPath, [instructions, authoring, mechanics]],
        ] as const)
          for (const entry of files) {
            yield* fs.makeDirectory(path.dirname(path.join(base, entry.path)), { recursive: true });
            yield* fs.writeFile(path.join(base, entry.path), Buffer.from(entry.content, "base64"));
          }
        yield* fs.writeFileString(path.join(directory, "profile.json"), json(profile));
        const boundary = yield* service.approveShared({
          managerId,
          projectId,
          workflow,
          qualification: { status: "qualified", profileId, checkedAt: now },
          configuration: {
            protectedPaths: [skill.path, agents.path],
            protectedCreatablePaths: ["new/SKILL.md"],
            writablePaths: [],
            creatableDirectories: [],
            skillRoots: ["."],
            verification: "protected-integrity",
            gates: [],
          },
        });
        assert.equal(boundary.gates.length, 0);
        assert.equal(state.assignments.length, 0);
        const source: FactorySource.FactorySourceArtifact = {
          source: {
            id: FactorySourceId.make("source"),
            projectId,
            revision: profile.sourceRevision,
            sourceDigest: "initial",
            branch: "main",
            origin: "project",
            capturedAt: now,
            fileCount: 2,
            stagedPaths: [],
            unstagedPaths: [],
            untrackedPaths: [],
            deletedPaths: [],
            excludedPaths: [],
          },
          request: { requestId: CommandId.make("capture"), projectId },
          workspaceRoot: root,
          files: [skill, agents],
          indexFiles: [skill, agents],
          indexData: null,
        };
        sources.set(source.source.id, source);
        const assignment: FactoryAssignment = {
          id: FactoryAssignmentId.make("skill-work"),
          managerId,
          threadId: ThreadId.make("lead"),
          projectId,
          kind: "rule-change",
          status: "pending",
          threadStatus: "created",
          launchStatus: "pending",
          qualification: { status: "unavailable", reason: "Preparing" },
          workflow: adopted,
          authorization: { kind: "human", commandId: CommandId.make("authorized") },
          grant: {
            boundaryId: boundary.id,
            epoch: 0,
            sourcePaths: [],
            creatableDirectories: [],
            controlChange: { authorizationId: "authorized", paths: [skill.path] },
          },
          startingSource: source.source,
          grantedPolicy: initial.defaults,
          wait: null,
          report: null,
          createdAt: now,
          updatedAt: now,
        };
        state = { ...state, boundaries: [boundary], assignments: [assignment] };
        const prepared = yield* service.prepare({
          assignmentId: assignment.id,
          threadId: assignment.threadId,
          boundaryId: boundary.id,
          grant: assignment.grant!,
          startingSourceId: source.source.id,
        });
        assert.equal(prepared.status, "qualified");
        if (prepared.status !== "qualified") return;
        const assigned = yield* fs
          .readFileString(
            path.join(config.stateDir, "factory", "execution", prepared.profileId, "profile.json"),
          )
          .pipe(Effect.flatMap(decodeProfile));
        assert.equal(assigned.workflow?.version.revision, adopted.revision);
        assert.equal(
          yield* fs.readFileString(path.join(assigned.workflowSnapshotPath, instructions.path)),
          "adopted instructions",
        );
        assert.equal(assigned.requiresSkillAuthoring, true);
        state = { ...state, assignments: [{ ...assignment, qualification: prepared }] };
        const unrelated = {
          ...assignment,
          id: FactoryAssignmentId.make("unrelated"),
          threadId: ThreadId.make("unrelated-lead"),
        };
        state = { ...state, assignments: [...state.assignments, unrelated] };
        const unrelatedQualification = yield* service.prepare({
          assignmentId: unrelated.id,
          threadId: unrelated.threadId,
          boundaryId: boundary.id,
          grant: unrelated.grant!,
          startingSourceId: source.source.id,
        });
        assert.equal(unrelatedQualification.status, "qualified");
        if (unrelatedQualification.status !== "qualified") return;
        state = {
          ...state,
          assignments: state.assignments.map((entry) =>
            entry.id === unrelated.id ? { ...entry, qualification: unrelatedQualification } : entry,
          ),
        };
        const unrelatedProfile = yield* fs
          .readFileString(
            path.join(
              config.stateDir,
              "factory",
              "execution",
              unrelatedQualification.profileId,
              "profile.json",
            ),
          )
          .pipe(Effect.flatMap(decodeProfile));
        state = {
          ...state,
          incidentRestrictions: ["incident-a", "incident-b"].map((id) => ({
            id,
            managerId,
            projectId,
            assignmentIds: [assignment.id],
            activity: "execution" as const,
            reason: "Production incident",
            resumeCondition: { kind: "assignment-concluded" as const, assignmentId: assignment.id },
            phase: "active" as const,
            stop: { phase: "confirmed" as const },
            resume: null,
            createdAt: now,
            updatedAt: now,
          })),
        };
        for (const restriction of state.incidentRestrictions)
          yield* service.setIncidentHold({
            assignmentId: assignment.id,
            restrictionId: restriction.id,
            held: true,
          });
        assert.equal(
          (yield* assertFactoryProfileActive(assigned).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        state = {
          ...state,
          controls: [
            {
              kind: "project-pause",
              id: FactoryControlId.make("project-pause"),
              projectId,
              generation: 1,
              status: "active",
              stop: { status: "confirmed", stoppedAt: now },
              requestedAt: now,
              updatedAt: now,
            },
          ],
        };
        for (const owner of [assignment, unrelated])
          yield* service.suspend({ assignmentId: owner.id, generation: 1 });
        for (const owner of [assignment, unrelated])
          yield* service.resume({ assignmentId: owner.id, generation: 1 });
        state = { ...state, controls: [] };
        yield* assertFactoryProfileActive(unrelatedProfile);
        assert.equal(
          (yield* assertFactoryProfileActive(assigned).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        assert.equal(
          (yield* service
            .verify({ assignmentId: assignment.id, expectedEpoch: 0 })
            .pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        state = {
          ...state,
          incidentRestrictions: state.incidentRestrictions.map((entry) => ({
            ...entry,
            phase: "releasing" as const,
          })),
        };
        yield* service.setIncidentHold({
          assignmentId: assignment.id,
          restrictionId: "incident-a",
          held: false,
        });
        assert.equal(
          (yield* assertFactoryProfileActive(assigned).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        yield* service.setIncidentHold({
          assignmentId: assignment.id,
          restrictionId: "incident-b",
          held: false,
        });
        yield* assertFactoryProfileActive(assigned);
        state = { ...state, incidentRestrictions: [] };
        const integrity = yield* service.verify({ assignmentId: assignment.id, expectedEpoch: 0 });
        assert.deepEqual(
          integrity.gates.map((gate) => gate.id),
          ["protected-integrity"],
        );
        volumeFiles = [skill, yield* file(agents.path, "changed rules")];
        assert.equal(
          (yield* service
            .verify({ assignmentId: assignment.id, expectedEpoch: 0 })
            .pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        volumeFiles = [skill, agents, unfinished];
        state = {
          ...state,
          assignments: [
            {
              ...state.assignments[0]!,
              grant: { ...assignment.grant!, epoch: 1, controlChange: null },
            },
          ],
          workflowMigrations: [
            {
              id: "migration",
              assignmentId: assignment.id,
              releaseId: "release",
              previousVersion: adopted,
              previousEpoch: 0,
              preparedEpoch: null,
              retainedAuthorityReason: null,
              previousState: { status: "running", wait: null },
              kind: "migration",
              reason: "Adopt release",
              commandId: CommandId.make("restart"),
              createdAt: now,
              lifecycle: { phase: "stopping" },
            },
          ],
        };
        yield* service.stop(assignment.id);
        yield* service.captureMigration({
          assignmentId: assignment.id,
          migrationId: "migration",
          expectedEpoch: 0,
        });
        assert.include(
          capturedFiles.map((entry) => entry.path),
          unfinished.path,
        );
        const capture = invocations.findLast((input) => input.stdin === json({ kind: "capture" }))!;
        assert.isTrue(capture.args.some((arg) => arg.includes("target=/workspace,readonly")));
        assert.isFalse(capture.args.some((arg) => arg.includes("target=/authority")));
        assert.equal(state.assignments[0]!.grant!.epoch, 1);
        assert.isNull(state.assignments[0]!.grant!.controlChange);
        state = { ...state, workflowMigrations: [] };
        assert.equal(
          (yield* service
            .captureMigration({
              assignmentId: assignment.id,
              migrationId: "migration",
              expectedEpoch: 0,
            })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        // A new onboarding can use an adopted workflow while its manager retains an older pin.
        yield* fs.writeFileString(
          path.join(profile.projectSnapshotPath, "README.md"),
          "Project source",
        );
        yield* fs.writeFileString(
          path.join(profile.projectSnapshotPath, "check.cjs"),
          "require('node:assert').ok(true)",
        );
        yield* fs.writeFileString(
          path.join(directory, "profile.json"),
          json({
            ...profile,
            workflow: assigned.workflow,
            workflowSnapshotPath: assigned.workflowSnapshotPath,
          }),
        );
        state = {
          ...state,
          managers: [{ ...state.managers[0]!, role: "project", projectId, workflow }],
          assignments: [
            {
              id: FactoryAssignmentId.make("adopted-onboarding"),
              managerId,
              threadId: ThreadId.make("adopted-onboarding-thread"),
              projectId,
              kind: "onboarding",
              status: "complete",
              threadStatus: "created",
              launchStatus: "delivered",
              qualification: { status: "qualified", profileId, checkedAt: now },
              workflow: adopted,
              grantedPolicy: initial.defaults,
              wait: null,
              report: null,
              createdAt: now,
              updatedAt: now,
            },
          ],
        };
        const approved = yield* service.approve({
          managerId,
          configuration: {
            protectedPaths: ["check.cjs"],
            writablePaths: ["README.md"],
            creatableDirectories: [],
            gates: [
              {
                id: "required",
                label: "Required gate",
                executable: "/usr/local/bin/node",
                args: ["/workspace/check.cjs"],
                cwd: ".",
                timeoutMs: 1000,
                protectedInputs: ["check.cjs"],
              },
            ],
          },
        });
        assert.deepEqual(approved.workflow, adopted);
        assert.deepEqual(state.managers[0]!.workflow, workflow);
      }).pipe(Effect.provide(Boundary.layer.pipe(Layer.provideMerge(dependencies))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
