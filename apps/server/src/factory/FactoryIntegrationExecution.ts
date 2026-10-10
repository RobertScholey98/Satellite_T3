import {
  FactoryError,
  FactoryIntegrationTestArtifact,
  FactoryIntegrationPatchPage,
  type FactoryDecisionCommand,
  type FactoryFileMutation,
  type FactoryIntegrationInput,
  type FactoryIntegrationManifest,
  type ProjectId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { FactoryStore } from "./FactoryStore.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
import { FactoryExecutionProfile, factoryDockerArguments } from "./FactoryExecutionProfile.ts";
import { FactoryWorkflowExecution } from "./FactoryWorkflowExecution.ts";
import { FactorySourceFile } from "./FactorySource.ts";
import {
  factoryIntegrationAccessBlocked,
  factoryIntegrationManifestReasons,
  factoryIntegrationPlanIds,
} from "./FactoryIntegration.ts";
import { factoryVolumeHelper } from "./FactoryVolumeHelper.ts";
import {
  IntegrationCapabilityArtifact,
  assertIntegrationRuntimeIdentity,
  IntegrationRuntimeArtifact,
  IntegrationPatchArtifact,
  integrationDigest as digestEffect,
  integrationId as idEffect,
  integrationError,
  integrationInventory as inventoryEffect,
  integrationReadable,
  integrationWritable,
  integrationValidateFiles as validateFilesEffect,
} from "./FactoryIntegrationRuntime.ts";

type Receipt<T extends FactoryDecisionCommand["type"]> = Omit<
  Extract<FactoryDecisionCommand, { type: T }>,
  "type" | "commandId"
>;
type Preparation = { readonly integrationId: string; readonly preparationId: string };
export class FactoryIntegrationExecution extends Context.Service<
  FactoryIntegrationExecution,
  {
    readonly qualify: (input: {
      readonly capabilityId: string;
    }) => Effect.Effect<Receipt<"integration.capability.qualified">, FactoryError>;
    readonly prepare: (
      input: Preparation,
    ) => Effect.Effect<Receipt<"integration.prepared">, FactoryError>;
    readonly stop: (input: {
      readonly integrationId: string;
      readonly holdId: string;
      readonly preparationId?: string | null;
    }) => Effect.Effect<void, FactoryError>;
    readonly release: (
      input: Preparation & { readonly holdId: string },
    ) => Effect.Effect<void, FactoryError>;
    readonly mutate: (
      input: Preparation & {
        readonly grantId: string;
        readonly operationId: string;
        readonly operation: FactoryFileMutation;
      },
    ) => Effect.Effect<Receipt<"integration.file.mutated">, FactoryError>;
    readonly verify: (input: {
      readonly verificationId: string;
    }) => Effect.Effect<Receipt<"integration.verified">, FactoryError>;
    readonly capture: (
      input: Preparation,
    ) => Effect.Effect<FactoryIntegrationTestArtifact, FactoryError>;
    readonly readPatch: (input: {
      readonly patchArtifactId: string;
      readonly cursor?: number;
      readonly limit?: number;
    }) => Effect.Effect<FactoryIntegrationPatchPage, FactoryError>;
  }
>()("t3/factory/FactoryIntegrationExecution") {}
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const isFactoryError = Schema.is(FactoryError);
const preserve = (cause: unknown) =>
  isFactoryError(cause)
    ? cause
    : new FactoryError({
        code: "execution-unavailable",
        detail: "The isolated integration runtime could not complete this operation.",
        cause,
      });
const Capture = Schema.Struct({ files: Schema.Array(FactorySourceFile), digest: Schema.String });
const make = Effect.gen(function* () {
  const store = yield* FactoryStore;
  const boundary = yield* FactoryBoundaryExecution;
  const workflows = yield* FactoryWorkflowExecution;
  const pullRequests = yield* PullRequestService;
  const runner = yield* ProcessRunner;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const integrationDigest = (value: unknown) =>
    digestEffect(value).pipe(Effect.provideService(Crypto.Crypto, crypto));
  const integrationId = (value: string) =>
    idEffect(value).pipe(Effect.provideService(Crypto.Crypto, crypto));
  const integrationValidateFiles = (files: readonly FactorySourceFile[]) =>
    validateFilesEffect(files).pipe(Effect.provideService(Crypto.Crypto, crypto));
  const integrationInventory = (directory: string) =>
    inventoryEffect(directory).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const locks = new Map<string, Semaphore.Semaphore>();
  const lock = (id: string) => {
    let mutex = locks.get(id);
    if (!mutex) {
      mutex = Semaphore.makeUnsafe(1);
      locks.set(id, mutex);
    }
    return mutex;
  };
  const root = path.join(config.stateDir, "factory", "integration");
  const location = (kind: string, id: string) =>
    integrationDigest(id).pipe(Effect.map((digest) => path.join(root, kind, digest)));
  const write = Effect.fn(function* (file: string, value: unknown) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const temporary = `${file}.${yield* crypto.randomUUIDv4}`;
    yield* fs.writeFileString(temporary, json(value), { flag: "wx" });
    yield* fs
      .rename(temporary, file)
      .pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)));
  });
  const readRuntime = Effect.fn(function* (preparationId: string) {
    const runtime = yield* fs
      .readFileString(path.join(yield* location("preparations", preparationId), "runtime.json"))
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(IntegrationRuntimeArtifact)),
        ),
      );
    yield* assertIntegrationRuntimeIdentity(runtime).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
    );
    if (runtime.preparationId !== preparationId)
      return yield* integrationError("The runtime belongs to another preparation.");
    return runtime;
  });
  const readCapability = Effect.fn(function* (id: string) {
    return yield* fs
      .readFileString(path.join(yield* location("capabilities", id), "artifact.json"))
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(IntegrationCapabilityArtifact)),
        ),
      );
  });
  const current = Effect.fn(function* (input: Preparation, preparing = false) {
    const state = yield* store.snapshot;
    const integration = state.integrations.find((entry) => entry.id === input.integrationId);
    const preparation = state.integrationPreparations.find(
      (entry) => entry.id === input.preparationId,
    );
    const assignment = state.assignments.find((entry) => entry.id === integration?.assignmentId);
    if (
      !integration ||
      !preparation ||
      preparation.integrationId !== integration.id ||
      integration.currentPreparationId !== preparation.id ||
      !assignment?.grant ||
      assignment.outcome ||
      (preparing
        ? preparation.lifecycle.phase !== "requested"
        : preparation.lifecycle.phase !== "ready")
    )
      return yield* integrationError("The requested integration preparation is no longer current.");
    const blocked = factoryIntegrationAccessBlocked(state, integration.id);
    if (blocked) return yield* integrationError(blocked);
    return { state, integration, preparation, assignment };
  });
  const dockerResult = (
    profile: Pick<FactoryExecutionProfile, "dockerContext">,
    args: readonly string[],
    stdin?: string,
    timeout = 30000,
  ) =>
    runner.run({
      command: "docker",
      args: ["--context", profile.dockerContext, ...args],
      ...(stdin === undefined ? {} : { stdin }),
      timeout,
      maxOutputBytes: 380 * 1024 * 1024,
    });
  const docker = Effect.fn(function* (
    profile: Pick<FactoryExecutionProfile, "dockerContext">,
    args: readonly string[],
    stdin?: string,
    timeout = 30000,
  ) {
    const result = yield* dockerResult(profile, args, stdin, timeout);
    if (result.code !== 0)
      return yield* integrationError(
        `The isolated integration process failed: ${(result.stderr || result.stdout).slice(0, 2000)}`,
      );
    return result.stdout.trim();
  });
  const kill = Effect.fn(function* (
    profile: FactoryExecutionProfile,
    assignmentId: string,
    preparationId: string,
  ) {
    const ids = yield* docker(profile, [
      "ps",
      "--quiet",
      "--filter",
      `label=satellite.factory.assignment=${assignmentId}`,
      "--filter",
      `label=satellite.factory.preparation=${preparationId}`,
    ]);
    for (const id of ids.split(/\s+/).filter(Boolean)) {
      if (!/^[a-f0-9]{12,64}$/.test(id))
        return yield* integrationError("Docker returned an invalid owned container identity.");
      yield* docker(profile, ["rm", "--force", id]);
    }
  });
  const filesTo = Effect.fn(function* (directory: string, files: readonly FactorySourceFile[]) {
    yield* integrationValidateFiles(files);
    for (const file of files) {
      const target = path.join(directory, file.path);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFile(target, Buffer.from(file.content, "base64"));
      yield* fs.chmod(target, file.mode === "100755" ? 0o555 : 0o444);
    }
  });
  const helper = Effect.fn(function* (
    runtime: IntegrationRuntimeArtifact,
    input: unknown,
    readonly = false,
  ) {
    const profile = runtime.profile;
    const workspace = profile.assignmentWorkspace!;
    const directory = yield* location("preparations", runtime.preparationId);
    const journal = path.join(directory, "journal");
    yield* fs.makeDirectory(journal, { recursive: true });
    const name = `satellite-integration-helper-${yield* crypto.randomUUIDv4}`;
    return yield* docker(
      profile,
      [
        "run",
        "--name",
        name,
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
        "--label",
        `satellite.factory.assignment=${workspace.assignmentId}`,
        "--label",
        `satellite.factory.preparation=${runtime.preparationId}`,
        "--mount",
        `type=volume,source=${workspace.volumeName},target=/workspace,volume-nocopy${readonly ? ",readonly" : ""}`,
        ...(readonly
          ? []
          : [
              "--mount",
              `type=bind,source=${path.dirname(workspace.revocationPath)},target=/authority,readonly`,
            ]),
        "--mount",
        `type=bind,source=${journal},target=/journal`,
        "--entrypoint",
        "node",
        profile.imageId,
        "-e",
        factoryVolumeHelper,
      ],
      json(input),
    ).pipe(Effect.ensuring(dockerResult(profile, ["rm", "--force", name]).pipe(Effect.ignore)));
  });
  const qualify = Effect.fn(function* (input: { capabilityId: string }) {
    const state = yield* store.snapshot;
    const capability = state.integrationCapabilities.find(
      (entry) => entry.id === input.capabilityId && entry.supersededBy === null,
    );
    const approved = state.boundaries.find(
      (entry) => entry.id === capability?.boundaryId && entry.projectId === capability.projectId,
    );
    if (!capability || !approved)
      return yield* integrationError(
        "This integration capability has no current approved project boundary.",
      );
    const profile = yield* fs
      .readFileString(
        path.join(config.stateDir, "factory", "execution", approved.profileId, "profile.json"),
      )
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionProfile))),
      );
    const files = yield* integrationInventory(profile.projectSnapshotPath);
    const configurationDigest = yield* integrationDigest({
      capabilityId: capability.id,
      boundary: approved,
      paths: capability.paths,
      coordinator: capability.coordinator,
      protectedFiles: files
        .filter((file) => approved.protectedPaths.includes(file.path))
        .map(({ path, digest, mode }) => ({ path, digest, mode })),
    });
    let coordinatorDigest: string | null = null;
    if (capability.coordinator) {
      const entry = files.find((file) => file.path === capability.coordinator!.entrypoint);
      if (
        !entry ||
        !approved.protectedPaths.includes(entry.path) ||
        !integrationReadable(entry.path, capability.paths) ||
        integrationWritable(entry.path, capability.paths, approved)
      )
        return yield* integrationError(
          "The Node coordinator must be an existing, readable protected boundary file.",
        );
      coordinatorDigest = entry.digest;
      yield* docker(profile, [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--user",
        "10001:10001",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--mount",
        `type=bind,source=${profile.projectSnapshotPath},target=/workspace,readonly`,
        "--entrypoint",
        "/usr/local/bin/node",
        profile.imageId,
        "--check",
        `/workspace/${entry.path}`,
      ]);
    }
    for (const gate of approved.gates) {
      const entry = gate.args[0]?.startsWith("/workspace/")
        ? gate.args[0].slice("/workspace/".length)
        : undefined;
      if (
        gate.executable !== "/usr/local/bin/node" ||
        !entry ||
        !approved.protectedPaths.includes(entry) ||
        !files.some((file) => file.path === entry) ||
        !integrationReadable(entry, capability.paths)
      )
        return yield* integrationError(
          "Integration currently supports direct protected Node project gates with readable entrypoints.",
        );
    }
    for (const name of [...capability.paths.testPaths, ...capability.paths.fixturePaths])
      if (!files.some((file) => file.path === name))
        return yield* integrationError(
          `The classified integration file ${name} does not exist in the approved boundary.`,
        );
    yield* write(path.join(yield* location("capabilities", capability.id), "artifact.json"), {
      capability,
      boundary: approved,
      profile,
      files,
      configurationDigest,
      coordinatorDigest,
    });
    const latest = (yield* store.snapshot).integrationCapabilities.find(
      (entry) => entry.id === capability.id,
    );
    if (latest?.supersededBy !== null)
      return yield* integrationError("The integration capability changed during qualification.");
    return {
      capabilityId: capability.id,
      profileId: approved.profileId,
      configurationDigest,
      coordinatorDigest,
    };
  }, Effect.mapError(preserve));
  const patchPath = (id: string) =>
    location("patches", id).pipe(Effect.map((directory) => path.join(directory, "patch.json")));
  const captureRuntime = Effect.fn(function* (runtime: IntegrationRuntimeArtifact) {
    const captured = yield* helper(runtime, { kind: "capture" }, true).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Capture))),
    );
    yield* integrationValidateFiles(captured.files);
    const projects: FactoryIntegrationTestArtifact["projects"][number][] = [];
    const known = new Set<string>();
    for (const project of runtime.projects) {
      const prefix = `participants/${project.alias}/`;
      const files = captured.files
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => {
          known.add(file.path);
          return { ...file, path: file.path.slice(prefix.length) };
        });
      const before = new Map(project.files.map((file) => [file.path, file]));
      const after = new Map(files.map((file) => [file.path, file]));
      const changed: FactorySourceFile[] = [];
      const deleted: string[] = [];
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        const previous = before.get(name);
        const next = after.get(name);
        if (previous?.digest === next?.digest && previous?.mode === next?.mode) continue;
        if (!integrationWritable(name, project.grant.paths, project.capability.boundary))
          return yield* integrationError(
            `Integration changed ungranted production or protected path ${project.grant.projectId}/${name}.`,
          );
        if (next) changed.push(next);
        else deleted.push(name);
      }
      changed.sort((a, b) => a.path.localeCompare(b.path));
      deleted.sort();
      const patchId = yield* integrationDigest({
        preparationId: runtime.preparationId,
        grantId: project.grant.id,
        files: changed,
        deletedPaths: deleted,
      });
      const patch: IntegrationPatchArtifact = {
        id: patchId,
        preparationId: runtime.preparationId,
        projectId: project.grant.projectId,
        grantId: project.grant.id,
        files: changed,
        deletedPaths: deleted,
      };
      yield* write(yield* patchPath(patchId), patch);
      const input = runtime.manifest.inputs.find(
        (entry) => entry.projectId === project.grant.projectId,
      )!;
      projects.push({
        projectId: project.grant.projectId,
        grantId: project.grant.id,
        candidateId: input.candidateId,
        candidateDigest: input.candidateDigest,
        sourceDigest: input.sourceDigest,
        changedPaths: changed.map((file) => file.path),
        deletedPaths: deleted,
        patchArtifactId: patchId,
      });
    }
    if (captured.files.some((file) => !known.has(file.path)))
      return yield* integrationError(
        "The integration workspace contains unassigned files outside its participant roots.",
      );
    const digest = yield* integrationDigest(projects);
    const artifact: FactoryIntegrationTestArtifact = {
      id: `integration-tests:${digest}`,
      integrationId: runtime.integrationId,
      preparationId: runtime.preparationId,
      digest,
      projects,
      capturedAt: yield* nowIso,
    };
    yield* write(path.join(yield* location("tests", artifact.id), "artifact.json"), artifact);
    return artifact;
  });
  const readPatchArtifact = Effect.fn(function* (id: string) {
    const patch = yield* fs
      .readFileString(yield* patchPath(id))
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(IntegrationPatchArtifact))),
      );
    if (
      patch.id !== id ||
      (yield* integrationDigest({
        preparationId: patch.preparationId,
        grantId: patch.grantId,
        files: patch.files,
        deletedPaths: patch.deletedPaths,
      })) !== id
    )
      return yield* integrationError("The test patch artifact identity changed.");
    yield* integrationValidateFiles(patch.files);
    return patch;
  });
  const capture = Effect.fn(function* (input: Preparation) {
    const runtime = yield* readRuntime(input.preparationId);
    if (runtime.integrationId !== input.integrationId)
      return yield* integrationError("The preparation belongs to another integration.");
    return yield* lock(input.integrationId).withPermit(captureRuntime(runtime));
  }, Effect.mapError(preserve));
  const stop = Effect.fn(function* (input: {
    integrationId: string;
    holdId: string;
    preparationId?: string | null;
  }) {
    const state = yield* store.snapshot;
    const integration = state.integrations.find((entry) => entry.id === input.integrationId);
    if (!integration)
      return yield* integrationError("The integration runtime owner is unavailable.");
    const preparationId =
      input.preparationId === undefined ? integration.currentPreparationId : input.preparationId;
    if (preparationId === null) return;
    const preparation = state.integrationPreparations.find(
      (entry) => entry.id === preparationId && entry.integrationId === integration.id,
    );
    if (!preparation)
      return yield* integrationError("The stop request names another integration preparation.");
    const pendingProfileId = yield* integrationId(preparationId);
    yield* write(
      path.join(
        config.stateDir,
        "factory",
        "execution",
        pendingProfileId,
        "authority",
        "integration-holds",
        `${yield* integrationDigest(input.holdId)}.json`,
      ),
      { holdId: input.holdId },
    );
    let selected: typeof preparation | undefined = preparation;
    const visited = new Set<string>();
    const stopped: IntegrationRuntimeArtifact[] = [];
    while (selected && !visited.has(selected.id)) {
      visited.add(selected.id);
      const directory = yield* location("preparations", selected.id);
      const manifest = path.join(
        directory,
        (yield* fs.exists(path.join(directory, "runtime.json"))) ? "runtime.json" : "request.json",
      );
      if (yield* fs.exists(manifest)) {
        const runtime = yield* fs
          .readFileString(manifest)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(IntegrationRuntimeArtifact)),
            ),
          );
        if (
          runtime.integrationId !== integration.id ||
          runtime.preparationId !== selected.id ||
          runtime.profile.assignmentWorkspace?.assignmentId !== integration.assignmentId
        )
          return yield* integrationError(
            "The stopped runtime identity does not match its preparation.",
          );
        yield* write(
          path.join(
            runtime.profile.integration!.stopPath,
            `${yield* integrationDigest(input.holdId)}.json`,
          ),
          { holdId: input.holdId },
        );
        yield* kill(runtime.profile, integration.assignmentId, selected.id);
        stopped.push(runtime);
      }
      selected = state.integrationPreparations.find(
        (entry) =>
          entry.id === selected?.previousPreparationId && entry.integrationId === integration.id,
      );
    }
    yield* lock(input.integrationId).withPermit(Effect.void);
    for (const runtime of stopped)
      yield* kill(runtime.profile, integration.assignmentId, runtime.preparationId);
  }, Effect.mapError(preserve));
  const release = Effect.fn(function* (input: Preparation & { holdId: string }) {
    yield* current(input);
    const runtime = yield* readRuntime(input.preparationId);
    if (runtime.integrationId !== input.integrationId)
      return yield* integrationError("The runtime belongs to another integration.");
    const reasons = factoryIntegrationManifestReasons(
      yield* store.snapshot,
      input.integrationId,
      runtime.manifest,
    );
    if (reasons.length) return yield* integrationError(reasons.join(" "));
    const marker = path.join(
      runtime.profile.integration!.stopPath,
      `${yield* integrationDigest(input.holdId)}.json`,
    );
    if (yield* fs.exists(marker)) yield* fs.remove(marker);
  }, Effect.mapError(preserve));
  const readPatch = Effect.fn(function* (
    input: Parameters<FactoryIntegrationExecution["Service"]["readPatch"]>[0],
  ) {
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? 16000;
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 16000
    )
      return yield* integrationError(
        "Patch paging requires a nonnegative cursor and at most 16000 characters.",
      );
    const artifact = yield* readPatchArtifact(input.patchArtifactId);
    const text = stableStringify({ files: artifact.files, deletedPaths: artifact.deletedPaths });
    if (cursor > text.length)
      return yield* integrationError("The patch cursor exceeds this immutable artifact.");
    return {
      patchArtifactId: artifact.id,
      projectId: artifact.projectId,
      digest: yield* integrationDigest({
        files: artifact.files,
        deletedPaths: artifact.deletedPaths,
      }),
      encoding: "json" as const,
      text: text.slice(cursor, cursor + limit),
      cursor,
      nextCursor: cursor + limit < text.length ? cursor + limit : null,
      totalCharacters: text.length,
    };
  }, Effect.mapError(preserve));
  const prepare = Effect.fn(function* (input: Preparation) {
    return yield* lock(input.integrationId).withPermit(
      Effect.gen(function* () {
        const { state, integration, preparation, assignment } = yield* current(input, true);
        const directory = yield* location("preparations", preparation.id);
        const completed = path.join(directory, "runtime.json");
        if (yield* fs.exists(completed)) {
          const runtime = yield* readRuntime(preparation.id);
          const reasons = factoryIntegrationManifestReasons(
            state,
            integration.id,
            runtime.manifest,
          );
          if (reasons.length) return yield* integrationError(reasons.join(" "));
          return {
            integrationId: integration.id,
            preparationId: preparation.id,
            manifest: runtime.manifest,
            profileId: runtime.profile.profileId!,
            testArtifact: runtime.initialTestArtifact,
          };
        }
        const inputs: FactoryIntegrationInput[] = [];
        const projects: IntegrationRuntimeArtifact["projects"][number][] = [];
        for (const participantId of [...integration.participantAssignmentIds].sort()) {
          const participant = state.assignments.find((entry) => entry.id === participantId)!;
          const grant = state.integrationGrants.find(
            (entry) =>
              preparation.grantIds.includes(entry.id) &&
              entry.participantAssignmentId === participantId &&
              entry.lifecycle.phase === "active",
          );
          const revision = participant.delivery?.revisions.find(
            (entry) => entry.id === participant.delivery?.currentRevisionId,
          );
          if (!grant || !participant.grant || !revision?.candidateId || !revision.candidateDigest)
            return yield* integrationError(
              `Project ${participant.projectId} needs a captured immutable candidate and current grant.`,
            );
          const capability = yield* readCapability(grant.capabilityId);
          const qualified = state.integrationCapabilities.find(
            (entry) => entry.id === grant.capabilityId,
          )?.qualification;
          if (
            qualified?.status !== "qualified" ||
            qualified.configurationDigest !== capability.configurationDigest ||
            qualified.coordinatorDigest !== capability.coordinatorDigest ||
            capability.boundary.id !== grant.boundaryId
          )
            return yield* integrationError(
              "A qualified integration capability no longer matches its protected runtime artifact.",
            );
          const candidate = yield* boundary.readCandidate(revision.candidateId);
          if (
            candidate.assignmentId !== participant.id ||
            candidate.projectId !== participant.projectId ||
            candidate.sourceDigest !== revision.candidateDigest ||
            candidate.grant.epoch !== participant.grant.epoch ||
            candidate.leadThreadId !== participant.threadId
          )
            return yield* integrationError(
              "The participant candidate does not match its current assignment and source grant.",
            );
          let publication: FactoryIntegrationInput["publication"] = {
            kind: "unpublished-candidate",
          };
          let files = candidate.files;
          let sourceDigest = candidate.sourceDigest;
          if (revision.status === "published") {
            const destination = revision.publication;
            if (
              !destination?.ref ||
              !candidate.finalized ||
              candidate.finalized.commitOid !== destination.headSha ||
              candidate.finalized.treeOid !== destination.treeOid
            )
              return yield* integrationError(
                "Published integration inputs require the exact finalized publication tree.",
              );
            const observed = yield* pullRequests.inspectForMerge(destination.ref);
            if (
              !observed.complete ||
              observed.headSha !== destination.headSha ||
              observed.baseSha !== revision.hostEvidence?.baseSha
            )
              return yield* integrationError(
                "The published head or base changed. The owning team must refresh its delivery evidence first.",
              );
            publication = {
              kind: "published-head",
              ref: destination.ref,
              headSha: observed.headSha,
              baseSha: observed.baseSha,
              treeOid: destination.treeOid,
            };
            files = candidate.finalized.files;
            sourceDigest = candidate.finalized.sourceDigest;
          }
          yield* integrationValidateFiles(files);
          for (const protectedFile of capability.files.filter((file) =>
            capability.boundary.protectedPaths.some(
              (root) => file.path === root || file.path.startsWith(root + "/"),
            ),
          )) {
            const actual = files.find((file) => file.path === protectedFile.path);
            if (actual?.digest !== protectedFile.digest || actual.mode !== protectedFile.mode)
              return yield* integrationError(
                "A protected participant file differs from its qualified integration capability.",
              );
          }
          inputs.push({
            projectId: participant.projectId,
            assignmentId: participant.id,
            leadThreadId: participant.threadId,
            revisionId: revision.id,
            candidateId: candidate.id,
            candidateDigest: revision.candidateDigest,
            sourceDigest,
            boundaryId: grant.boundaryId,
            grantEpoch: participant.grant.epoch,
            integrationGrantId: grant.id,
            capabilityId: grant.capabilityId,
            publication,
          });
          const alias = `project-${(yield* integrationDigest(participant.projectId)).slice(0, 16)}`;
          projects.push({
            alias,
            grant,
            capability,
            files: files.filter((file) => integrationReadable(file.path, grant.paths)),
          });
        }
        const coordinator = projects.find(
          (entry) => entry.grant.projectId === integration.coordinatorProjectId,
        )!;
        if (
          !coordinator?.capability.coordinatorDigest ||
          !coordinator.capability.capability.coordinator
        )
          return yield* integrationError("This integration has no qualified combined coordinator.");
        if (
          projects.some(
            (entry) =>
              entry.capability.profile.dockerContext !==
                coordinator.capability.profile.dockerContext ||
              entry.capability.profile.imageId !== coordinator.capability.profile.imageId,
          )
        )
          return yield* integrationError(
            "All initial integration participants require the same qualified Docker engine and image.",
          );
        const manifestFields = {
          inputs,
          planIds: factoryIntegrationPlanIds(state, integration.id),
          coordinatorCapabilityId: coordinator.grant.capabilityId,
          coordinatorDigest: coordinator.capability.coordinatorDigest,
        };
        const manifest: FactoryIntegrationManifest = {
          ...manifestFields,
          inputDigest: yield* integrationDigest(manifestFields),
        };
        const profileId = yield* integrationId(preparation.id);
        const profileDirectory = path.join(config.stateDir, "factory", "execution", profileId);
        const workflow = yield* workflows.snapshot({ version: assignment.workflow });
        const authority = path.join(profileDirectory, "authority");
        yield* fs.makeDirectory(authority, { recursive: true });
        yield* fs.makeDirectory(path.join(profileDirectory, "controls"), { recursive: true });
        yield* fs.makeDirectory(path.join(profileDirectory, "runtime", "codex"), {
          recursive: true,
        });
        const volumeName = `satellite-integration-${profileId}`;
        const profile: FactoryExecutionProfile = {
          ...coordinator.capability.profile,
          boundaryId: profileId,
          profileId,
          projectSnapshotPath: path.join(profileDirectory, "project"),
          workflow,
          workflowSnapshotPath: workflow.snapshotPath,
          runtimePath: path.join(profileDirectory, "runtime"),
          ...(assignment.startingSource
            ? {
                startingSourceId: assignment.startingSource.id,
                startingSourceDigest: assignment.startingSource.sourceDigest,
              }
            : {}),
          assignmentWorkspace: {
            assignmentId: assignment.id,
            volumeName,
            grantEpoch: assignment.grant!.epoch,
            boundaryId: assignment.grant!.boundaryId,
            controlsPath: path.join(profileDirectory, "controls"),
            revocationPath: path.join(authority, "revoked.json"),
            workerUid: 10001,
            workerGid: 10001,
          },
          integration: {
            integrationId: integration.id,
            preparationId: preparation.id,
            inputDigest: manifest.inputDigest,
            grantIds: preparation.grantIds,
            manifestPath: path.join(profileDirectory, "integration.json"),
            stopPath: path.join(authority, "integration-holds"),
          },
        };
        const initialTestArtifact: FactoryIntegrationTestArtifact = {
          id: "unprepared",
          integrationId: integration.id,
          preparationId: preparation.id,
          digest: "unprepared",
          projects: [],
          capturedAt: yield* nowIso,
        };
        const runtime: IntegrationRuntimeArtifact = {
          integrationId: integration.id,
          preparationId: preparation.id,
          profile,
          manifest,
          projects,
          initialTestArtifact,
        };
        let previous: IntegrationRuntimeArtifact | undefined;
        let previousTests: FactoryIntegrationTestArtifact | undefined;
        let priorId = preparation.previousPreparationId;
        const visited = new Set<string>();
        while (priorId && !visited.has(priorId)) {
          visited.add(priorId);
          if (
            yield* fs.exists(path.join(yield* location("preparations", priorId), "runtime.json"))
          ) {
            previous = yield* readRuntime(priorId);
            previousTests = yield* captureRuntime(previous);
            break;
          }
          priorId =
            state.integrationPreparations.find(
              (entry) => entry.id === priorId && entry.integrationId === integration.id,
            )?.previousPreparationId ?? null;
        }
        const workspaceFiles: Array<FactorySourceFile & { writable: boolean }> = [];
        for (const project of projects) {
          const assembled = new Map(project.files.map((file) => [file.path, file]));
          const previousProject = previous?.projects.find(
            (entry) => entry.grant.projectId === project.grant.projectId,
          );
          const previousPatch = previousTests?.projects.find(
            (entry) => entry.projectId === project.grant.projectId,
          );
          if (previousProject && previousPatch) {
            const patch = yield* readPatchArtifact(previousPatch.patchArtifactId);
            const prior = new Map(previousProject.files.map((file) => [file.path, file]));
            for (const name of [...patch.files.map((file) => file.path), ...patch.deletedPaths]) {
              const old = prior.get(name);
              const next = assembled.get(name);
              const retained = patch.files.find((file) => file.path === name);
              if (next?.digest === retained?.digest && next?.mode === retained?.mode) continue;
              if (!integrationWritable(name, project.grant.paths, project.capability.boundary))
                return yield* integrationError(
                  `Retained test work at ${project.grant.projectId}/${name} is outside the replacement grant. Its patch is preserved.`,
                );
              if (old?.digest !== next?.digest || old?.mode !== next?.mode)
                return yield* integrationError(
                  `Refresh conflict at ${project.grant.projectId}/${name}. Both the owner candidate and retained integration work changed this path.`,
                );
              if (retained) assembled.set(name, retained);
              else assembled.delete(name);
            }
          }
          for (const file of assembled.values())
            workspaceFiles.push({
              ...file,
              path: `participants/${project.alias}/${file.path}`,
              writable: integrationWritable(
                file.path,
                project.grant.paths,
                project.capability.boundary,
              ),
            });
        }
        yield* write(path.join(directory, "request.json"), runtime);
        yield* current(input, true);
        yield* dockerResult(profile, ["volume", "rm", volumeName]);
        yield* docker(profile, [
          "volume",
          "create",
          "--label",
          `satellite.factory.integration=${integration.id}`,
          volumeName,
        ]);
        yield* helper(runtime, { kind: "initialize", files: workspaceFiles });
        yield* filesTo(profile.projectSnapshotPath, workspaceFiles);
        const writable = workspaceFiles.find((file) => file.writable);
        const protectedFile = workspaceFiles.find((file) => !file.writable);
        if (!writable || !protectedFile)
          return yield* integrationError(
            "Integration qualification needs a granted existing test or fixture and a protected production file.",
          );
        const probe = `const fs=require('fs');const p=${json(`/workspace/${writable.path}`)};const b=fs.readFileSync(p);fs.writeFileSync(p,b);let denied=false;try{fs.writeFileSync(${json(`/workspace/${protectedFile.path}`)},'bad')}catch{denied=true}if(!denied)throw Error('production writable');for(const operation of [()=>fs.writeFileSync('/workspace/escape','bad'),()=>fs.symlinkSync('/tmp','/workspace/alias')]){let refused=false;try{operation()}catch{refused=true}if(!refused)throw Error('directory writable')}console.log('integration-boundary-ok')`;
        yield* docker(profile, [
          ...factoryDockerArguments(profile).slice(2),
          "--network",
          "none",
          "--entrypoint",
          "node",
          profile.imageId,
          "-e",
          probe,
        ]);
        yield* current(input, true);
        const reasons = factoryIntegrationManifestReasons(
          yield* store.snapshot,
          integration.id,
          manifest,
        );
        if (reasons.length) return yield* integrationError(reasons.join(" "));
        const testArtifact = yield* captureRuntime(runtime);
        const ready = { ...runtime, initialTestArtifact: testArtifact };
        yield* write(profile.integration!.manifestPath, {
          profileId,
          assignmentId: assignment.id,
          integrationId: integration.id,
          preparationId: preparation.id,
          manifest,
        });
        yield* write(path.join(profileDirectory, "profile.json"), profile);
        yield* write(completed, ready);
        return {
          integrationId: integration.id,
          preparationId: preparation.id,
          manifest,
          profileId,
          testArtifact,
        };
      }),
    );
  }, Effect.mapError(preserve));
  const runtimeCurrent = Effect.fn(function* (input: Preparation) {
    yield* current(input);
    const runtime = yield* readRuntime(input.preparationId);
    const reasons = factoryIntegrationManifestReasons(
      yield* store.snapshot,
      input.integrationId,
      runtime.manifest,
    );
    if (reasons.length) return yield* integrationError(reasons.join(" "));
    for (const source of runtime.manifest.inputs)
      if (source.publication.kind === "published-head") {
        const observed = yield* pullRequests.inspectForMerge(source.publication.ref);
        if (
          !observed.complete ||
          observed.headSha !== source.publication.headSha ||
          observed.baseSha !== source.publication.baseSha
        )
          return yield* integrationError(
            "A published participant changed after preparation. Refresh the integration inputs.",
          );
      }
    return runtime;
  });
  const mutate = Effect.fn(function* (
    input: Parameters<FactoryIntegrationExecution["Service"]["mutate"]>[0],
  ) {
    return yield* lock(input.integrationId).withPermit(
      Effect.gen(function* () {
        const runtime = yield* runtimeCurrent(input);
        const project = runtime.projects.find((entry) => entry.grant.id === input.grantId);
        if (
          !project ||
          !integrationWritable(
            input.operation.path,
            project.grant.paths,
            project.capability.boundary,
          ) ||
          (input.operation.kind === "rename" &&
            !integrationWritable(
              input.operation.to,
              project.grant.paths,
              project.capability.boundary,
            ))
        )
          return yield* integrationError(
            "This file operation is outside the project's exact integration test and fixture grant.",
          );
        const prefix = `participants/${project.alias}/`;
        const operation = {
          ...input.operation,
          path: `${prefix}${input.operation.path}`,
          ...(input.operation.kind === "rename" ? { to: `${prefix}${input.operation.to}` } : {}),
          ...("content" in input.operation
            ? { content: Buffer.from(input.operation.content).toString("base64") }
            : {}),
        };
        const commandId = yield* integrationId(input.operationId);
        yield* runtimeCurrent(input);
        yield* helper(runtime, {
          kind: "mutate",
          commandId,
          operation,
          request: stableStringify(input),
        });
        const testArtifact = yield* captureRuntime(runtime);
        return {
          integrationId: input.integrationId,
          preparationId: input.preparationId,
          operationId: input.operationId,
          testArtifact,
        };
      }),
    );
  }, Effect.mapError(preserve));
  const verify = Effect.fn(function* (input: { verificationId: string }) {
    const state = yield* store.snapshot;
    const verification = state.integrationVerifications.find(
      (entry) => entry.id === input.verificationId,
    );
    if (!verification)
      return yield* integrationError("The requested integration verification does not exist.");
    return yield* lock(verification.integrationId).withPermit(
      Effect.gen(function* () {
        const directory = yield* location("verifications", verification.id);
        const receiptPath = path.join(directory, "receipt.json");
        const receiptSchema = Schema.Struct({
          verificationId: Schema.String,
          result: Schema.Literals(["passed", "failed", "stopped"]),
          testArtifact: FactoryIntegrationTestArtifact,
          hostArtifactId: Schema.String,
          checks: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              exitCode: Schema.NullOr(Schema.Int),
              status: Schema.Literals(["passed", "failed", "stopped"]),
              output: Schema.String,
            }),
          ),
        });
        if (yield* fs.exists(receiptPath))
          return yield* fs
            .readFileString(receiptPath)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(receiptSchema))));
        const request = {
          integrationId: verification.integrationId,
          preparationId: verification.preparationId,
        };
        const runtime = yield* runtimeCurrent(request);
        if (runtime.manifest.inputDigest !== verification.inputDigest)
          return yield* integrationError("The verification input vector changed before execution.");
        const ownHold = path.join(
          runtime.profile.integration!.stopPath,
          `${yield* integrationDigest(verification.id)}.json`,
        );
        if (!(yield* fs.exists(ownHold)))
          return yield* integrationError(
            "Stop integration writers before sealing the verification test artifact.",
          );
        const testArtifact = yield* captureRuntime(runtime);
        const roots = new Map<ProjectId, string>();
        for (const project of runtime.projects) {
          const patchRef = testArtifact.projects.find(
            (entry) => entry.projectId === project.grant.projectId,
          )!;
          const patch = yield* readPatchArtifact(patchRef.patchArtifactId);
          const files = new Map(project.files.map((file) => [file.path, file]));
          for (const file of patch.files) files.set(file.path, file);
          for (const deleted of patch.deletedPaths) files.delete(deleted);
          const target = path.join(directory, "projects", project.alias);
          yield* filesTo(target, [...files.values()]);
          roots.set(project.grant.projectId, target);
        }
        const manifestPath = path.join(directory, "manifest.json");
        yield* write(manifestPath, {
          ...runtime.manifest,
          testArtifactDigest: testArtifact.digest,
          projects: runtime.projects.map((entry) => ({
            projectId: entry.grant.projectId,
            alias: entry.alias,
            root: `/participants/${entry.alias}`,
          })),
        });
        const checks: Receipt<"integration.verified">["checks"][number][] = [];
        const run = Effect.fn(function* (
          project: IntegrationRuntimeArtifact["projects"][number],
          id: string,
          entrypoint: string,
          args: readonly string[],
          timeoutMs: number,
          cwd = ".",
        ) {
          const authority = yield* runtimeCurrent(request).pipe(Effect.result);
          if (Result.isFailure(authority)) {
            checks.push({
              id,
              status: "stopped",
              exitCode: null,
              output: authority.failure.message,
            });
            return;
          }
          const name = `satellite-integration-check-${yield* crypto.randomUUIDv4}`;
          const ownMarker = path.basename(ownHold);
          const watchdog = `const fs=require('node:fs');const {spawn}=require('node:child_process');const own=${json(ownMarker)};const stopped=()=>{try{return fs.existsSync('/authority/revoked.json')||(fs.existsSync('/authority/suspension.json')&&JSON.parse(fs.readFileSync('/authority/suspension.json','utf8')).state!=='resumed')||(fs.existsSync('/authority/incidents')&&fs.readdirSync('/authority/incidents').length>0)||(fs.existsSync('/authority/integration-holds')&&fs.readdirSync('/authority/integration-holds').some(x=>x!==own))}catch{return true}};if(stopped())process.exit(143);const child=spawn('/usr/local/bin/node',${json([`/workspace/${entrypoint}`, ...args])},{stdio:'inherit',env:{...process.env,SATELLITE_INTEGRATION_MANIFEST:'/integration/manifest.json'}});const timer=setInterval(()=>{if(stopped()){child.kill('SIGKILL');process.exit(143)}},25);child.on('error',()=>{clearInterval(timer);process.exit(1)});child.on('exit',code=>{clearInterval(timer);process.exit(code??1)});`;
          const result = yield* dockerResult(
            runtime.profile,
            [
              "run",
              "--name",
              name,
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
              "--cpus",
              "2",
              "--tmpfs",
              "/tmp:rw,nosuid,nodev,size=256m",
              "--label",
              `satellite.factory.assignment=${runtime.profile.assignmentWorkspace!.assignmentId}`,
              "--label",
              `satellite.factory.preparation=${runtime.preparationId}`,
              "--mount",
              `type=bind,source=${roots.get(project.grant.projectId)!},target=/workspace,readonly`,
              ...runtime.projects.flatMap((peer) => [
                "--mount",
                `type=bind,source=${roots.get(peer.grant.projectId)!},target=/participants/${peer.alias},readonly`,
              ]),
              "--mount",
              `type=bind,source=${manifestPath},target=/integration/manifest.json,readonly`,
              "--mount",
              `type=bind,source=${path.dirname(runtime.profile.assignmentWorkspace!.revocationPath)},target=/authority,readonly`,
              "--workdir",
              cwd === "." ? "/workspace" : `/workspace/${cwd}`,
              "--entrypoint",
              "/usr/local/bin/node",
              runtime.profile.imageId,
              "-e",
              watchdog,
            ],
            undefined,
            timeoutMs,
          ).pipe(
            Effect.ensuring(
              dockerResult(runtime.profile, ["rm", "--force", name]).pipe(Effect.ignore),
            ),
          );
          const after = yield* runtimeCurrent(request).pipe(Effect.result);
          const stopped = Result.isFailure(after) || result.code === 143;
          checks.push({
            id,
            status: stopped ? "stopped" : result.code === 0 ? "passed" : "failed",
            exitCode: result.code,
            output: `${result.stdout}${result.stderr}`.slice(0, 64000),
          });
        });
        for (const project of runtime.projects)
          for (const gate of project.capability.boundary.gates) {
            if (
              gate.executable !== "/usr/local/bin/node" ||
              !gate.args[0]?.startsWith("/workspace/") ||
              !project.capability.boundary.protectedPaths.includes(
                gate.args[0].slice("/workspace/".length),
              )
            )
              return yield* integrationError(
                "This project gate has no supported protected Node entrypoint.",
              );
            yield* run(
              project,
              `${project.alias}:${gate.id}`,
              gate.args[0].slice("/workspace/".length),
              gate.args.slice(1),
              gate.timeoutMs,
              gate.cwd,
            );
          }
        const coordinator = runtime.projects.find(
          (entry) =>
            entry.grant.projectId ===
            state.integrations.find((entry) => entry.id === runtime.integrationId)!
              .coordinatorProjectId,
        )!;
        const coordinatorConfig = coordinator.capability.capability.coordinator!;
        yield* run(
          coordinator,
          "combined-coordinator",
          coordinatorConfig.entrypoint,
          coordinatorConfig.args,
          coordinatorConfig.timeoutMs,
        );
        const result = checks.some((entry) => entry.status === "stopped")
          ? ("stopped" as const)
          : checks.length > 0 && checks.every((entry) => entry.status === "passed")
            ? ("passed" as const)
            : ("failed" as const);
        const receipt: Receipt<"integration.verified"> = {
          verificationId: verification.id,
          result,
          testArtifact,
          hostArtifactId: `integration-verification:${verification.id}`,
          checks,
        };
        yield* write(receiptPath, receipt);
        return receipt;
      }),
    );
  }, Effect.mapError(preserve));
  return FactoryIntegrationExecution.of({
    qualify,
    prepare,
    stop,
    release,
    mutate,
    verify,
    capture,
    readPatch,
  });
});
export const layer = Layer.effect(FactoryIntegrationExecution, make);
