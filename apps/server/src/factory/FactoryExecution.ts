import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  FactoryError,
  type FactoryDiscoveryQualification,
  type FactoryWorkflowVersion,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { openZipArchive } from "../zipArchive.ts";
import { FactoryStore } from "./FactoryStore.ts";
import {
  admissibleFactorySourcePath,
  FACTORY_CODEX_IMAGE,
  factoryDockerArguments,
  FactoryExecutionProfile,
} from "./FactoryExecutionProfile.ts";
import { factoryExecutionProbe } from "./FactoryExecutionProbe.ts";

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
    ) => Effect.Effect<FactoryExecutionProfile | undefined, FactoryError>;
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
    const archivePath = `${destination}.zip`;
    yield* run(
      "git",
      ["-c", "core.hooksPath=", "archive", "--format=zip", `--output=${archivePath}`, revision],
      "The selected repository revision could not be exported for discovery.",
      repositoryRoot,
    );
    yield* Effect.addFinalizer(() => fs.remove(archivePath).pipe(Effect.ignore));
    const archive = yield* openZipArchive(
      archivePath,
      () => new QualificationError({ detail: "The discovery snapshot could not be read." }),
    );
    yield* fs.makeDirectory(destination, { recursive: true });
    let bytes = 0;
    const omitted: Array<string> = [];
    for (;;) {
      const entry = yield* archive.next;
      if (entry === null) break;
      if (entry.fileName.endsWith("/")) continue;
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (!admissibleFactorySourcePath(entry.fileName) || (type !== 0 && type !== 0o100000)) {
        omitted.push(entry.fileName);
        continue;
      }
      bytes += entry.uncompressedSize;
      if (bytes > 256 * 1024 * 1024 || entry.uncompressedSize > 16 * 1024 * 1024) {
        return yield* new QualificationError({
          detail: "Discovery snapshots are limited to 256 MB and 16 MB per file.",
        });
      }
      const target = path.resolve(destination, entry.fileName);
      if (!target.startsWith(`${destination}${path.sep}`)) {
        return yield* new QualificationError({
          detail: "The discovery snapshot contains an unsafe path.",
        });
      }
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* Effect.gen(function* () {
        const readable = yield* archive.streamEntry(entry);
        yield* NodeStream.fromReadable<Uint8Array, QualificationError>({
          evaluate: () => readable,
          onError: () =>
            new QualificationError({ detail: "A discovery snapshot file could not be read." }),
        }).pipe(Stream.run(fs.sink(target, { flag: "wx" })));
      }).pipe(Effect.scoped);
    }
    yield* fs.writeFileString(
      path.join(destination, "SATELLITE_DISCOVERY.md"),
      [
        `Read-only tracked-file snapshot at ${revision}.`,
        "Untracked files, credentials, environment files, and symlinks are omitted.",
        "Source files may contain application configuration. No host credential directories are mounted.",
        "This snapshot has no Git metadata. Report findings through the scoped Satellite tools.",
        `Omitted entries: ${encodePaths(omitted)}`,
      ].join("\n"),
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
      const profile = FactoryExecutionProfile.make({
        boundaryId: profileId,
        dockerContext,
        imageId,
        projectSnapshotPath: path.join(directory, "project"),
        workflowSnapshotPath: path.join(directory, "workflow"),
        runtimePath: path.join(directory, "sessions"),
      });
      yield* snapshot(project.value.workspaceRoot, projectRevision, profile.projectSnapshotPath);
      yield* snapshot(
        input.workflow.repositoryRoot,
        workflowRevision,
        profile.workflowSnapshotPath,
      );
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
    function* (threadId: ThreadId) {
      const state = yield* store.snapshot;
      let current: ThreadId | null = threadId;
      const visited = new Set<ThreadId>();
      let assignment: (typeof state.assignments)[number] | undefined;
      while (current !== null) {
        if (visited.has(current)) return yield* new FactoryError({ code: "execution-unavailable" });
        visited.add(current);
        const manager = state.managers.find((entry) => entry.threadId === current);
        assignment = state.assignments.find(
          (entry) => entry.threadId === current || entry.managerId === manager?.id,
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
        if (thread === undefined) return undefined;
        current = thread.lineage?.parentThreadId ?? null;
      }
      if (current === null) return undefined;
      if (assignment?.qualification.status !== "qualified")
        return yield* new FactoryError({ code: "execution-unavailable" });
      const profileId = assignment.qualification.profileId;
      if (!/^[a-f0-9-]{36}$/.test(profileId))
        return yield* new FactoryError({ code: "execution-unavailable" });
      const profile = yield* fs
        .readFileString(path.join(root, profileId, "profile.json"))
        .pipe(Effect.flatMap(decodeProfile));
      const runtimePath = path.join(
        profile.runtimePath,
        Buffer.from(threadId).toString("base64url"),
      );
      yield* fs.makeDirectory(path.join(runtimePath, "codex"), { recursive: true });
      return { ...profile, boundaryId: `${profile.boundaryId}:${threadId}`, runtimePath };
    },
    Effect.mapError(() => new FactoryError({ code: "execution-unavailable" })),
  );
  return FactoryExecution.of({ qualify, runtimePolicyFor });
});

export const layer = Layer.effect(FactoryExecution, make);
