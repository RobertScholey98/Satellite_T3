import {
  FactoryBoundary,
  FactoryBoundaryId,
  FactoryError,
  FactoryVerification,
  CommandId,
  type FactoryStartingSource,
  type FactoryAssignmentGrant,
  type FactoryAssignmentId,
  type FactoryBoundaryConfiguration,
  type FactoryDiscoveryQualification,
  type FactoryFileMutation,
  type FactorySourceId,
  type FactoryWorkflowVersion,
  type ProjectId,
  type ThreadId,
  isFactoryError,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  factoryCanWrite,
  factoryPathWithin,
  factoryProtectedPath,
  factoryRelativePath,
  factoryValidConfiguration,
  factoryGrantChangesSkills,
} from "./FactoryBoundaryPaths.ts";
import {
  factoryDockerArguments,
  FactoryExecutionProfile,
  FactoryExecutionSuspension,
  FactoryDeliveryExecutionHold,
} from "./FactoryExecutionProfile.ts";
import { assertFactoryProfileActive } from "./FactoryProfileAuthority.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { resolveManagerPolicy } from "./FactoryPolicy.ts";
import { factoryVolumeHelper } from "./FactoryVolumeHelper.ts";
import { factoryWritableProbe } from "./FactoryWritableProbe.ts";
import * as FactorySource from "./FactorySource.ts";
import { FactoryCandidateArtifact } from "./FactoryCandidate.ts";
import * as FactoryPublication from "./FactoryPublication.ts";
import * as FactoryWorkflowExecution from "./FactoryWorkflowExecution.ts";
import { factorySharedAssignmentEnabled } from "./FactoryWorkflowOwnership.ts";
import { factoryIncidentBlocked } from "./FactoryCollaboration.ts";

const CapturedFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  digest: Schema.String,
  mode: Schema.optionalKey(Schema.Literals(["100644", "100755"])),
});
const CapturedSource = Schema.Struct({ files: Schema.Array(CapturedFile), digest: Schema.String });

/**
 * Owns the Docker side of managed work: approved boundary baselines, each assignment's workspace
 * volume, file changes and checks inside it, delivery candidates, read-only snapshots for review
 * and recovery, and the authority markers that stop work. The factory service and its effect
 * reactors call it. Every assignment operation readmits the assignment against current state,
 * and a mismatch is refused, usually with `permission-denied`.
 */
export class FactoryBoundaryExecution extends Context.Service<
  FactoryBoundaryExecution,
  {
    /**
     * Writes or removes an incident marker in the assignment's authority directory and kills its
     * running containers. Release is accepted only once the incident's stop is confirmed.
     */
    readonly setIncidentHold: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly restrictionId: string;
      readonly held: boolean;
    }) => Effect.Effect<void, FactoryError>;
    /**
     * Holds or releases implementation while the human reviews a concrete UI flow. Holding
     * captures the workspace into a read-only snapshot and returns its qualification; replaying
     * the hold returns the same snapshot, and a released hold cannot be held again. Release
     * returns `undefined`.
     */
    readonly setDeliveryHold: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly threadId: ThreadId;
      readonly expectedEpoch: number;
      readonly holdId: string;
      readonly held: boolean;
    }) => Effect.Effect<
      | {
          readonly qualification: Extract<FactoryDiscoveryQualification, { status: "qualified" }>;
          readonly sourceDigest: string;
        }
      | undefined,
      FactoryError
    >;
    /**
     * Captures a stopped workspace as the starting source for the assignment's workflow
     * migration. The workspace must already be revoked, and is mounted read-only.
     */
    readonly captureMigration: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly migrationId: string;
      readonly expectedEpoch: number;
    }) => Effect.Effect<FactoryStartingSource, FactoryError>;
    /**
     * Captures the workspace as a delivery candidate for the selected paths. Keyed by the
     * command: a replay returns the stored candidate, and a replay with other paths is refused.
     */
    readonly captureCandidate: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly expectedEpoch: number;
      readonly commandId: CommandId;
      readonly selectedPaths: ReadonlyArray<string>;
    }) => Effect.Effect<FactoryCandidateArtifact, FactoryError>;
    /**
     * Reads a stored candidate, finalized when it has been, and refuses one whose files no
     * longer match its digests. Does not check that the assignment is still current.
     */
    readonly readCandidate: (
      candidateId: string,
    ) => Effect.Effect<FactoryCandidateArtifact, FactoryError>;
    /**
     * Binds a candidate to the publication tree prepared for its reservation, after checking that
     * the reservation describes exactly this candidate. Idempotent for the same reservation; any
     * other reservation is refused. Needs `FactoryPublication` in the layer.
     */
    readonly finalizeCandidate: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly expectedEpoch: number;
      readonly candidateId: string;
      readonly reservationId: string;
    }) => Effect.Effect<FactoryCandidateArtifact, FactoryError>;
    /** Runs the boundary's checks on a finalized candidate's published files, not the workspace. */
    readonly verifyCandidate: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly expectedEpoch: number;
      readonly candidateId: string;
    }) => Effect.Effect<FactoryVerification, FactoryError>;
    /**
     * Prepares a read-only snapshot of a finalized candidate's published tree for an independent
     * reviewer thread. A replay for the same thread and grant returns the same profile.
     */
    readonly inspectCandidate: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly expectedEpoch: number;
      readonly candidateId: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<
      {
        readonly qualification: Extract<FactoryDiscoveryQualification, { status: "qualified" }>;
        readonly sourceDigest: string;
      },
      FactoryError
    >;
    /**
     * Stores a project manager's boundary baseline from its discovery snapshot and proves the
     * write boundary in a throwaway volume. The same discovery profile and configuration always
     * produce the same boundary.
     */
    readonly approve: (input: {
      readonly managerId: ThreadId;
      readonly configuration: FactoryBoundaryConfiguration;
    }) => Effect.Effect<FactoryBoundary, FactoryError>;
    readonly refresh: (input: {
      readonly managerId: ThreadId;
      readonly commandId: CommandId;
    }) => Effect.Effect<FactoryBoundary, FactoryError>;
    /**
     * Like `approve`, for a system manager's shared work in a project that has no project
     * manager. Unlike `approve`, it accepts `protected-integrity` verification, which needs no
     * editable files.
     */
    readonly approveShared: (input: {
      readonly managerId: ThreadId;
      readonly projectId: ProjectId;
      readonly workflow: FactoryWorkflowVersion;
      readonly qualification: Extract<FactoryDiscoveryQualification, { status: "qualified" }>;
      readonly configuration: FactoryBoundaryConfiguration;
    }) => Effect.Effect<FactoryBoundary, FactoryError>;
    /**
     * Creates the workspace volume for the assignment's current grant, seeded from the boundary
     * baseline or the starting source, and proves the write boundary inside it. Refuses a
     * starting source that changes an adopted control. A replay for the same grant, workflow and
     * starting source reuses the stored profile.
     */
    readonly prepare: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly threadId: ThreadId;
      readonly boundaryId: FactoryBoundaryId;
      readonly grant: FactoryAssignmentGrant;
      readonly startingSourceId?: FactorySourceId;
    }) => Effect.Effect<FactoryDiscoveryQualification, FactoryError>;
    /** Prepares a read-only snapshot of the workspace for a recovery inspector thread. */
    readonly inspect: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly threadId: ThreadId;
      readonly expectedEpoch: number;
    }) => Effect.Effect<
      {
        readonly qualification: Extract<FactoryDiscoveryQualification, { status: "qualified" }>;
        readonly sourceDigest: string;
      },
      FactoryError
    >;
    /**
     * Gives a replacement lead its own profile on the same workspace during recovery. The new
     * profile shares the original's volume, receipts and artifacts, with a fresh provider home.
     */
    readonly rebind: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly threadId: ThreadId;
      readonly expectedEpoch: number;
    }) => Effect.Effect<
      Extract<FactoryDiscoveryQualification, { status: "qualified" }>,
      FactoryError
    >;
    /**
     * Applies one file operation to the workspace. Keyed by `commandId`: a replay of the same
     * request does nothing, and a different request under that id is a `command-conflict`.
     */
    readonly mutate: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly expectedEpoch: number;
      readonly commandId: CommandId;
      readonly operation: FactoryFileMutation;
    }) => Effect.Effect<void, FactoryError>;
    /**
     * Captures the workspace and runs the boundary's gates on it in offline containers, with the
     * adopted controls laid over it. A failing gate is reported in the result, not as an error.
     */
    readonly verify: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly expectedEpoch: number;
    }) => Effect.Effect<FactoryVerification, FactoryError>;
    /**
     * Returns a verification's stored source when every gate passed and the workspace still
     * matches what was verified.
     */
    readonly exportArtifact: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly artifactId: string;
    }) => Effect.Effect<
      {
        readonly sourcePath: string;
        readonly sourceDigest: string;
        readonly files: ReadonlyArray<{ readonly path: string; readonly digest: string }>;
      },
      FactoryError
    >;
    /**
     * Revokes the workspace for the assignment's current grant epoch and kills its containers.
     * Revocation is permanent; only a new grant and `prepare` give it a workspace again.
     */
    readonly stop: (assignmentId: FactoryAssignmentId) => Effect.Effect<void, FactoryError>;
    /**
     * Pauses the workspace for a project pause and kills its containers. A pause older than the
     * current one is refused, and suspending a generation that was already resumed does nothing.
     */
    readonly suspend: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly generation: number;
    }) => Effect.Effect<void, FactoryError>;
    /** Lifts the pause of the matching generation, if the workspace is still current and intact. */
    readonly resume: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly generation: number;
    }) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryBoundaryExecution") {}

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionProfile));
const decodeBoundary = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryBoundary));
const decodeCapture = Schema.decodeUnknownEffect(Schema.fromJsonString(CapturedSource));
const decodeVerification = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryVerification));
const decodeCandidate = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryCandidateArtifact));
const decodeDeliveryHold = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FactoryDeliveryExecutionHold),
);
const decodeSuspension = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FactoryExecutionSuspension),
);
const unavailable = (detail: string) => new FactoryError({ code: "execution-unavailable", detail });
const denied = () => new FactoryError({ code: "permission-denied" });
const preserve = (cause: unknown) =>
  isFactoryError(cause)
    ? cause
    : unavailable("The managed boundary could not complete the requested filesystem operation.");

