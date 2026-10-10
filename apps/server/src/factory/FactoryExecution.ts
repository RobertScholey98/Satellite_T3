import {
  FactoryError,
  type FactoryDiscoveryQualification,
  type FactoryManager,
  type FactoryWorkflowVersion,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import { factoryAuxiliaryIsCurrent } from "./FactoryAuxiliary.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { FactoryStore } from "./FactoryStore.ts";
import * as FactoryModelAdmission from "./FactoryModelAdmission.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import {
  FACTORY_CODEX_IMAGE,
  factoryDockerArguments,
  FactoryExecutionProfile,
} from "./FactoryExecutionProfile.ts";
import { factoryExecutionProbe } from "./FactoryExecutionProbe.ts";
import { assertFactoryProfileActive } from "./FactoryProfileAuthority.ts";
import { FactorySource } from "./FactorySource.ts";
import * as FactoryWorkflowExecution from "./FactoryWorkflowExecution.ts";
import { IntegrationAdmissionArtifact, integrationDigest } from "./FactoryIntegrationRuntime.ts";
import {
  factoryIntegrationAccessBlocked,
  factoryIntegrationManifestReasons,
} from "./FactoryIntegration.ts";
import { factoryGrantChangesSkills } from "./FactoryBoundaryPaths.ts";

export { FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";

class QualificationError extends Schema.TaggedError<QualificationError>()(
  "FactoryQualificationError",
  { detail: Schema.String },
) {}

export class FactoryExecution extends Context.Service<
  FactoryExecution,
  {
    readonly qualify: (input: {
      readonly projectId: ProjectId;
      readonly modelSelection: ModelSelection;
      readonly workflow: FactoryWorkflowVersion;
    }) => Effect.Effect<FactoryDiscoveryQualification>;
    readonly runtimePolicyFor: (
      threadId: ThreadId,
      pendingParentThreadId?: ThreadId,
    ) => Effect.Effect<FactoryExecutionProfile | undefined, FactoryError>;
    readonly assertSelectionFor: (
      threadId: ThreadId,
      selection: ModelSelection,
      pendingParentThreadId?: ThreadId,
    ) => Effect.Effect<void, FactoryError>;
    readonly assertDelegationFor: (
      threadId: ThreadId,
      selection: ModelSelection,
    ) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryExecution") {}

const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionProfile));
const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(FactoryExecutionProfile));
const encodePaths = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const isQualificationError = Schema.is(QualificationError);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const projects = yield* ProjectStoreV2;
  const projections = yield* ProjectionStoreV2;
  const providers = yield* ProviderInstanceRegistry;
  const store = yield* FactoryStore;
  const models = yield* FactoryModelAdmission.FactoryModelAdmission;
  const controls = yield* FactoryControlAccess.FactoryControlAccess;
  const sources = yield* FactorySource;
  const workflows = yield* FactoryWorkflowExecution.FactoryWorkflowExecution;
  const root = path.join(config.stateDir, "factory", "execution");

  const run = Effect.fn("FactoryExecution.run")(function* (
    command: string,
    args: ReadonlyArray<string>,
    detail: string,
    cwd?: string,
  ) {
    const output = yield* runner
      .run({ command, args, cwd, timeout: "30 seconds" })
      .pipe(Effect.mapError(() => new QualificationError({ detail })));
    if (output.code !== 0) return yield* new QualificationError({ detail });
    return output.stdout.trim();
  });

  const snapshot = Effect.fn("FactoryExecution.snapshot")(function* (
    repositoryRoot: string,
    revision: string,
    destination: string,
  ) {
    const source = yield* sources
      .readRevision(repositoryRoot, revision)
      .pipe(
        Effect.mapError(
          (cause) => new QualificationError({ detail: cause.detail ?? cause.message }),
        ),
      );
    yield* fs.makeDirectory(destination, { recursive: true });
    for (const file of source.files) {
      const target = path.join(destination, file.path);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFile(target, Buffer.from(file.content, "base64"), { flag: "wx" });
      yield* fs.chmod(target, file.mode === "100755" ? 0o755 : 0o644);
    }
    yield* fs.writeFileString(
      path.join(destination, "SATELLITE_DISCOVERY.md"),
      [
        `Read-only tracked-file snapshot at ${revision}.`,
        "Untracked files, credentials, and environment files are omitted. Links and unsupported entries prevent capture.",
        "Source files may contain application configuration. No host credential directories are mounted.",
        "This snapshot has no Git metadata. Report findings through the scoped Satellite tools.",
        `Omitted entries: ${encodePaths(source.excludedPaths)}`,
      ].join("\n"),
      { flag: "wx" },
    );
  }, Effect.scoped);

  const qualify = Effect.fn("FactoryExecution.qualify")(
    function* (input: Parameters<FactoryExecution["Service"]["qualify"]>[0]) {
      const instance = yield* providers.getInstance(input.modelSelection.instanceId);
      if (instance?.driverKind !== "codex" || !instance.enabled) {
        return yield* new QualificationError({
          detail: "Discovery currently requires an enabled Codex provider.",
        });
      }
      const provider = yield* instance.snapshot.getSnapshot;
      if (provider.auth?.status !== "authenticated") {
        return yield* new QualificationError({
          detail: "Sign in to the selected Codex model account before starting discovery.",
        });
      }
      const project = yield* projects.get(input.projectId);
      if (Option.isNone(project))
        return yield* new QualificationError({ detail: "The project no longer exists." });
      const dockerContext = yield* run(
        "docker",
        ["context", "show"],
        "Docker is not available on this environment.",
      );
      const endpoint = yield* run(
        "docker",
        ["context", "inspect", dockerContext, "--format", "{{.Endpoints.docker.Host}}"],
        "The Docker context could not be inspected.",
      );
      if (!/^(?:npipe:\/\/|unix:\/\/)/.test(endpoint)) {
        return yield* new QualificationError({
          detail: "Discovery requires a local Docker engine owned by this environment.",
        });
      }
      const platform = yield* run(
        "docker",
        ["--context", dockerContext, "info", "--format", "{{.OSType}}"],
        "Start the local Docker Linux engine before retrying discovery.",
      );
      if (platform !== "linux")
        return yield* new QualificationError({
          detail: "Discovery requires Docker Linux containers.",
        });
      const imageId = yield* run(
        "docker",
        [
          "--context",
          dockerContext,
          "image",
          "inspect",
          FACTORY_CODEX_IMAGE,
          "--format",
          "{{.Id}}",
        ],
        `Build the ${FACTORY_CODEX_IMAGE} discovery image on this environment before retrying.`,
      );
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
        return yield* new QualificationError({
          detail: "The discovery image identity is invalid.",
        });
      if (!/^[a-f0-9]{40,64}$/i.test(input.workflow.revision)) {
        return yield* new QualificationError({
          detail: "Select an exact committed workflow revision before starting discovery.",
        });
      }
      const projectRevision = yield* run(
        "git",
        ["rev-parse", "--verify", "HEAD^{commit}"],
        "Discovery requires a committed Git project.",
        project.value.workspaceRoot,
      );
      const workflowRevision = yield* run(
        "git",
        ["rev-parse", "--verify", "--end-of-options", `${input.workflow.revision}^{commit}`],
        "The pinned workflow revision is not available in its owned repository.",
        input.workflow.repositoryRoot,
      );
      const profileId = yield* crypto.randomUUIDv4;
      const directory = path.join(root, profileId);
      yield* fs.makeDirectory(directory, { recursive: true });
      if (
        directory.includes(",") ||
        path.relative(directory, yield* fs.realPath(directory)) !== ""
      ) {
        return yield* new QualificationError({
          detail: "The discovery storage path cannot contain links or commas.",
        });
      }
      const workflow = yield* workflows.snapshot({ version: input.workflow });
      const profile = FactoryExecutionProfile.make({
        boundaryId: profileId,
        sourceRevision: projectRevision,
        dockerContext,
        imageId,
        projectSnapshotPath: path.join(directory, "project"),
        workflowSnapshotPath: workflow.snapshotPath,
        workflow,
        runtimePath: path.join(directory, "sessions"),
      });
      yield* snapshot(project.value.workspaceRoot, projectRevision, profile.projectSnapshotPath);
      if (workflowRevision !== input.workflow.revision)
        return yield* new QualificationError({
          detail: "The workflow did not resolve to its exact approved revision.",
        });
      if (!(yield* fs.exists(path.join(profile.workflowSnapshotPath, "skills")))) {
        return yield* new QualificationError({
          detail: "The pinned workflow repository must contain a skills directory.",
        });
      }
      yield* fs.makeDirectory(path.join(profile.runtimePath, "codex"), { recursive: true });
      const proof = yield* run(
        "docker",
        [
          ...factoryDockerArguments(profile),
          "--entrypoint",
          "node",
          profile.imageId,
          "-e",
          factoryExecutionProbe,
        ],
        "The Codex discovery container failed its filesystem and credential boundary probe.",
      );
      if (proof !== "factory-boundary-ok")
        return yield* new QualificationError({
          detail: "The Codex discovery boundary probe did not complete.",
        });
      yield* fs.writeFileString(
        path.join(directory, "profile.json"),
        yield* encodeProfile(profile),
      );
      return {
        status: "qualified",
        profileId,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
      } as const;
    },
    Effect.catch((cause) =>
      Effect.succeed({
        status: "unavailable" as const,
        reason: isQualificationError(cause)
          ? cause.detail
          : "The isolated discovery environment could not be prepared. Check the environment's repository access and available disk space.",
      }),
    ),
  );

  const runtimePolicyFor = Effect.fn("FactoryExecution.runtimePolicyFor")(
    function* (threadId: ThreadId, pendingParentThreadId?: ThreadId) {
      yield* controls.assertExecution(threadId, pendingParentThreadId);
      const state = yield* store.snapshot;
      let current: ThreadId | null = threadId;
      const visited = new Set<ThreadId>();
      let systemManager: Extract<FactoryManager, { role: "system" }> | undefined;
      let assignment: (typeof state.assignments)[number] | undefined;
      let auxiliary: (typeof state.auxiliaryThreads)[number] | undefined;
      while (current !== null) {
        if (visited.has(current)) return yield* new FactoryError({ code: "execution-unavailable" });
        visited.add(current);
        const manager = state.managers.find((entry) => entry.threadId === current);
        if (manager?.role === "system") systemManager = manager;
        auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === current);
        assignment = state.assignments.find(
          (entry) =>
            entry.threadId === current ||
            entry.previousLeadThreadIds?.includes(current!) ||
            entry.id === auxiliary?.assignmentId ||
            (entry.managerId === manager?.id && entry.kind === "onboarding"),
        );
        if (assignment !== undefined || manager !== undefined) break;
        const thread: OrchestrationV2AppThread | undefined = yield* projections
          .getThread(current)
          .pipe(
            Effect.catchTags({
              ProjectionStoreThreadNotFoundError: (cause) =>
                visited.size === 1 ? Effect.succeed(undefined) : Effect.fail(cause),
            }),
          );
        if (thread === undefined) {
          if (visited.size === 1 && pendingParentThreadId !== undefined) {
            current = pendingParentThreadId;
            continue;
          }
          return undefined;
        }
        current = thread.lineage?.parentThreadId ?? null;
      }
      if (current === null) return undefined;
      if (systemManager !== undefined)
        yield* models.assertSelectionFor(threadId, systemManager.modelSelection);
      const flow = assignment?.delivery?.flow;
      const heldFlow = auxiliary === undefined && flow !== undefined && flow.status !== "released";
      if (
        heldFlow &&
        (flow.status === "stopping" || threadId !== assignment?.threadId || !flow.qualification)
      )
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail: "Implementation is held while the concrete UI flow is prepared for human review.",
        });
      const qualification =
        systemManager?.qualification ??
        auxiliary?.qualification ??
        (heldFlow ? flow.qualification : assignment?.qualification);
      if (
        qualification?.status !== "qualified" ||
        (assignment === undefined && systemManager === undefined) ||
        (auxiliary !== undefined &&
          (auxiliary.qualification === undefined ||
            !factoryAuxiliaryIsCurrent(assignment, auxiliary, state.retros)))
      )
        return yield* new FactoryError({ code: "execution-unavailable" });
      const profileId = qualification.profileId;
      if (!/^[a-f0-9-]{36}$/.test(profileId))
        return yield* new FactoryError({ code: "execution-unavailable" });
      const profile = yield* fs
        .readFileString(path.join(root, profileId, "profile.json"))
        .pipe(Effect.flatMap(decodeProfile));
      if (
        systemManager !== undefined &&
        (systemManager.threadId !== threadId ||
          profile.boundaryId !== profileId ||
          profile.assignmentWorkspace !== undefined ||
          profile.inspection !== undefined ||
          profile.retro !== undefined ||
          profile.startingSourceId !== undefined ||
          profile.projectSnapshotPath !== path.join(root, profileId, "project"))
      )
        return yield* new FactoryError({ code: "execution-unavailable" });
      if (auxiliary?.kind === "retrospective") {
        const retro = state.retros.find((entry) => entry.id === auxiliary.incidentId);
        if (
          retro === undefined ||
          profile.retro?.retroId !== retro.id ||
          profile.retro.assignmentId !== assignment?.id ||
          profile.retro.conclusionId !== retro.conclusionId ||
          profile.retro.evidenceDigest !== retro.evidenceDigest ||
          profile.assignmentWorkspace !== undefined ||
          (yield* fs.exists(profile.retro.stopPath))
        )
          return yield* new FactoryError({ code: "execution-unavailable" });
      } else if (profile.retro !== undefined) {
        return yield* new FactoryError({ code: "execution-unavailable" });
      }
      if (
        auxiliary !== undefined &&
        (auxiliary.threadId !== threadId ||
          profile.inspection === undefined ||
          profile.inspection.sourceDigest !== auxiliary.sourceDigest)
      )
        return yield* new FactoryError({ code: "execution-unavailable" });
      if (
        auxiliary === undefined &&
        profile.inspection !== undefined &&
        !(
          heldFlow &&
          profile.inspection.deliveryHoldId === flow.holdId &&
          profile.inspection.sourceDigest === flow.sourceDigest
        )
      )
        return yield* new FactoryError({ code: "execution-unavailable" });
      if (assignment?.integrationId !== undefined && auxiliary?.kind !== "retrospective") {
        const integration = state.integrations.find(
          (entry) => entry.id === assignment.integrationId,
        );
        const preparation = state.integrationPreparations.find(
          (entry) => entry.id === integration?.currentPreparationId,
        );
        const identity = profile.integration;
        const blocked = factoryIntegrationAccessBlocked(state, assignment.integrationId);
        if (
          blocked ||
          !identity ||
          integration?.assignmentId !== assignment.id ||
          identity.integrationId !== integration.id ||
          identity.preparationId !== preparation?.id ||
          preparation.lifecycle.phase !== "ready" ||
          preparation.lifecycle.profileId !== profileId ||
          preparation.lifecycle.manifest.inputDigest !== identity.inputDigest ||
          integration.hold !== null
        )
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail: blocked ?? "This integration needs a current, unheld prepared input vector.",
          });
        const artifact = yield* fs
          .readFileString(identity.manifestPath)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(IntegrationAdmissionArtifact)),
            ),
          );
        const { inputDigest, ...fields } = artifact.manifest;
        const digest = yield* integrationDigest(fields).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        );
        if (
          artifact.profileId !== profileId ||
          artifact.assignmentId !== assignment.id ||
          artifact.integrationId !== integration.id ||
          artifact.preparationId !== preparation.id ||
          digest !== inputDigest ||
          artifact.manifest.inputDigest !== identity.inputDigest ||
          factoryIntegrationManifestReasons(state, integration.id, artifact.manifest).length > 0
        )
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail: "An integration input or project grant changed. Refresh the integration.",
          });
      } else if (profile.integration !== undefined) {
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail: "This integration profile belongs to another runtime role.",
        });
      }
      yield* assertFactoryProfileActive(profile).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const boundary = state.boundaries.find((entry) => entry.id === assignment?.grant?.boundaryId);
      const sharedPurpose = assignment?.sharedWork;
      const requiresSkillAuthoring =
        (assignment?.grant !== undefined &&
          boundary !== undefined &&
          factoryGrantChangesSkills(assignment.grant, boundary)) ||
        (sharedPurpose?.kind === "implementation" &&
          state.sharedWorks.some(
            (entry) => entry.id === sharedPurpose.workId && entry.plan.changesSkills,
          ));
      const workflow = yield* workflows.resolve({
        profile,
        expectedVersion: systemManager?.workflow ?? assignment!.workflow,
        requireSkillAuthoring: requiresSkillAuthoring,
      });
      if (
        assignment?.startingSource !== undefined &&
        (profile.startingSourceId !== assignment.startingSource.id ||
          profile.startingSourceDigest !== assignment.startingSource.sourceDigest)
      )
        return yield* new FactoryError({ code: "execution-unavailable" });
      if (profile.assignmentWorkspace !== undefined) {
        const workspace = profile.assignmentWorkspace;
        if (
          workspace.assignmentId !== assignment?.id ||
          assignment?.grant === undefined ||
          workspace.grantEpoch !== assignment.grant.epoch ||
          workspace.boundaryId !== assignment.grant.boundaryId ||
          !state.boundaries.some((boundary) => boundary.id === assignment.grant?.boundaryId)
        )
          return yield* new FactoryError({ code: "execution-unavailable" });
      }
      const runtimePath = path.join(
        profile.runtimePath,
        Buffer.from(threadId).toString("base64url"),
      );
      yield* fs.makeDirectory(path.join(runtimePath, "codex"), { recursive: true });
      return {
        ...profile,
        workflow,
        workflowSnapshotPath: workflow.snapshotPath,
        requiresSkillAuthoring,
        profileId,
        boundaryId: `${profile.boundaryId}:${threadId}`,
        runtimePath,
      };
    },
    Effect.mapError(() => new FactoryError({ code: "execution-unavailable" })),
  );
  return FactoryExecution.of({
    qualify,
    runtimePolicyFor,
    assertSelectionFor: models.assertSelectionFor,
    assertDelegationFor: models.assertDelegationFor,
  });
});

export const layer = Layer.effect(FactoryExecution, make).pipe(
  Layer.provide(FactoryWorkflowExecution.layer),
  Layer.provide(FactoryModelAdmission.layer),
  Layer.provideMerge(FactoryControlAccess.layer),
);
