import {
  FactoryBoundary,
  FactoryBoundaryId,
  FactoryError,
  FactoryVerification,
  type CommandId,
  type FactoryAssignmentGrant,
  type FactoryAssignmentId,
  type FactoryBoundaryConfiguration,
  type FactoryDiscoveryQualification,
  type FactoryFileMutation,
  type FactorySourceId,
  type ThreadId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import {
  factoryCanWrite,
  factoryPathWithin,
  factoryProtectedPath,
  factoryRelativePath,
  factoryValidConfiguration,
} from "./FactoryBoundaryPaths.ts";
import {
  factoryDockerArguments,
  FactoryExecutionProfile,
  FactoryExecutionSuspension,
} from "./FactoryExecutionProfile.ts";
import { assertFactoryProfileActive } from "./FactoryProfileAuthority.ts";
import { FactoryStore } from "./FactoryStore.ts";
import { resolveManagerPolicy } from "./FactoryPolicy.ts";
import { factoryVolumeHelper } from "./FactoryVolumeHelper.ts";
import { factoryWritableProbe } from "./FactoryWritableProbe.ts";
import { FactorySource, factoryCanonicalText } from "./FactorySource.ts";

const CapturedFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  digest: Schema.String,
  mode: Schema.optionalKey(Schema.Literals(["100644", "100755"])),
});
const CapturedSource = Schema.Struct({ files: Schema.Array(CapturedFile), digest: Schema.String });