const make = Effect.gen(function* () {
  const workflows = yield* FactoryWorkflowExecution.FactoryWorkflowExecution;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runner = yield* ProcessRunner.ProcessRunner;
  const config = yield* ServerConfig.ServerConfig;
  const store = yield* FactoryStore.FactoryStore;
  const sources = yield* FactorySource.FactorySource;
  const publication = yield* Effect.serviceOption(FactoryPublication.FactoryPublication);
  // `mutex` serializes workspace operations. Holds and pauses take `controlMutex` instead, so
  // they never queue behind a long check run; `drain` kills containers, then waits out the
  // operation that holds `mutex`.
  const mutex = yield* Semaphore.make(1);
  const controlMutex = yield* Semaphore.make(1);
  const platform = yield* HostProcessPlatform;
  // Highest stopped grant epoch per assignment, in memory only. It refuses work at once after a
  // stop, including for an assignment that has no workspace yet; the revocation file is the
  // durable record.
  const stoppedEpochs = new Map<string, number>();
  const root = path.join(config.stateDir, "factory");
  const assertActive = (profile: FactoryExecutionProfile) =>
    assertFactoryProfileActive(profile).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  // A UUID-shaped id derived from a value, so a replayed request finds the profile, boundary or
  // candidate it stored the first time.
  const identity = (value: unknown) =>
    crypto.digest("SHA-256", new TextEncoder().encode(stableStringify(value))).pipe(
      Effect.map((bytes) => {
        const hex = Buffer.from(bytes).toString("hex");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      }),
    );
  const readProfile = (id: string) =>
    /^[a-f0-9-]{36}$/.test(id)
      ? fs
          .readFileString(path.join(root, "execution", id, "profile.json"))
          .pipe(Effect.flatMap(decodeProfile))
      : Effect.fail(denied());
  const readBoundary = (id: string) =>
    /^[a-f0-9-]{36}$/.test(id)
      ? fs
          .readFileString(path.join(root, "boundaries", id, "boundary.json"))
          .pipe(Effect.flatMap(decodeBoundary))
      : Effect.fail(denied());
  const docker = (
    profile: FactoryExecutionProfile,
    args: ReadonlyArray<string>,
    stdin?: string,
    timeout = 30_000,
  ) =>
    runner
      .run({
        command: "docker",
        args: ["--context", profile.dockerContext, ...args],
        stdin,
        timeout,
        maxOutputBytes: 380 * 1024 * 1024,
      })
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout.trim())
            : Effect.fail(
                unavailable(
                  "The isolated Docker operation failed. Check that the approved image and local Linux engine remain available.",
                ),
              ),
        ),
      );
  /**
   * Runs the volume helper on an assignment's workspace in an offline container. Refuses
   * inspection profiles and stopped or held workspaces. The helper journals each mutation by
   * command id, so a retried mutation applies once.
   */
  const helper = Effect.fn("FactoryBoundaryExecution.helper")(function* (
    profile: FactoryExecutionProfile,
    input: unknown,
  ) {
    if (profile.assignmentWorkspace === undefined || profile.inspection !== undefined)
      return yield* denied();
    yield* assertActive(profile);
    if (
      (stoppedEpochs.get(profile.assignmentWorkspace.assignmentId) ?? -1) >=
      profile.assignmentWorkspace.grantEpoch
    )
      return yield* denied();
    const name = `satellite-factory-helper-${yield* crypto.randomUUIDv4}`;
    const journalPath = path.join(
      path.dirname(path.dirname(profile.assignmentWorkspace.revocationPath)),
      "journal",
    );
    yield* fs.makeDirectory(journalPath, { recursive: true });
    return yield* docker(
      profile,
      [
        "run",
        "--name",
        name,
        "--label",
        `satellite.factory.assignment=${profile.assignmentWorkspace.assignmentId}`,
        "--rm",
        "--interactive",
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "1g",
        "--pids-limit",
        "32",
        "--mount",
        `type=volume,source=${profile.assignmentWorkspace.volumeName},target=/workspace,volume-nocopy`,
        "--mount",
        `type=bind,source=${path.dirname(profile.assignmentWorkspace.revocationPath)},target=/authority,readonly`,
        "--mount",
        `type=bind,source=${journalPath},target=/journal`,
        "--entrypoint",
        "node",
        profile.imageId,
        "-e",
        factoryVolumeHelper,
      ],
      json(input),
    ).pipe(Effect.ensuring(docker(profile, ["rm", "--force", name]).pipe(Effect.ignore)));
  });
  /** Reads a host directory as captured files, refusing links, special files and unsafe paths. */
  const filesAt = Effect.fn("FactoryBoundaryExecution.filesAt")(function* (directory: string) {
    const files: Array<typeof CapturedFile.Type> = [];
    const pending = [""];
    let total = 0;
    while (pending.length) {
      const relative = pending.pop()!;
      for (const name of yield* fs.readDirectory(path.join(directory, relative))) {
        const file = relative ? `${relative}/${name}` : name;
        if (!factoryRelativePath(file)) return yield* denied();
        const target = path.join(directory, file);
        if (path.relative(target, yield* fs.realPath(target)) !== "") return yield* denied();
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory") pending.push(file);
        else if (stat.type === "File") {
          const bytes = yield* fs.readFile(target);
          total += bytes.length;
          if (bytes.length > 16 * 1024 * 1024 || total > 256 * 1024 * 1024)
            return yield* unavailable(
              "Managed snapshots are limited to 256 MB and 16 MB per file.",
            );
          files.push({
            path: file,
            content: Buffer.from(bytes).toString("base64"),
            digest: Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex"),
            ...(platform === "win32"
              ? {}
              : { mode: stat.mode & 0o111 ? ("100755" as const) : ("100644" as const) }),
          });
        } else return yield* denied();
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  });
  const writeFiles = Effect.fn("FactoryBoundaryExecution.writeFiles")(function* (
    directory: string,
    files: ReadonlyArray<typeof CapturedFile.Type>,
  ) {
    yield* fs.makeDirectory(directory, { recursive: true });
    for (const file of files) {
      if (!factoryRelativePath(file.path)) return yield* denied();
      const target = path.join(directory, file.path);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFile(target, Buffer.from(file.content, "base64"));
      if (file.mode !== undefined && platform !== "win32")
        yield* fs.chmod(target, file.mode === "100755" ? 0o755 : 0o644);
    }
  });

  /**
   * Proves in the real non-root worker container that `sourcePath` is writable and
   * `protectedPath` is not.
   */
  const proveWorkspace = Effect.fn("FactoryBoundaryExecution.proveWorkspace")(function* (
    profile: FactoryExecutionProfile,
    sourcePath: string,
    protectedPath: string,
  ) {
    const name = `satellite-factory-probe-${yield* crypto.randomUUIDv4}`;
    const result = yield* runner
      .run({
        command: "docker",
        args: [
          ...factoryDockerArguments(profile),
          "--name",
          name,
          "--entrypoint",
          "node",
          profile.imageId,
          "-e",
          factoryWritableProbe(sourcePath, protectedPath),
        ],
        timeout: 30_000,
      })
      .pipe(Effect.ensuring(docker(profile, ["rm", "--force", name]).pipe(Effect.ignore)));
    if (result.code !== 0 || result.stdout.trim() !== "factory-writable-boundary-ok")
      return yield* unavailable(
        "The non-root Codex worker failed its actual source-write and protected-resource boundary probe. Check the local Docker engine and approved runner image.",
      );
  });

  // Stores a baseline (source, controls, boundary record) and proves the confined write boundary
  // against it. Callers hold the operation permit.
  const establish = Effect.fn("FactoryBoundaryExecution.establish")(function* (input: {
    readonly identity: unknown;
    readonly configuration: FactoryBoundaryConfiguration;
    readonly files: ReadonlyArray<typeof CapturedFile.Type>;
    readonly profile: FactoryExecutionProfile;
    readonly projectId: ProjectId;
    readonly workflow: FactoryWorkflowVersion;
    readonly profileId: string;
    readonly sourceRevision: string;
  }) {
    const { configuration, files, profile } = input;
    const existing = new Set(files.map((file) => file.path));
    if (configuration.protectedCreatablePaths?.some((file) => existing.has(file)))
      return yield* unavailable(
        "Protected creation paths must name absent files; use an exact protected edit for existing files.",
      );
    if (
      [...configuration.writablePaths, ...configuration.protectedPaths].some(
        (file) => !existing.has(file),
      )
    )
      return yield* unavailable(
        "Every approved source and protected input must identify an existing regular file in the baseline snapshot.",
      );
    // Every baseline file not listed as writable is protected. Only configured protected files
    // and protected names become controls, which are copied out and mounted at `/controls`.
    const protectedPaths = [
      ...new Set([
        ...configuration.protectedPaths,
        ...files
          .filter(
            (file) =>
              factoryProtectedPath(file.path) || !configuration.writablePaths.includes(file.path),
          )
          .map((file) => file.path),
      ]),
    ].sort();
    const controlPaths = [
      ...new Set([
        ...configuration.protectedPaths,
        ...files.filter((file) => factoryProtectedPath(file.path)).map((file) => file.path),
      ]),
    ].sort();
    if (configuration.writablePaths.some((file) => protectedPaths.includes(file)))
      return yield* denied();
    const id = FactoryBoundaryId.make(yield* identity(input.identity));
    const directory = path.join(root, "boundaries", id);
    const existingBoundary = yield* fs.exists(path.join(directory, "boundary.json"));
    const boundary = existingBoundary
      ? yield* readBoundary(id)
      : FactoryBoundary.make({
          ...configuration,
          protectedPaths,
          controlPaths,
          id,
          projectId: input.projectId,
          sourceRevision: input.sourceRevision,
          workflow: input.workflow,
          profileId: input.profileId,
          approvedAt: DateTime.formatIso(yield* DateTime.now),
        });
    if (!existingBoundary) {
      yield* writeFiles(path.join(directory, "source"), files);
      yield* writeFiles(
        path.join(directory, "controls"),
        files.filter((file) => controlPaths.includes(file.path)),
      );
    }
    // A replay keeps the stored baseline but proves the boundary again in a throwaway volume.
    const proofFiles = existingBoundary ? yield* filesAt(path.join(directory, "source")) : files;
    const proofSource = boundary.writablePaths[0] ?? "SATELLITE_FACTORY_WRITE_PROBE.txt";
    if (boundary.protectedPaths.length === 0)
      return yield* unavailable("Boundary qualification requires an existing protected file.");
    const proofId = yield* crypto.randomUUIDv4;
    const proofDirectory = path.join(directory, "qualification", proofId);
    const proofProfile = FactoryExecutionProfile.make({
      ...profile,
      runtimePath: path.join(proofDirectory, "runtime"),
      assignmentWorkspace: {
        assignmentId: `approval-${proofId}`,
        volumeName: `satellite-factory-proof-${proofId}`,
        grantEpoch: 0,
        boundaryId: boundary.id,
        controlsPath: path.join(directory, "controls"),
        revocationPath: path.join(proofDirectory, "authority", "revoked.json"),
        workerUid: Math.max(process.getuid?.() ?? 10001, 1),
        workerGid: Math.max(process.getgid?.() ?? 10001, 1),
      },
    });
    yield* fs.makeDirectory(path.join(proofProfile.runtimePath, "codex"), { recursive: true });
    yield* fs.makeDirectory(path.dirname(proofProfile.assignmentWorkspace!.revocationPath), {
      recursive: true,
    });
    yield* docker(proofProfile, ["volume", "create", proofProfile.assignmentWorkspace!.volumeName]);
    yield* Effect.gen(function* () {
      yield* helper(proofProfile, {
        kind: "initialize",
        files: proofFiles
          .map((file) => ({
            ...file,
            writable: boundary.writablePaths.includes(file.path),
          }))
          .concat(
            boundary.writablePaths.length
              ? []
              : [{ path: proofSource, content: "Cg==", digest: "", writable: true }],
          ),
      });
      yield* proveWorkspace(proofProfile, proofSource, boundary.protectedPaths[0]!);
    }).pipe(
      Effect.ensuring(
        docker(proofProfile, ["volume", "rm", proofProfile.assignmentWorkspace!.volumeName]).pipe(
          Effect.ignore,
        ),
      ),
    );
    yield* fs.writeFileString(path.join(directory, "boundary.json"), json(boundary));
    return boundary;
  });

  // Re-derives a project manager's baseline from the project's current commit, keeping the
  // approved configuration. This is how merged rule changes and dependency updates are adopted.
  const refresh = Effect.fn("FactoryBoundaryExecution.refresh")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["refresh"]>[0]) {
      const state = yield* store.snapshot;
      const manager = state.managers.find((entry) => entry.id === input.managerId);
      const previous = state.boundaries.find((entry) => entry.id === manager?.boundaryId);
      if (manager?.role !== "project" || previous?.projectId !== manager.projectId)
        return yield* denied();
      const captured = yield* sources.capture({
        requestId: CommandId.make(`factory-boundary-refresh:${input.commandId}`),
        projectId: manager.projectId,
      });
      const { workspaceRoot } = yield* sources.read(captured.id);
      const { files } = yield* sources.readRevision(workspaceRoot, captured.revision);
      const present = new Set(files.map((file) => file.path));
      const missing = previous.gates
        .flatMap((gate) => gate.protectedInputs)
        .find((file) => !present.has(file));
      if (missing !== undefined)
        return yield* unavailable(
          `Required check input ${missing} is missing at commit ${captured.revision}. Restore it before refreshing the control baseline.`,
        );
      const configuration: FactoryBoundaryConfiguration = {
        protectedPaths: [
          ...new Set([
            ...(previous.controlPaths ?? previous.protectedPaths),
            ...(previous.protectedCreatablePaths ?? []),
          ]),
        ]
          .filter((file) => present.has(file))
          .sort(),
        writablePaths: previous.writablePaths.filter((file) => present.has(file)),
        creatableDirectories: previous.creatableDirectories,
        gates: previous.gates,
        ...(previous.protectedCreatablePaths === undefined
          ? {}
          : {
              protectedCreatablePaths: previous.protectedCreatablePaths.filter(
                (file) => !present.has(file),
              ),
            }),
        ...(previous.skillRoots === undefined ? {} : { skillRoots: previous.skillRoots }),
        ...(previous.verification === undefined ? {} : { verification: previous.verification }),
      };
      if (!factoryValidConfiguration(configuration))
        return yield* unavailable(
          `The approved editable files or checks no longer exist at commit ${captured.revision}. Restore them before refreshing the control baseline.`,
        );
      const original = yield* readProfile(previous.profileId);
      const workflow = yield* workflows.resolve({
        profile: original,
        expectedVersion: previous.workflow,
      });
      return yield* establish({
        // Keyed by the command so a replayed refresh reuses its stored baseline.
        identity: { kind: "refresh", managerId: manager.id, commandId: input.commandId },
        configuration,
        files,
        profile: { ...original, workflow, workflowSnapshotPath: workflow.snapshotPath },
        projectId: previous.projectId,
        workflow: previous.workflow,
        profileId: previous.profileId,
        sourceRevision: captured.revision,
      });
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );

  const approve = Effect.fn("FactoryBoundaryExecution.approve")(
    function* (
      input:
        | Parameters<FactoryBoundaryExecution["Service"]["approve"]>[0]
        | Parameters<FactoryBoundaryExecution["Service"]["approveShared"]>[0],
    ) {
      const shared = "projectId" in input;
      if (
        !shared &&
        (input.configuration.writablePaths.length === 0 ||
          input.configuration.verification === "protected-integrity")
      )
        return yield* unavailable(
          "Select at least one existing source or feature-test file to qualify ordinary managed delivery.",
        );
      if (!factoryValidConfiguration(input.configuration))
        return yield* unavailable(
          "This boundary supports direct Node gates with an approved protected runner at its original /workspace path and explicit protected inputs. Map the source paths, creation directories, and required controls before approval.",
        );
      const state = yield* store.snapshot;
      const manager = state.managers.find(
        (entry) => entry.id === input.managerId && entry.role === (shared ? "system" : "project"),
      );
      const discovery = shared
        ? input
        : state.assignments.find(
            (entry) => entry.managerId === input.managerId && entry.kind === "onboarding",
          );
      if (!manager || !discovery || discovery.qualification.status !== "qualified")
        return yield* denied();
      if (
        shared &&
        state.managers.some(
          (entry) => entry.role === "project" && entry.projectId === input.projectId,
        )
      )
        return yield* denied();
      const original = yield* readProfile(discovery.qualification.profileId);
      const workflow = yield* workflows.resolve({
        profile: original,
        expectedVersion: discovery.workflow,
      });
      const profile = { ...original, workflow, workflowSnapshotPath: workflow.snapshotPath };
      // A profile without `sourceRevision` still records it in its snapshot's header line.
      const sourceRevision =
        profile.sourceRevision ??
        /^Read-only tracked-file snapshot at ([a-f0-9]{40,64})\.$/i.exec(
          (yield* fs.readFileString(
            path.join(profile.projectSnapshotPath, "SATELLITE_DISCOVERY.md"),
          )).split("\n")[0] ?? "",
        )?.[1];
      if (!sourceRevision)
        return yield* unavailable(
          "The discovery snapshot does not identify its committed source revision.",
        );
      return yield* establish({
        identity: {
          profileId: discovery.qualification.profileId,
          configuration: input.configuration,
        },
        configuration: input.configuration,
        files: yield* filesAt(profile.projectSnapshotPath),
        profile,
        projectId: discovery.projectId,
        workflow: discovery.workflow,
        profileId: discovery.qualification.profileId,
        sourceRevision,
      });
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );

  /**
   * Admits an operation on the assignment's current grant from live state. Refuses an ended,
   * stopped, onboarding or unauthorized assignment, a paused project, an open incident, and a
   * workflow migration in progress. `resuming` skips the project-pause check, `preparing` admits
   * the migration being prepared, and `releasingSuspension` skips the incident check so a pause
   * can be lifted while the incident's own marker keeps holding execution.
   */
  const current = Effect.fn("FactoryBoundaryExecution.current")(function* (
    assignmentId: FactoryAssignmentId,
    expectedEpoch?: number,
    resuming = false,
    preparing = false,
    releasingSuspension = false,
  ) {
    const state = yield* store.snapshot;
    const assignment = state.assignments.find((entry) => entry.id === assignmentId);
    if (
      !assignment?.grant ||
      assignment.outcome !== undefined ||
      (assignment.completion !== undefined && assignment.completion.phase !== "collecting") ||
      (expectedEpoch !== undefined && assignment.grant.epoch !== expectedEpoch)
    )
      return yield* denied();
    const incident = factoryIncidentBlocked(state, assignmentId, "execution");
    if (incident !== undefined && !releasingSuspension) return yield* unavailable(incident);
    const migration = state.workflowMigrations.find(
      (entry) => entry.assignmentId === assignmentId && entry.lifecycle.phase !== "ready",
    );
    if (
      migration &&
      (!preparing ||
        migration.lifecycle.phase !== "preparing" ||
        assignment.grant.epoch !== migration.preparedEpoch)
    )
      return yield* denied();
    const admissionState =
      migration && preparing
        ? {
            ...state,
            workflowMigrations: state.workflowMigrations.filter(
              (entry) => entry.id !== migration.id,
            ),
          }
        : state;
    if (assignment.sharedWork && !factorySharedAssignmentEnabled(admissionState, assignment))
      return yield* denied();
    if (
      !resuming &&
      state.controls.some(
        (control) =>
          control.kind === "project-pause" &&
          control.projectId === assignment.projectId &&
          control.status === "active",
      )
    )
      return yield* unavailable(
        "This project is paused. Resume it before continuing managed work.",
      );
    if ((stoppedEpochs.get(assignmentId) ?? -1) >= assignment.grant.epoch) return yield* denied();
    if (assignment.kind === "onboarding" || assignment.authorization === undefined)
      return yield* denied();
    // A control change belongs only to a rule-change assignment, under the authorization that
    // granted it. A manager's own authorization also needs rule weakening allowed by both the
    // grant and the manager's current policy, except for shared experiments.
    const controlChange = assignment.grant.controlChange;
    if (controlChange !== null) {
      if (
        assignment.kind !== "rule-change" ||
        assignment.authorization.commandId !== controlChange.authorizationId
      )
        return yield* denied();
      if (assignment.authorization.kind === "manager") {
        const manager = state.managers.find((entry) => entry.id === assignment.managerId);
        if (
          !manager ||
          assignment.authorization.threadId !== manager.threadId ||
          (assignment.sharedWork?.kind !== "experiment" &&
            (!assignment.grantedPolicy.authorizeRuleWeakening ||
              !resolveManagerPolicy(state.defaults, manager.overrides).authorizeRuleWeakening))
        )
          return yield* denied();
      }
    } else if (assignment.kind === "rule-change") return yield* denied();
    const boundary = state.boundaries.find((entry) => entry.id === assignment.grant?.boundaryId);
    if (!boundary || assignment.projectId !== boundary.projectId) return yield* denied();
    const sharedPurpose = assignment.sharedWork;
    return {
      assignment,
      boundary,
      grant: assignment.grant,
      requiresSkillAuthoring:
        factoryGrantChangesSkills(assignment.grant, boundary) ||
        (sharedPurpose?.kind === "implementation" &&
          state.sharedWorks.some(
            (entry) => entry.id === sharedPurpose.workId && entry.plan.changesSkills,
          )),
    };
  });
  // File changes and checks wait while a concrete UI flow is held for the human's decision.
  const admitImplementation = Effect.fn("FactoryBoundaryExecution.admitImplementation")(function* (
    assignmentId: FactoryAssignmentId,
    expectedEpoch: number,
  ) {
    const { assignment } = yield* current(assignmentId, expectedEpoch);
    if (assignment.delivery?.flow !== undefined && assignment.delivery.flow.status !== "released")
      return yield* unavailable(
        "Implementation is held for the concrete UI flow decision. Wait for human approval and confirmed release before changing or verifying the assignment.",
      );
  });
  /**
   * Admits work in the assignment's prepared workspace and returns its profile with the workflow
   * resolved. `pathConfiguration` lists every file the workspace started with as writable, so
   * `factoryCanWrite` demands an exact source-path grant for any of them.
   */
  const prepared = Effect.fn("FactoryBoundaryExecution.prepared")(function* (
    assignmentId: FactoryAssignmentId,
    expectedEpoch?: number,
  ) {
    const value = yield* current(assignmentId, expectedEpoch);
    if (value.assignment.qualification.status !== "qualified") return yield* denied();
    const storedProfile = yield* readProfile(value.assignment.qualification.profileId);
    const requiresSkillAuthoring = value.requiresSkillAuthoring;
    const workflow = yield* workflows.resolve({
      profile: storedProfile,
      expectedVersion: value.assignment.workflow,
      requireSkillAuthoring: requiresSkillAuthoring,
    });
    const profile = {
      ...storedProfile,
      workflow,
      workflowSnapshotPath: workflow.snapshotPath,
      requiresSkillAuthoring,
    };
    if (
      profile.inspection !== undefined ||
      profile.assignmentWorkspace?.assignmentId !== assignmentId ||
      profile.assignmentWorkspace.grantEpoch !== value.grant.epoch ||
      profile.assignmentWorkspace.boundaryId !== value.boundary.id
    )
      return yield* denied();
    if (yield* fs.exists(profile.assignmentWorkspace.revocationPath)) return yield* denied();
    yield* assertActive(profile);
    const inventoryPath = path.join(root, "execution", profile.boundaryId, "source-paths.json");
    const existingPaths = (yield* fs.exists(inventoryPath))
      ? yield* fs
          .readFileString(inventoryPath)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String))),
            ),
          )
      : (yield* filesAt(profile.projectSnapshotPath)).map((file) => file.path);
    const pathConfiguration = {
      ...value.boundary,
      writablePaths: [...new Set([...value.boundary.writablePaths, ...existingPaths])],
    };
    return { ...value, profile, pathConfiguration };
  });

  const recoverySource = Effect.fn("FactoryBoundaryExecution.recoverySource")(function* (
    assignmentId: FactoryAssignmentId,
    expectedEpoch: number,
  ) {
    const value = yield* prepared(assignmentId, expectedEpoch);
    const { assignment, profile } = value;
    if (
      assignment.startingSource !== undefined &&
      (profile.startingSourceId !== assignment.startingSource.id ||
        profile.startingSourceDigest !== assignment.startingSource.sourceDigest)
    )
      return yield* denied();
    yield* docker(profile, ["volume", "inspect", profile.assignmentWorkspace!.volumeName]);
    return value;
  });
  const candidatePath = (candidateId: string) =>
    /^[a-f0-9-]{36}$/.test(candidateId)
      ? Effect.succeed(path.join(root, "candidates", candidateId))
      : Effect.fail(denied());
  /**
   * Checks candidate files (unique paths ignoring case, canonical base64, size limits, matching
   * digests) and returns the digest over their paths, digests and modes.
   */
  const candidateDigest = Effect.fn("FactoryBoundaryExecution.candidateDigest")(function* (
    files: FactoryCandidateArtifact["files"],
  ) {
    const names = new Set<string>();
    let total = 0;
    for (const file of files) {
      if (!factoryRelativePath(file.path) || names.has(file.path.toLowerCase()))
        return yield* denied();
      names.add(file.path.toLowerCase());
      const bytes = Buffer.from(file.content, "base64");
      total += bytes.length;
      if (
        bytes.toString("base64") !== file.content ||
        bytes.length > 16 * 1024 * 1024 ||
        total > 256 * 1024 * 1024 ||
        Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex") !== file.digest
      )
        return yield* denied();
    }
    return Buffer.from(
      yield* crypto.digest(
        "SHA-256",
        Buffer.from(
          json(files.map(({ path: name, digest, mode }) => ({ path: name, digest, mode }))),
        ),
      ),
    ).toString("hex");
  });
  const captureMigration = Effect.fn("FactoryBoundaryExecution.captureMigration")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["captureMigration"]>[0]) {
      const admitted = Effect.gen(function* () {
        const state = yield* store.snapshot;
        const migration = state.workflowMigrations.find(
          (entry) =>
            entry.id === input.migrationId &&
            entry.assignmentId === input.assignmentId &&
            entry.previousEpoch === input.expectedEpoch,
        );
        const assignment = state.assignments.find((entry) => entry.id === input.assignmentId);
        if (
          !migration ||
          (migration.lifecycle.phase !== "stopping" &&
            !(migration.lifecycle.phase === "failed" && migration.lifecycle.step === "stop")) ||
          !assignment?.grant ||
          assignment.grant.epoch < input.expectedEpoch ||
          assignment.qualification.status !== "qualified" ||
          !assignment.startingSource
        )
          return yield* denied();
        return assignment;
      });
      const assignment = yield* admitted;
      if (assignment.qualification.status !== "qualified" || !assignment.startingSource)
        return yield* denied();
      const qualification = assignment.qualification;
      const sourceId = assignment.startingSource.id;
      const recheck = Effect.gen(function* () {
        const fresh = yield* admitted;
        if (
          fresh.threadId !== assignment.threadId ||
          fresh.startingSource?.id !== sourceId ||
          fresh.qualification.status !== "qualified" ||
          fresh.qualification.profileId !== qualification.profileId
        )
          return yield* denied();
      });
      const profile = yield* readProfile(assignment.qualification.profileId);
      const workspace = profile.assignmentWorkspace;
      if (
        !workspace ||
        profile.inspection ||
        workspace.assignmentId !== input.assignmentId ||
        workspace.grantEpoch !== input.expectedEpoch ||
        workspace.boundaryId !== assignment.grant?.boundaryId ||
        !(yield* fs.exists(workspace.revocationPath))
      )
        return yield* denied();
      // Not through `helper`, which refuses a revoked workspace: this capture runs only after
      // revocation, against a read-only mount of the volume.
      const captureName = `satellite-factory-migration-${yield* crypto.randomUUIDv4}`;
      const capture = yield* docker(
        profile,
        [
          "run",
          "--name",
          captureName,
          "--rm",
          "--interactive",
          "--pull",
          "never",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--memory",
          "1g",
          "--pids-limit",
          "32",
          "--mount",
          `type=volume,source=${workspace.volumeName},target=/workspace,readonly,volume-nocopy`,
          "--entrypoint",
          "node",
          profile.imageId,
          "-e",
          factoryVolumeHelper,
        ],
        json({ kind: "capture" }),
      ).pipe(
        Effect.flatMap(decodeCapture),
        Effect.ensuring(docker(profile, ["rm", "--force", captureName]).pipe(Effect.ignore)),
      );
      const files = capture.files
        .filter((file) => file.path !== "SATELLITE_DISCOVERY.md")
        .map((file) => ({ ...file, mode: file.mode ?? ("100644" as const) }));
      yield* candidateDigest(files);
      // The migration or assignment can change while the capture runs, so admission is checked
      // again on both sides of storing the source.
      yield* recheck;
      const source = yield* sources.captureArtifact({
        requestId: CommandId.make(`factory-migration:${input.migrationId}`),
        previousSourceId: assignment.startingSource.id,
        threadId: assignment.threadId,
        files,
      });
      yield* recheck;
      return source;
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  const readCandidate = Effect.fn("FactoryBoundaryExecution.readCandidate")(function* (
    candidateId: string,
  ) {
    const directory = yield* candidatePath(candidateId);
    const manifest = path.join(
      directory,
      (yield* fs.exists(path.join(directory, "final.json"))) ? "final.json" : "capture.json",
    );
    const candidate = yield* fs.readFileString(manifest).pipe(Effect.flatMap(decodeCandidate));
    if (
      candidate.id !== candidateId ||
      (yield* candidateDigest(candidate.files)) !== candidate.sourceDigest ||
      (candidate.finalized &&
        (yield* candidateDigest(candidate.finalized.files)) !== candidate.finalized.sourceDigest)
    )
      return yield* denied();
    return candidate;
  }, Effect.mapError(preserve));
  const candidateSource = Effect.fn("FactoryBoundaryExecution.candidateSource")(function* (input: {
    assignmentId: FactoryAssignmentId;
    expectedEpoch: number;
    candidateId: string;
  }) {
    const value = yield* prepared(input.assignmentId, input.expectedEpoch);
    const candidate = yield* readCandidate(input.candidateId);
    if (
      candidate.assignmentId !== input.assignmentId ||
      candidate.projectId !== value.assignment.projectId ||
      candidate.startingSource.id !== value.assignment.startingSource?.id ||
      stableStringify(candidate.grant) !== stableStringify(value.grant) ||
      stableStringify(candidate.workflow) !== stableStringify(value.assignment.workflow)
    )
      return yield* denied();
    return { ...value, candidate };
  });
  const captureCandidate = Effect.fn("FactoryBoundaryExecution.captureCandidate")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["captureCandidate"]>[0]) {
      const { assignment, profile, grant, boundary, pathConfiguration } = yield* recoverySource(
        input.assignmentId,
        input.expectedEpoch,
      );
      if (
        !assignment.startingSource ||
        input.selectedPaths.length === 0 ||
        new Set(input.selectedPaths.map((entry) => entry.toLowerCase())).size !==
          input.selectedPaths.length ||
        input.selectedPaths.some((entry) => !factoryCanWrite(entry, grant, pathConfiguration))
      )
        return yield* denied();
      const id = yield* identity({
        kind: "candidate",
        assignmentId: assignment.id,
        commandId: input.commandId,
      });
      const directory = yield* candidatePath(id);
      if (yield* fs.exists(path.join(directory, "capture.json"))) {
        const existing = (yield* candidateSource({ ...input, candidateId: id })).candidate;
        if (stableStringify(existing.selectedPaths) !== stableStringify(input.selectedPaths))
          return yield* denied();
        return existing;
      }
      const starting = yield* sources.read(assignment.startingSource.id);
      const captured = yield* helper(profile, { kind: "capture" }).pipe(
        Effect.flatMap(decodeCapture),
      );
      const files = captured.files.map((file) => ({
        ...file,
        mode: file.mode ?? ("100644" as const),
      }));
      const sourceDigest = yield* candidateDigest(files);
      if (sourceDigest !== captured.digest) return yield* denied();
      const present = new Set(files.map((file) => file.path));
      const candidate: FactoryCandidateArtifact = {
        id,
        assignmentId: assignment.id,
        projectId: assignment.projectId,
        leadThreadId: assignment.threadId,
        startingSource: assignment.startingSource,
        workflow: assignment.workflow,
        grant,
        configuration: {
          protectedPaths: boundary.protectedPaths,
          ...(boundary.protectedCreatablePaths === undefined
            ? {}
            : { protectedCreatablePaths: boundary.protectedCreatablePaths }),
          ...(boundary.skillRoots === undefined ? {} : { skillRoots: boundary.skillRoots }),
          ...(boundary.verification === undefined ? {} : { verification: boundary.verification }),
          writablePaths: boundary.writablePaths,
          creatableDirectories: boundary.creatableDirectories,
          gates: boundary.gates,
        },
        files,
        sourceDigest,
        deletedPaths: [
          ...new Set([...starting.files.map((file) => file.path), ...starting.source.deletedPaths]),
        ].filter((name) => !present.has(name)),
        selectedPaths: [...input.selectedPaths],
        startingFiles: starting.files,
        startingIndexFiles: starting.indexFiles,
        capturedAt: DateTime.formatIso(yield* DateTime.now),
      };
      if (
        candidate.selectedPaths.some(
          (name) => !present.has(name) && !candidate.deletedPaths.includes(name),
        )
      )
        return yield* denied();
      // Readmit after the capture, since a stop or hold can land while it runs. `capture.json`
      // appears atomically and marks the candidate as stored.
      yield* current(input.assignmentId, input.expectedEpoch);
      yield* assertActive(profile);
      yield* fs.makeDirectory(directory, { recursive: true });
      const temporary = path.join(directory, `capture.${yield* crypto.randomUUIDv4}.json`);
      yield* fs.writeFileString(temporary, json(candidate), { flag: "wx" });
      yield* fs.rename(temporary, path.join(directory, "capture.json"));
      return candidate;
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  const finalizeCandidate = Effect.fn("FactoryBoundaryExecution.finalizeCandidate")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["finalizeCandidate"]>[0]) {
      const { candidate, profile } = yield* candidateSource(input);
      if (candidate.finalized) {
        if (candidate.finalized.reservationId !== input.reservationId) return yield* denied();
        return candidate;
      }
      if (Option.isNone(publication))
        return yield* unavailable(
          "The private publication service is required before a candidate can be reviewed or verified.",
        );
      const artifact = yield* publication.value
        .read(input.reservationId)
        .pipe(Effect.mapError(preserve));
      const { reservation, prepared: publicationPrepared } = artifact;
      if (
        reservation.id !== input.reservationId ||
        reservation.assignmentId !== candidate.assignmentId ||
        reservation.sourceId !== candidate.startingSource.id ||
        reservation.boundaryId !== candidate.grant.boundaryId ||
        reservation.epoch !== candidate.grant.epoch ||
        publicationPrepared.reservationId !== input.reservationId ||
        publicationPrepared.candidateId !== candidate.id ||
        publicationPrepared.candidateDigest !== candidate.sourceDigest ||
        stableStringify(publicationPrepared.selectedPaths) !==
          stableStringify(candidate.selectedPaths) ||
        artifact.candidate.id !== candidate.id ||
        artifact.candidate.sourceDigest !== candidate.sourceDigest ||
        stableStringify(artifact.candidate.selectedPaths) !==
          stableStringify(candidate.selectedPaths) ||
        stableStringify(artifact.candidate.files) !== stableStringify(candidate.files) ||
        stableStringify(artifact.candidate.deletedPaths) !==
          stableStringify(candidate.deletedPaths) ||
        stableStringify(artifact.candidate.grant) !== stableStringify(candidate.grant) ||
        stableStringify(artifact.candidate.configuration) !==
          stableStringify(candidate.configuration) ||
        (yield* candidateDigest(artifact.publishedFiles)) !==
          publicationPrepared.publishedSourceDigest
      )
        return yield* denied();
      const finalized: FactoryCandidateArtifact = {
        ...candidate,
        finalized: {
          reservationId: input.reservationId,
          files: artifact.publishedFiles,
          sourceDigest: publicationPrepared.publishedSourceDigest,
          treeOid: publicationPrepared.treeOid,
          commitOid: publicationPrepared.commitOid,
        },
      };
      yield* current(input.assignmentId, input.expectedEpoch);
      yield* assertActive(profile);
      const directory = yield* candidatePath(candidate.id);
      const temporary = path.join(directory, `final.${yield* crypto.randomUUIDv4}.json`);
      yield* fs.writeFileString(temporary, json(finalized), { flag: "wx" });
      yield* fs.rename(temporary, path.join(directory, "final.json"));
      return finalized;
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  // Writes `profile.json` atomically, so a replay never reads a partial profile.
  const publishProfile = Effect.fn("FactoryBoundaryExecution.publishProfile")(function* (
    directory: string,
    profile: FactoryExecutionProfile,
  ) {
    const temporary = path.join(directory, `profile.${yield* crypto.randomUUIDv4}.json`);
    yield* fs.writeFileString(temporary, json(profile), { flag: "wx" });
    yield* fs
      .rename(temporary, path.join(directory, "profile.json"))
      .pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)));
  });
  const inspect = Effect.fn("FactoryBoundaryExecution.inspect")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["inspect"]>[0]) {
      const {
        assignment,
        grant,
        profile: original,
      } = yield* recoverySource(input.assignmentId, input.expectedEpoch);
      const profileId = yield* identity({
        kind: "inspection",
        assignmentId: assignment.id,
        threadId: input.threadId,
        grant,
      });
      const directory = path.join(root, "execution", profileId);
      let profile: FactoryExecutionProfile;
      if (yield* fs.exists(path.join(directory, "profile.json"))) {
        profile = yield* readProfile(profileId);
        if (
          profile.inspection === undefined ||
          stableStringify(profile.assignmentWorkspace) !==
            stableStringify(original.assignmentWorkspace)
        )
          return yield* denied();
        yield* assertActive(profile);
      } else {
        const source = yield* helper(original, { kind: "capture" }).pipe(
          Effect.flatMap(decodeCapture),
        );
        const projectSnapshotPath = path.join(directory, "project");
        const evidencePath = path.join(directory, "evidence");
        for (const target of [projectSnapshotPath, evidencePath])
          yield* fs.remove(target, { recursive: true, force: true });
        yield* fs.makeDirectory(evidencePath, { recursive: true });
        yield* writeFiles(projectSnapshotPath, source.files);
        yield* fs.writeFileString(
          path.join(evidencePath, "assignment.json"),
          json({
            assignmentId: assignment.id,
            leadThreadId: assignment.threadId,
            scope: assignment.scope,
            grant,
            workflow: assignment.workflow,
            modelPolicy: assignment.modelPolicy,
            modelSelection: assignment.modelSelection,
            startingSource: assignment.startingSource,
            sourceDigest: source.digest,
            verification: assignment.verification,
            oversight: assignment.oversight,
          }),
        );
        profile = FactoryExecutionProfile.make({
          ...original,
          boundaryId: profileId,
          projectSnapshotPath,
          runtimePath: path.join(directory, "sessions"),
          inspection: { sourceDigest: source.digest, evidencePath },
        });
        yield* fs.makeDirectory(path.join(profile.runtimePath, "codex"), { recursive: true });
        yield* current(input.assignmentId, input.expectedEpoch);
        yield* assertActive(original);
        yield* publishProfile(directory, profile);
      }
      return {
        qualification: {
          status: "qualified" as const,
          profileId,
          checkedAt: DateTime.formatIso(yield* DateTime.now),
        },
        sourceDigest: profile.inspection!.sourceDigest,
      };
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  const inspectCandidate = Effect.fn("FactoryBoundaryExecution.inspectCandidate")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["inspectCandidate"]>[0]) {
      const { candidate, assignment, profile: original, grant } = yield* candidateSource(input);
      if (!candidate.finalized)
        return yield* unavailable(
          "Prepare the exact publication tree before requesting independent review.",
        );
      const final = candidate.finalized;
      const profileId = yield* identity({
        kind: "candidate-inspection",
        candidateId: candidate.id,
        sourceDigest: final.sourceDigest,
        threadId: input.threadId,
        grant,
      });
      const directory = path.join(root, "execution", profileId);
      if (yield* fs.exists(path.join(directory, "profile.json"))) {
        const existing = yield* readProfile(profileId);
        if (
          existing.inspection?.candidateId !== candidate.id ||
          existing.inspection.sourceDigest !== final.sourceDigest ||
          stableStringify(existing.assignmentWorkspace) !==
            stableStringify(original.assignmentWorkspace)
        )
          return yield* denied();
        yield* assertActive(existing);
      } else {
        const projectSnapshotPath = path.join(directory, "project");
        const evidencePath = path.join(directory, "evidence");
        for (const target of [projectSnapshotPath, evidencePath])
          yield* fs.remove(target, { recursive: true, force: true });
        yield* writeFiles(projectSnapshotPath, final.files);
        yield* fs.makeDirectory(evidencePath, { recursive: true });
        yield* fs.writeFileString(
          path.join(evidencePath, "candidate.json"),
          json({
            candidateId: candidate.id,
            assignmentId: assignment.id,
            scope: assignment.scope,
            startingSource: candidate.startingSource,
            workflow: candidate.workflow,
            grant,
            selectedPaths: candidate.selectedPaths,
            deletedPaths: candidate.deletedPaths,
            sourceDigest: final.sourceDigest,
            rawSourceDigest: candidate.sourceDigest,
            treeOid: final.treeOid,
            commitOid: final.commitOid,
            files: final.files.map(({ path, digest, mode }) => ({ path, digest, mode })),
          }),
        );
        const profile = FactoryExecutionProfile.make({
          ...original,
          boundaryId: profileId,
          projectSnapshotPath,
          runtimePath: path.join(directory, "sessions"),
          inspection: { candidateId: candidate.id, sourceDigest: final.sourceDigest, evidencePath },
        });
        yield* fs.makeDirectory(path.join(profile.runtimePath, "codex"), { recursive: true });
        yield* current(input.assignmentId, input.expectedEpoch);
        yield* assertActive(original);
        yield* publishProfile(directory, profile);
      }
      return {
        qualification: {
          status: "qualified" as const,
          profileId,
          checkedAt: DateTime.formatIso(yield* DateTime.now),
        },
        sourceDigest: final.sourceDigest,
      };
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  const rebind = Effect.fn("FactoryBoundaryExecution.rebind")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["rebind"]>[0]) {
      const {
        assignment,
        grant,
        profile: original,
      } = yield* recoverySource(input.assignmentId, input.expectedEpoch);
      const profileId = yield* identity({
        kind: "replacement",
        assignmentId: assignment.id,
        threadId: input.threadId,
        grant,
      });
      const directory = path.join(root, "execution", profileId);
      if (yield* fs.exists(path.join(directory, "profile.json"))) {
        const profile = yield* readProfile(profileId);
        // A replacement keeps the original's `boundaryId`, so it shares its receipts and artifacts.
        if (
          profile.inspection !== undefined ||
          profile.boundaryId !== original.boundaryId ||
          stableStringify(profile.assignmentWorkspace) !==
            stableStringify(original.assignmentWorkspace)
        )
          return yield* denied();
        yield* assertActive(profile);
      } else {
        const profile = FactoryExecutionProfile.make({
          ...original,
          runtimePath: path.join(directory, "sessions"),
        });
        yield* fs.makeDirectory(path.join(profile.runtimePath, "codex"), { recursive: true });
        yield* current(input.assignmentId, input.expectedEpoch);
        yield* assertActive(original);
        yield* publishProfile(directory, profile);
      }
      return {
        status: "qualified" as const,
        profileId,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
      };
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );

  const prepare = Effect.fn("FactoryBoundaryExecution.prepare")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["prepare"]>[0]) {
      const { assignment, boundary, grant, requiresSkillAuthoring } = yield* current(
        input.assignmentId,
        input.grant.epoch,
        false,
        true,
      );
      if (
        assignment.threadId !== input.threadId ||
        input.boundaryId !== boundary.id ||
        stableStringify(input.grant) !== stableStringify(grant)
      )
        return yield* denied();
      if (
        grant.creatableDirectories.some(
          (directory) => !boundary.creatableDirectories.includes(directory),
        ) ||
        grant.controlChange?.paths.some(
          (file) =>
            !factoryRelativePath(file) ||
            (!boundary.protectedPaths.includes(file) &&
              !(boundary.protectedCreatablePaths ?? []).includes(file)),
        )
      )
        return yield* denied();
      // The baseline stored on disk must still be the one state approved.
      const baseline = yield* readBoundary(boundary.id);
      if (stableStringify(baseline) !== stableStringify(boundary)) return yield* denied();
      if (input.startingSourceId !== assignment.startingSource?.id) return yield* denied();
      const starting =
        input.startingSourceId === undefined
          ? undefined
          : yield* sources.read(input.startingSourceId);
      if (
        starting !== undefined &&
        (starting.source.projectId !== assignment.projectId ||
          stableStringify(starting.source) !== stableStringify(assignment.startingSource) ||
          (starting.source.origin === "handover" &&
            starting.source.threadId !== assignment.threadId))
      )
        return yield* denied();
      const baselineFiles = yield* filesAt(path.join(root, "boundaries", boundary.id, "source"));
      const baselineByPath = new Map(baselineFiles.map((file) => [file.path, file]));
      const files: Array<typeof CapturedFile.Type> =
        starting === undefined ? [...baselineFiles] : [...starting.files];
      if (starting !== undefined) {
        // A starting source, in both its worktree and its index, must leave every adopted
        // control as the baseline has it, apart from the grant's control-change paths. Line
        // endings are ignored. Discovery's metadata file may be missing; the baseline copy is
        // added back.
        const checkControls = (candidate: ReadonlyArray<typeof CapturedFile.Type>) => {
          const byPath = new Map(candidate.map((file) => [file.path, file]));
          return [
            ...new Set([
              ...(boundary.controlPaths ?? boundary.protectedPaths),
              ...candidate
                .filter((file) => factoryProtectedPath(file.path))
                .map((file) => file.path),
            ]),
          ].find((name) => {
            if (grant.controlChange?.paths.includes(name)) return false;
            const original = baselineByPath.get(name);
            const fresh = byPath.get(name);
            if (
              name === "SATELLITE_DISCOVERY.md" &&
              fresh === undefined &&
              original !== undefined &&
              /^Read-only tracked-file snapshot at [a-f0-9]{40,64}\.$/.test(
                Buffer.from(original.content, "base64").toString().split(/\r?\n/)[0] ?? "",
              )
            )
              return false;
            if (original === undefined || fresh === undefined) return true;
            return !Buffer.from(
              FactorySource.factoryCanonicalText(Buffer.from(original.content, "base64")),
            ).equals(
              Buffer.from(FactorySource.factoryCanonicalText(Buffer.from(fresh.content, "base64"))),
            );
          });
        };
        const changed = checkControls(starting.files) ?? checkControls(starting.indexFiles);
        if (changed !== undefined)
          return yield* unavailable(
            `The starting source changes protected control ${changed} from the approved control baseline. If that change is committed and intended, refresh the control baseline, then retry. Otherwise restore the file.`,
          );
        const metadata = baselineByPath.get("SATELLITE_DISCOVERY.md");
        if (metadata !== undefined && !files.some((file) => file.path === metadata.path))
          files.push(metadata);
      }
      const existingPaths = files.map((file) => file.path);
      if (
        new Set(existingPaths.map((file) => file.toLowerCase())).size !== files.length ||
        existingPaths.some((file) => !factoryRelativePath(file))
      )
        return yield* denied();
      // A granted source path is a baseline writable file, or a file absent from the baseline
      // that the starting source carries inside a creatable directory.
      if (
        grant.sourcePaths.some(
          (file) =>
            !factoryRelativePath(file) ||
            factoryProtectedPath(file) ||
            boundary.protectedPaths.includes(file) ||
            (!boundary.writablePaths.includes(file) &&
              (baselineByPath.has(file) ||
                !existingPaths.includes(file) ||
                !boundary.creatableDirectories.some((directory) =>
                  factoryPathWithin(file, directory),
                ))),
        )
      )
        return yield* denied();
      const pathConfiguration = {
        ...boundary,
        writablePaths: [...new Set([...boundary.writablePaths, ...existingPaths])],
      };
      const original = yield* readProfile(boundary.profileId);
      const workflow = yield* workflows.snapshot({
        version: assignment.workflow,
        requireSkillAuthoring: requiresSkillAuthoring,
      });
      const profileId = yield* identity({
        assignmentId: input.assignmentId,
        grant,
        workflow,
        ...(starting === undefined
          ? {}
          : { startingSourceId: starting.source.id, sourceDigest: starting.source.sourceDigest }),
      });
      const directory = path.join(root, "execution", profileId);
      if (yield* fs.exists(path.join(directory, "profile.json"))) {
        const profile = yield* readProfile(profileId);
        yield* workflows.resolve({
          profile,
          expectedVersion: assignment.workflow,
          requireSkillAuthoring: requiresSkillAuthoring,
        });
        yield* assertActive(profile);
        yield* docker(profile, ["volume", "inspect", `satellite-factory-${profileId}`]);
        return {
          status: "qualified" as const,
          profileId,
          checkedAt: DateTime.formatIso(yield* DateTime.now),
        };
      }
      const profile = FactoryExecutionProfile.make({
        ...original,
        boundaryId: profileId,
        workflow,
        workflowSnapshotPath: workflow.snapshotPath,
        requiresSkillAuthoring,
        projectSnapshotPath: path.join(directory, "project"),
        runtimePath: path.join(directory, "sessions"),
        ...(starting === undefined
          ? {}
          : {
              startingSourceId: starting.source.id,
              startingSourceDigest: starting.source.sourceDigest,
              sourceRevision: starting.source.revision,
            }),
        assignmentWorkspace: {
          assignmentId: input.assignmentId,
          volumeName: `satellite-factory-${profileId}`,
          grantEpoch: grant.epoch,
          boundaryId: boundary.id,
          controlsPath: path.join(root, "boundaries", boundary.id, "controls"),
          revocationPath: path.join(directory, "authority", "revoked.json"),
          workerUid: Math.max(process.getuid?.() ?? 10001, 1),
          workerGid: Math.max(process.getgid?.() ?? 10001, 1),
        },
      });
      yield* writeFiles(profile.projectSnapshotPath, files);
      yield* fs.writeFileString(path.join(directory, "source-paths.json"), json(existingPaths));
      yield* fs.makeDirectory(path.join(profile.runtimePath, "codex"), { recursive: true });
      yield* fs.makeDirectory(path.dirname(profile.assignmentWorkspace!.revocationPath), {
        recursive: true,
      });
      // A volume left by an interrupted attempt is discarded, so the workspace always starts
      // from these files.
      yield* docker(profile, ["volume", "rm", profile.assignmentWorkspace!.volumeName]).pipe(
        Effect.ignore,
      );
      yield* docker(profile, [
        "volume",
        "create",
        "--label",
        `satellite.factory.assignment=${input.assignmentId}`,
        profile.assignmentWorkspace!.volumeName,
      ]);
      return yield* Effect.gen(function* () {
        // The probe needs one writable path. Without a granted existing file it writes a
        // temporary file the grant could create, and deletes it after the proof.
        const existingWritable = files.find((file) =>
          factoryCanWrite(file.path, grant, pathConfiguration),
        )?.path;
        const temporaryPath =
          existingWritable === undefined
            ? ([...grant.sourcePaths, ...(grant.controlChange?.paths ?? [])].find(
                (file) =>
                  !existingPaths.includes(file) && factoryCanWrite(file, grant, pathConfiguration),
              ) ??
              (grant.creatableDirectories[0] === undefined
                ? undefined
                : `${grant.creatableDirectories[0]}/factory-runtime-probe-${yield* crypto.randomUUIDv4}.txt`))
            : undefined;
        const sourcePath = existingWritable ?? temporaryPath;
        const protectedPath = files.find(
          (file) => !factoryCanWrite(file.path, grant, pathConfiguration),
        )?.path;
        if (!sourcePath || !protectedPath)
          return yield* unavailable(
            "The boundary requires granted file access and a protected regular file for its actual runtime proof.",
          );
        yield* helper(profile, {
          kind: "initialize",
          files: [
            ...files.map((file) => ({
              ...file,
              writable: factoryCanWrite(file.path, grant, pathConfiguration),
            })),
            ...(temporaryPath === undefined
              ? []
              : [{ path: temporaryPath, content: "Cg==", writable: true }]),
          ],
        });
        yield* proveWorkspace(profile, sourcePath, protectedPath);
        if (temporaryPath !== undefined)
          yield* helper(profile, {
            kind: "mutate",
            operation: { kind: "delete", path: temporaryPath },
            commandId: yield* crypto.randomUUIDv4,
            request: `remove-runtime-probe:${temporaryPath}`,
          });
        // `profile.json` is written last; its presence is what a replay treats as prepared.
        yield* current(input.assignmentId, input.grant.epoch, false, true);
        yield* fs.writeFileString(path.join(directory, "profile.json"), json(profile));
        return {
          status: "qualified" as const,
          profileId,
          checkedAt: DateTime.formatIso(yield* DateTime.now),
        };
      }).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            yield* docker(profile, ["volume", "rm", profile.assignmentWorkspace!.volumeName]).pipe(
              Effect.ignore,
            );
          }),
        ),
      );
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );

  const mutate = Effect.fn("FactoryBoundaryExecution.mutate")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["mutate"]>[0]) {
      yield* admitImplementation(input.assignmentId, input.expectedEpoch);
      const { profile, grant, pathConfiguration } = yield* prepared(
        input.assignmentId,
        input.expectedEpoch,
      );
      const paths = [
        input.operation.path,
        ...(input.operation.kind === "rename" ? [input.operation.to] : []),
      ];
      if (paths.some((value) => !factoryCanWrite(value, grant, pathConfiguration)))
        return yield* denied();
      if (
        (input.operation.kind === "create" || input.operation.kind === "write") &&
        Buffer.byteLength(input.operation.content, "utf8") > 16 * 1024 * 1024
      )
        return yield* denied();
      const receiptId = yield* identity(input.commandId);
      const receiptPath = path.join(
        root,
        "execution",
        profile.boundaryId,
        "mutations",
        `${receiptId}.json`,
      );
      // The receipt is written after the helper applies the change. A crash in between replays
      // through the helper's own journal, which applies the change once.
      const request = stableStringify(input);
      if (yield* fs.exists(receiptPath)) {
        if ((yield* fs.readFileString(receiptPath)) !== request)
          return yield* new FactoryError({ code: "command-conflict" });
        return;
      }
      const operation =
        input.operation.kind === "create" || input.operation.kind === "write"
          ? { ...input.operation, content: Buffer.from(input.operation.content).toString("base64") }
          : input.operation;
      yield* admitImplementation(input.assignmentId, input.expectedEpoch);
      yield* helper(profile, { kind: "mutate", operation, commandId: receiptId, request });
      yield* fs.makeDirectory(path.dirname(receiptPath), { recursive: true });
      yield* fs.writeFileString(receiptPath, request);
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );

  const verify = Effect.fn("FactoryBoundaryExecution.verify")(
    function* (
      input: Parameters<FactoryBoundaryExecution["Service"]["verify"]>[0],
      candidateId?: string,
    ) {
      yield* admitImplementation(input.assignmentId, input.expectedEpoch);
      const { profile, boundary, grant } = yield* prepared(input.assignmentId, input.expectedEpoch);
      const candidate =
        candidateId === undefined
          ? undefined
          : (yield* candidateSource({ ...input, candidateId })).candidate;
      if (candidate && !candidate.finalized)
        return yield* unavailable(
          "Prepare the exact publication tree before verifying this candidate.",
        );
      const source = candidate?.finalized
        ? { files: candidate.finalized.files, digest: candidate.finalized.sourceDigest }
        : yield* helper(profile, { kind: "capture" }).pipe(Effect.flatMap(decodeCapture));
      const artifactId = yield* crypto.randomUUIDv4;
      const directory = path.join(root, "execution", profile.boundaryId, "artifacts", artifactId);
      yield* writeFiles(path.join(directory, "source"), source.files);
      yield* writeFiles(path.join(directory, "checks"), source.files);
      // Checks run the adopted controls, except the ones a rule change is authorized to edit.
      yield* writeFiles(
        path.join(directory, "checks"),
        (yield* filesAt(profile.assignmentWorkspace!.controlsPath)).filter(
          (file) => !grant.controlChange?.paths.includes(file.path),
        ),
      );
      const gates: Array<FactoryVerification["gates"][number]> = [];
      // Integrity mode compares the capture with the workspace's starting files and fails on any
      // content or mode change the grant does not allow. Line endings are ignored.
      if (boundary.verification === "protected-integrity") {
        yield* candidateDigest(
          source.files.map((file) => ({ ...file, mode: file.mode ?? ("100644" as const) })),
        );
        const baseline = yield* filesAt(profile.projectSnapshotPath);
        const original = new Map(baseline.map((file) => [file.path, file]));
        const captured = new Map(source.files.map((file) => [file.path, file]));
        const configuration = {
          ...boundary,
          writablePaths: [...new Set([...boundary.writablePaths, ...original.keys()])],
        };
        for (const name of new Set([...original.keys(), ...captured.keys()])) {
          const before = original.get(name);
          const after = captured.get(name);
          const unchanged =
            before &&
            after &&
            (before.mode === undefined || after.mode === undefined || before.mode === after.mode) &&
            Buffer.from(
              FactorySource.factoryCanonicalText(Buffer.from(before.content, "base64")),
            ).equals(
              Buffer.from(FactorySource.factoryCanonicalText(Buffer.from(after.content, "base64"))),
            );
          if (!unchanged && !factoryCanWrite(name, grant, configuration))
            return yield* unavailable(
              `Protected integrity verification rejected an ungranted change to ${name}.`,
            );
        }
        gates.push({
          id: "protected-integrity",
          status: "passed",
          exitCode: 0,
          output:
            "Verified captured file digests and preserved every path outside the exact assignment grant.",
        });
      }
      // Each gate runs offline on a read-only copy. Its wrapper polls the authority directory
      // and kills the gate when the workspace is revoked, held or paused.
      for (const gate of boundary.gates) {
        yield* admitImplementation(input.assignmentId, input.expectedEpoch);
        yield* assertActive(profile);
        const containerName = `satellite-factory-verify-${yield* crypto.randomUUIDv4}`;
        const result = yield* runner
          .run({
            command: "docker",
            args: [
              "--context",
              profile.dockerContext,
              "run",
              "--name",
              containerName,
              "--label",
              `satellite.factory.assignment=${input.assignmentId}`,
              "--rm",
              "--pull",
              "never",
              "--network",
              "none",
              "--read-only",
              "--user",
              "10001:10001",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges",
              "--pids-limit",
              "128",
              "--memory",
              "1g",
              "--tmpfs",
              "/tmp:rw,nosuid,nodev,size=256m",
              "--mount",
              `type=bind,source=${path.join(directory, "checks")},target=/workspace,readonly`,
              "--mount",
              `type=bind,source=${profile.assignmentWorkspace!.controlsPath},target=/controls,readonly`,
              "--mount",
              `type=bind,source=${path.dirname(profile.assignmentWorkspace!.revocationPath)},target=/authority,readonly`,
              "--workdir",
              gate.cwd === "." ? "/workspace" : `/workspace/${gate.cwd}`,
              "--entrypoint",
              "/usr/local/bin/node",
              profile.imageId,
              "-e",
              `const fs=require('node:fs');const {spawn}=require('node:child_process');const stopped=()=>{try{return fs.existsSync('/authority/revoked.json')||(fs.existsSync('/authority/incidents')&&fs.readdirSync('/authority/incidents').length>0)||(fs.existsSync('/authority/suspension.json')&&JSON.parse(fs.readFileSync('/authority/suspension.json','utf8')).state!=='resumed')||(fs.existsSync('/authority/delivery-hold.json')&&JSON.parse(fs.readFileSync('/authority/delivery-hold.json','utf8')).state==='held')}catch{return true}};if(stopped())process.exit(143);const child=spawn(${json(gate.executable)},${json(gate.args)},{stdio:'inherit'});const timer=setInterval(()=>{if(stopped()){child.kill('SIGKILL');process.exit(143)}},25);child.on('error',()=>{clearInterval(timer);process.exit(1)});child.on('exit',code=>{clearInterval(timer);process.exit(code??1)});`,
            ],
            timeout: gate.timeoutMs,
            maxOutputBytes: 128 * 1024,
          })
          .pipe(
            Effect.ensuring(docker(profile, ["rm", "--force", containerName]).pipe(Effect.ignore)),
          );
        gates.push({
          id: gate.id,
          status: result.code === 0 ? "passed" : "failed",
          exitCode: result.code,
          output: `${result.stdout}${result.stderr}`,
        });
      }
      yield* admitImplementation(input.assignmentId, input.expectedEpoch);
      const result = FactoryVerification.make({
        artifactId,
        boundaryId: boundary.id,
        epoch: grant.epoch,
        sourceDigest: source.digest,
        gates,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* fs.writeFileString(path.join(directory, "source.json"), json(source));
      yield* fs.writeFileString(path.join(directory, "verification.json"), json(result));
      if (candidate)
        yield* fs.writeFileString(
          path.join(directory, "candidate.json"),
          json({
            candidateId: candidate.id,
            sourceDigest: source.digest,
            treeOid: candidate.finalized!.treeOid,
            commitOid: candidate.finalized!.commitOid,
          }),
        );
      return result;
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );

  const exportArtifact = Effect.fn("FactoryBoundaryExecution.exportArtifact")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["exportArtifact"]>[0]) {
      const { profile, grant, boundary } = yield* prepared(input.assignmentId);
      if (!/^[a-f0-9-]{36}$/.test(input.artifactId)) return yield* denied();
      const directory = path.join(
        root,
        "execution",
        profile.boundaryId,
        "artifacts",
        input.artifactId,
      );
      const result = yield* fs
        .readFileString(path.join(directory, "verification.json"))
        .pipe(Effect.flatMap(decodeVerification));
      if (
        result.epoch !== grant.epoch ||
        result.boundaryId !== boundary.id ||
        result.gates.some((gate) => gate.status !== "passed")
      )
        return yield* denied();
      const currentSource = yield* helper(profile, { kind: "capture" }).pipe(
        Effect.flatMap(decodeCapture),
      );
      if (currentSource.digest !== result.sourceDigest)
        return yield* unavailable(
          "The assignment changed after verification. Run the approved checks again before exporting this artifact.",
        );
      return {
        sourcePath: path.join(directory, "source"),
        sourceDigest: result.sourceDigest,
        files: currentSource.files.map(({ path: file, digest }) => ({ path: file, digest })),
      };
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );

  const assignmentProfile = Effect.fn("FactoryBoundaryExecution.assignmentProfile")(function* (
    assignmentId: FactoryAssignmentId,
  ) {
    const assignment = (yield* store.snapshot).assignments.find(
      (entry) => entry.id === assignmentId,
    );
    if (assignment === undefined) return yield* denied();
    if (assignment.qualification.status !== "qualified") return undefined;
    const profile = yield* readProfile(assignment.qualification.profileId);
    if (profile.assignmentWorkspace === undefined) return undefined;
    if (profile.assignmentWorkspace.assignmentId !== assignmentId) return yield* denied();
    return profile;
  });
  // Removes every container labeled for the assignment: agents, helpers and gate runs.
  const killOwned = Effect.fn("FactoryBoundaryExecution.killOwned")(function* (
    profile: FactoryExecutionProfile,
    assignmentId = profile.assignmentWorkspace?.assignmentId,
  ) {
    if (assignmentId === undefined) return yield* denied();
    const containers = yield* docker(profile, [
      "ps",
      "--quiet",
      "--filter",
      `label=satellite.factory.assignment=${assignmentId}`,
    ]);
    for (const id of containers.split(/\s+/).filter(Boolean)) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) return yield* denied();
      yield* docker(profile, ["rm", "--force", id]);
    }
  });
  // Kills, waits for the running workspace operation to finish, then kills again, catching any
  // container that operation started after the first pass.
  const drain = (profile: FactoryExecutionProfile, assignmentId?: string) =>
    Effect.gen(function* () {
      yield* killOwned(profile, assignmentId);
      yield* mutex.withPermit(Effect.void);
      yield* killOwned(profile, assignmentId);
    });
  const suspensionPath = (profile: FactoryExecutionProfile) =>
    path.join(path.dirname(profile.assignmentWorkspace!.revocationPath), "suspension.json");
  const writeSuspension = Effect.fn("FactoryBoundaryExecution.writeSuspension")(function* (
    profile: FactoryExecutionProfile,
    suspension: FactoryExecutionSuspension,
  ) {
    const target = suspensionPath(profile);
    const temporary = `${target}.${yield* crypto.randomUUIDv4}`;
    yield* fs.writeFileString(temporary, json(suspension), { flag: "wx" });
    yield* fs
      .rename(temporary, target)
      .pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)));
  });
  const readSuspension = (profile: FactoryExecutionProfile) =>
    Effect.gen(function* () {
      const target = suspensionPath(profile);
      return (yield* fs.exists(target))
        ? yield* fs.readFileString(target).pipe(Effect.flatMap(decodeSuspension))
        : undefined;
    });
  const setIncidentHold = Effect.fn("FactoryBoundaryExecution.setIncidentHold")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["setIncidentHold"]>[0]) {
      const state = yield* store.snapshot;
      const restriction = state.incidentRestrictions.find(
        (entry) => entry.id === input.restrictionId,
      );
      if (
        !restriction ||
        restriction.activity !== "execution" ||
        !restriction.assignmentIds.includes(input.assignmentId) ||
        (input.held
          ? restriction.phase !== "active"
          : restriction.phase !== "releasing" || restriction.stop.phase !== "confirmed")
      )
        return yield* denied();
      const profile = yield* assignmentProfile(input.assignmentId);
      // With no workspace there is no marker to write, but containers labeled for the assignment
      // are still killed, through the Docker context of the boundary's profile.
      if (profile === undefined) {
        const assignment = state.assignments.find((entry) => entry.id === input.assignmentId);
        const boundary = state.boundaries.find(
          (entry) => entry.id === assignment?.grant?.boundaryId,
        );
        if (boundary !== undefined)
          yield* drain(yield* readProfile(boundary.profileId), input.assignmentId);
        else yield* mutex.withPermit(Effect.void);
        return;
      }
      const directory = path.join(
        path.dirname(profile.assignmentWorkspace!.revocationPath),
        "incidents",
      );
      const name = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(input.restrictionId))
        .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
      const target = path.join(directory, `${name}.json`);
      // A hold writes its marker before draining, so work that starts during the drain is
      // already refused by the marker.
      if (input.held) {
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(target, json({ restrictionId: input.restrictionId }));
        yield* drain(profile);
      } else {
        yield* drain(profile);
        if (yield* fs.exists(target)) yield* fs.remove(target);
      }
    },
    controlMutex.withPermit,
    Effect.mapError(preserve),
  );
  const suspend = Effect.fn("FactoryBoundaryExecution.suspend")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["suspend"]>[0]) {
      if (!Number.isSafeInteger(input.generation) || input.generation < 0) return yield* denied();
      const profile = yield* assignmentProfile(input.assignmentId);
      if (profile === undefined) {
        const state = yield* store.snapshot;
        const assignment = state.assignments.find((entry) => entry.id === input.assignmentId);
        const boundary = state.boundaries.find(
          (entry) => entry.id === assignment?.grant?.boundaryId,
        );
        if (boundary !== undefined)
          yield* drain(yield* readProfile(boundary.profileId), input.assignmentId);
        else yield* mutex.withPermit(Effect.void);
        return;
      }
      const previous = yield* readSuspension(profile);
      if (previous !== undefined) {
        if (previous.generation > input.generation)
          return yield* new FactoryError({
            code: "invalid-state",
            detail: "A newer pause controls this assignment.",
          });
        if (previous.generation === input.generation && previous.state === "resumed") return;
      }
      yield* writeSuspension(profile, { generation: input.generation, state: "suspended" });
      yield* drain(profile);
    },
    controlMutex.withPermit,
    Effect.mapError(preserve),
  );
  const resume = Effect.fn("FactoryBoundaryExecution.resume")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["resume"]>[0]) {
      if (!Number.isSafeInteger(input.generation) || input.generation < 0) return yield* denied();
      const profile = yield* assignmentProfile(input.assignmentId);
      if (profile === undefined) return;
      const { grant } = yield* current(input.assignmentId, undefined, true, false, true);
      if (
        profile.assignmentWorkspace!.grantEpoch !== grant.epoch ||
        profile.assignmentWorkspace!.boundaryId !== grant.boundaryId
      )
        return yield* denied();
      if (yield* fs.exists(profile.assignmentWorkspace!.revocationPath)) return yield* denied();
      const previous = yield* readSuspension(profile);
      if (previous === undefined || previous.generation !== input.generation)
        return yield* new FactoryError({
          code: "invalid-state",
          detail: "This resume request does not match the assignment's current pause.",
        });
      if (previous.state === "resumed") return;
      yield* drain(profile);
      yield* docker(profile, ["volume", "inspect", profile.assignmentWorkspace!.volumeName]);
      yield* current(input.assignmentId, grant.epoch, true, false, true);
      if (yield* fs.exists(profile.assignmentWorkspace!.revocationPath)) return yield* denied();
      yield* writeSuspension(profile, { generation: input.generation, state: "resumed" });
    },
    controlMutex.withPermit,
    Effect.mapError(preserve),
  );
  const setDeliveryHold = Effect.fn("FactoryBoundaryExecution.setDeliveryHold")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["setDeliveryHold"]>[0]) {
      const { assignment, grant } = yield* current(input.assignmentId, input.expectedEpoch, true);
      if (
        assignment.threadId !== input.threadId ||
        assignment.delivery?.flow?.holdId !== input.holdId ||
        (input.held
          ? !["stopping", "held"].includes(assignment.delivery.flow.status)
          : !["releasing", "released"].includes(assignment.delivery.flow.status))
      )
        return yield* denied();
      const original = yield* assignmentProfile(input.assignmentId);
      if (
        !original?.assignmentWorkspace ||
        original.inspection ||
        original.assignmentWorkspace.grantEpoch !== grant.epoch ||
        (yield* fs.exists(original.assignmentWorkspace.revocationPath))
      )
        return yield* denied();
      const markerPath = path.join(
        path.dirname(original.assignmentWorkspace.revocationPath),
        "delivery-hold.json",
      );
      const previous = (yield* fs.exists(markerPath))
        ? yield* fs.readFileString(markerPath).pipe(Effect.flatMap(decodeDeliveryHold))
        : undefined;
      const writeMarker = (marker: FactoryDeliveryExecutionHold) =>
        Effect.gen(function* () {
          const temporary = `${markerPath}.${yield* crypto.randomUUIDv4}`;
          yield* fs.writeFileString(temporary, json(marker), { flag: "wx" });
          yield* fs
            .rename(temporary, markerPath)
            .pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)));
        });
      if (!input.held) {
        if (!previous || previous.holdId !== input.holdId || previous.epoch !== input.expectedEpoch)
          return yield* denied();
        if (previous.state === "released") return undefined;
        yield* drain(original);
        const latest = yield* current(input.assignmentId, input.expectedEpoch, true);
        if (
          latest.assignment.threadId !== input.threadId ||
          latest.assignment.delivery?.flow?.holdId !== input.holdId ||
          !["releasing", "released"].includes(latest.assignment.delivery.flow.status)
        )
          return yield* denied();
        yield* writeMarker({ ...previous, state: "released" });
        return undefined;
      }
      if (previous?.state === "held") {
        if (previous.holdId !== input.holdId || previous.epoch !== input.expectedEpoch)
          return yield* denied();
        const profile = yield* readProfile(previous.profileId);
        yield* assertActive(profile);
        return {
          qualification: {
            status: "qualified" as const,
            profileId: previous.profileId,
            checkedAt: DateTime.formatIso(yield* DateTime.now),
          },
          sourceDigest: previous.sourceDigest,
        };
      }
      if (previous?.holdId === input.holdId) return yield* denied();
      // The snapshot is published before the marker that names it, so a replayed hold always
      // finds it. Inside the permit, containers are killed directly; `drain` would wait on itself.
      return yield* mutex.withPermit(
        Effect.gen(function* () {
          const { profile } = yield* recoverySource(input.assignmentId, input.expectedEpoch);
          const captured = yield* helper(profile, { kind: "capture" }).pipe(
            Effect.flatMap(decodeCapture),
          );
          const profileId = yield* identity({
            kind: "delivery-flow",
            assignmentId: assignment.id,
            threadId: input.threadId,
            holdId: input.holdId,
            grant,
          });
          const directory = path.join(root, "execution", profileId);
          const projectSnapshotPath = path.join(directory, "project");
          const evidencePath = path.join(directory, "evidence");
          for (const target of [projectSnapshotPath, evidencePath])
            yield* fs.remove(target, { recursive: true, force: true });
          yield* writeFiles(projectSnapshotPath, captured.files);
          yield* fs.makeDirectory(evidencePath, { recursive: true });
          yield* fs.writeFileString(
            path.join(evidencePath, "flow.json"),
            json({
              assignmentId: assignment.id,
              holdId: input.holdId,
              scope: assignment.scope,
              grant,
              workflow: assignment.workflow,
              sourceDigest: captured.digest,
            }),
          );
          const inspection = FactoryExecutionProfile.make({
            ...profile,
            boundaryId: profileId,
            projectSnapshotPath,
            runtimePath: path.join(directory, "sessions"),
            inspection: {
              sourceDigest: captured.digest,
              evidencePath,
              deliveryHoldId: input.holdId,
            },
          });
          yield* fs.makeDirectory(path.join(inspection.runtimePath, "codex"), { recursive: true });
          const latest = yield* current(input.assignmentId, input.expectedEpoch);
          if (
            latest.assignment.delivery?.flow?.holdId !== input.holdId ||
            !["stopping", "held"].includes(latest.assignment.delivery.flow.status)
          )
            return yield* denied();
          yield* assertActive(profile);
          yield* publishProfile(directory, inspection);
          yield* writeMarker({
            holdId: input.holdId,
            epoch: input.expectedEpoch,
            state: "held",
            profileId,
            sourceDigest: captured.digest,
          });
          yield* killOwned(profile);
          return {
            qualification: {
              status: "qualified" as const,
              profileId,
              checkedAt: DateTime.formatIso(yield* DateTime.now),
            },
            sourceDigest: captured.digest,
          };
        }),
      );
    },
    controlMutex.withPermit,
    Effect.mapError(preserve),
  );
  const stop = Effect.fn("FactoryBoundaryExecution.stop")(function* (
    assignmentId: FactoryAssignmentId,
  ) {
    const state = yield* store.snapshot;
    const assignment = state.assignments.find((entry) => entry.id === assignmentId);
    if (assignment === undefined) return yield* denied();
    // Takes no permit: the stop is recorded first so in-flight operations fail their next
    // admission, then `drain` waits them out.
    if (assignment.grant !== undefined)
      stoppedEpochs.set(
        assignmentId,
        Math.max(stoppedEpochs.get(assignmentId) ?? -1, assignment.grant.epoch),
      );
    const profile = yield* assignmentProfile(assignmentId);
    if (profile?.assignmentWorkspace === undefined) {
      const boundary = state.boundaries.find((entry) => entry.id === assignment.grant?.boundaryId);
      if (boundary !== undefined)
        yield* drain(yield* readProfile(boundary.profileId), assignmentId);
      else yield* mutex.withPermit(Effect.void);
      return;
    }
    yield* fs.writeFileString(
      profile.assignmentWorkspace.revocationPath,
      json({
        assignmentId,
        epoch: profile.assignmentWorkspace.grantEpoch,
        stoppedAt: DateTime.formatIso(yield* DateTime.now),
      }),
    );
    stoppedEpochs.set(
      assignmentId,
      Math.max(stoppedEpochs.get(assignmentId) ?? -1, profile.assignmentWorkspace.grantEpoch),
    );
    yield* drain(profile);
  }, Effect.mapError(preserve));
  return FactoryBoundaryExecution.of({
    setIncidentHold,
    setDeliveryHold,
    captureCandidate,
    captureMigration,
    readCandidate,
    finalizeCandidate,
    verifyCandidate: (input) => verify(input, input.candidateId),
    inspectCandidate,
    approve,
    approveShared: approve,
    refresh,
    prepare,
    inspect,
    rebind,
    mutate,
    verify,
    exportArtifact,
    stop,
    suspend,
    resume,
  });
});

export const layer = Layer.effect(FactoryBoundaryExecution, make).pipe(
  Layer.provide(FactoryWorkflowExecution.layer),
);