export class FactoryBoundaryExecution extends Context.Service<
  FactoryBoundaryExecution,
  {
    readonly approve: (input: {
      readonly managerId: ThreadId;
      readonly configuration: FactoryBoundaryConfiguration;
    }) => Effect.Effect<FactoryBoundary, FactoryError>;
    readonly prepare: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly threadId: ThreadId;
      readonly boundaryId: FactoryBoundaryId;
      readonly grant: FactoryAssignmentGrant;
      readonly startingSourceId?: FactorySourceId;
    }) => Effect.Effect<FactoryDiscoveryQualification, FactoryError>;
    readonly mutate: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly expectedEpoch: number;
      readonly commandId: CommandId;
      readonly operation: FactoryFileMutation;
    }) => Effect.Effect<void, FactoryError>;
    readonly verify: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly expectedEpoch: number;
    }) => Effect.Effect<FactoryVerification, FactoryError>;
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
    readonly stop: (assignmentId: FactoryAssignmentId) => Effect.Effect<void, FactoryError>;
    readonly suspend: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly generation: number;
    }) => Effect.Effect<void, FactoryError>;
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
const decodeSuspension = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FactoryExecutionSuspension),
);
const unavailable = (detail: string) => new FactoryError({ code: "execution-unavailable", detail });
const denied = () => new FactoryError({ code: "permission-denied" });
const isFactoryError = Schema.is(FactoryError);
const preserve = (cause: unknown) =>
  isFactoryError(cause)
    ? cause
    : unavailable("The managed boundary could not complete the requested filesystem operation.");

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runner = yield* ProcessRunner;
  const config = yield* ServerConfig;
  const store = yield* FactoryStore;
  const sources = yield* FactorySource;
  const mutex = yield* Semaphore.make(1);
  const controlMutex = yield* Semaphore.make(1);
  const platform = yield* HostProcessPlatform;
  const stoppedEpochs = new Map<string, number>();
  const root = path.join(config.stateDir, "factory");
  const assertActive = (profile: FactoryExecutionProfile) =>
    assertFactoryProfileActive(profile).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

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
  const helper = Effect.fn("FactoryBoundaryExecution.helper")(function* (
    profile: FactoryExecutionProfile,
    input: unknown,
  ) {
    if (profile.assignmentWorkspace === undefined) return yield* denied();
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

  const approve = Effect.fn("FactoryBoundaryExecution.approve")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["approve"]>[0]) {
      if (input.configuration.writablePaths.length === 0)
        return yield* unavailable(
          "Select at least one existing source or feature-test file to qualify ordinary managed delivery.",
        );
      if (!factoryValidConfiguration(input.configuration))
        return yield* unavailable(
          "This boundary supports direct Node gates with an approved protected runner at its original /workspace path and explicit protected inputs. Map the source paths, creation directories, and required controls before approval.",
        );
      const state = yield* store.snapshot;
      const manager = state.managers.find(
        (entry) => entry.id === input.managerId && entry.role === "project",
      );
      const discovery = state.assignments.find(
        (entry) => entry.managerId === input.managerId && entry.kind === "onboarding",
      );
      if (!manager || !discovery || discovery.qualification.status !== "qualified")
        return yield* denied();
      const profile = yield* readProfile(discovery.qualification.profileId);
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
      const files = yield* filesAt(profile.projectSnapshotPath);
      const existing = new Set(files.map((file) => file.path));
      if (
        [...input.configuration.writablePaths, ...input.configuration.protectedPaths].some(
          (file) => !existing.has(file),
        )
      )
        return yield* unavailable(
          "Every approved source and protected input must identify an existing regular file in the discovery snapshot.",
        );
      const protectedPaths = [
        ...new Set([
          ...input.configuration.protectedPaths,
          ...files
            .filter(
              (file) =>
                factoryProtectedPath(file.path) ||
                !input.configuration.writablePaths.includes(file.path),
            )
            .map((file) => file.path),
        ]),
      ].sort();
      if (input.configuration.writablePaths.some((file) => protectedPaths.includes(file)))
        return yield* denied();
      const id = FactoryBoundaryId.make(
        yield* identity({
          profileId: discovery.qualification.profileId,
          configuration: input.configuration,
        }),
      );
      const directory = path.join(root, "boundaries", id);
      const existingBoundary = yield* fs.exists(path.join(directory, "boundary.json"));
      const boundary = existingBoundary
        ? yield* readBoundary(id)
        : FactoryBoundary.make({
            ...input.configuration,
            protectedPaths,
            id,
            projectId: discovery.projectId,
            sourceRevision,
            workflow: discovery.workflow,
            profileId: discovery.qualification.profileId,
            approvedAt: DateTime.formatIso(yield* DateTime.now),
          });
      if (!existingBoundary) {
        yield* writeFiles(path.join(directory, "source"), files);
        yield* writeFiles(
          path.join(directory, "controls"),
          files.filter((file) => protectedPaths.includes(file.path)),
        );
      }
      const proofFiles = existingBoundary ? yield* filesAt(path.join(directory, "source")) : files;
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
      yield* docker(proofProfile, [
        "volume",
        "create",
        proofProfile.assignmentWorkspace!.volumeName,
      ]);
      yield* Effect.gen(function* () {
        yield* helper(proofProfile, {
          kind: "initialize",
          files: proofFiles.map((file) => ({
            ...file,
            writable: boundary.writablePaths.includes(file.path),
          })),
        });
        yield* proveWorkspace(
          proofProfile,
          boundary.writablePaths[0]!,
          boundary.protectedPaths[0]!,
        );
      }).pipe(
        Effect.ensuring(
          docker(proofProfile, ["volume", "rm", proofProfile.assignmentWorkspace!.volumeName]).pipe(
            Effect.ignore,
          ),
        ),
      );
      yield* fs.writeFileString(path.join(directory, "boundary.json"), json(boundary));
      return boundary;
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );

  const current = Effect.fn("FactoryBoundaryExecution.current")(function* (
    assignmentId: FactoryAssignmentId,
    expectedEpoch?: number,
    resuming = false,
  ) {
    const state = yield* store.snapshot;
    const assignment = state.assignments.find((entry) => entry.id === assignmentId);
    if (
      !assignment?.grant ||
      assignment.outcome !== undefined ||
      (expectedEpoch !== undefined && assignment.grant.epoch !== expectedEpoch)
    )
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
          !assignment.grantedPolicy.authorizeRuleWeakening ||
          !resolveManagerPolicy(state.defaults, manager.overrides).authorizeRuleWeakening
        )
          return yield* denied();
      }
    } else if (assignment.kind === "rule-change") return yield* denied();
    const boundary = state.boundaries.find((entry) => entry.id === assignment.grant?.boundaryId);
    if (!boundary || assignment.projectId !== boundary.projectId) return yield* denied();
    return { assignment, boundary, grant: assignment.grant };
  });
  const prepared = Effect.fn("FactoryBoundaryExecution.prepared")(function* (
    assignmentId: FactoryAssignmentId,
    expectedEpoch?: number,
  ) {
    const value = yield* current(assignmentId, expectedEpoch);
    if (value.assignment.qualification.status !== "qualified") return yield* denied();
    const profile = yield* readProfile(value.assignment.qualification.profileId);
    if (
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

  const prepare = Effect.fn("FactoryBoundaryExecution.prepare")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["prepare"]>[0]) {
      const { assignment, boundary, grant } = yield* current(input.assignmentId, input.grant.epoch);
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
        grant.controlChange?.paths.some((file) => !factoryRelativePath(file))
      )
        return yield* denied();
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
        const checkControls = (candidate: ReadonlyArray<typeof CapturedFile.Type>) => {
          const byPath = new Map(candidate.map((file) => [file.path, file]));
          return [
            ...new Set([
              ...boundary.protectedPaths,
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
              factoryCanonicalText(Buffer.from(original.content, "base64")),
            ).equals(Buffer.from(factoryCanonicalText(Buffer.from(fresh.content, "base64"))));
          });
        };
        const changed = checkControls(starting.files) ?? checkControls(starting.indexFiles);
        if (changed !== undefined)
          return yield* unavailable(
            `The starting source changes protected control ${changed}. Adopt the control change through a separately authorized rule-change task before ordinary delivery.`,
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
      const profileId = yield* identity({
        assignmentId: input.assignmentId,
        grant,
        ...(starting === undefined
          ? {}
          : { startingSourceId: starting.source.id, sourceDigest: starting.source.sourceDigest }),
      });
      const directory = path.join(root, "execution", profileId);
      if (yield* fs.exists(path.join(directory, "profile.json"))) {
        const profile = yield* readProfile(profileId);
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
        yield* current(input.assignmentId, input.grant.epoch);
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
      yield* helper(profile, { kind: "mutate", operation, commandId: receiptId, request });
      yield* fs.makeDirectory(path.dirname(receiptPath), { recursive: true });
      yield* fs.writeFileString(receiptPath, request);
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );

  const verify = Effect.fn("FactoryBoundaryExecution.verify")(
    function* (input: Parameters<FactoryBoundaryExecution["Service"]["verify"]>[0]) {
      const { profile, boundary, grant } = yield* prepared(input.assignmentId, input.expectedEpoch);
      const source = yield* helper(profile, { kind: "capture" }).pipe(
        Effect.flatMap(decodeCapture),
      );
      const artifactId = yield* crypto.randomUUIDv4;
      const directory = path.join(root, "execution", profile.boundaryId, "artifacts", artifactId);
      yield* writeFiles(path.join(directory, "source"), source.files);
      yield* writeFiles(path.join(directory, "checks"), source.files);
      yield* writeFiles(
        path.join(directory, "checks"),
        yield* filesAt(profile.assignmentWorkspace!.controlsPath),
      );
      const gates: Array<FactoryVerification["gates"][number]> = [];
      for (const gate of boundary.gates) {
        yield* current(input.assignmentId, input.expectedEpoch);
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
              `const fs=require('node:fs');const {spawn}=require('node:child_process');const stopped=()=>{try{return fs.existsSync('/authority/revoked.json')||(fs.existsSync('/authority/suspension.json')&&JSON.parse(fs.readFileSync('/authority/suspension.json','utf8')).state!=='resumed')}catch{return true}};if(stopped())process.exit(143);const child=spawn(${json(gate.executable)},${json(gate.args)},{stdio:'inherit'});const timer=setInterval(()=>{if(stopped()){child.kill('SIGKILL');process.exit(143)}},25);child.on('error',()=>{clearInterval(timer);process.exit(1)});child.on('exit',code=>{clearInterval(timer);process.exit(code??1)});`,
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
      const { grant } = yield* current(input.assignmentId, undefined, true);
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
      yield* current(input.assignmentId, grant.epoch, true);
      if (yield* fs.exists(profile.assignmentWorkspace!.revocationPath)) return yield* denied();
      yield* writeSuspension(profile, { generation: input.generation, state: "resumed" });
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
    approve,
    prepare,
    mutate,
    verify,
    exportArtifact,
    stop,
    suspend,
    resume,
  });
});

export const layer = Layer.effect(FactoryBoundaryExecution, make);
