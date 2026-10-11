import {
  FactoryError,
  type FactoryAssignmentId,
  type FactoryRetroQualification,
  type ThreadId,
  isFactoryError,
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
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import {
  admissibleFactorySourcePath,
  factoryDockerArguments,
  FactoryExecutionProfile,
} from "./FactoryExecutionProfile.ts";
import { factoryExecutionProbe } from "./FactoryExecutionProbe.ts";
import * as FactoryRetroEvidence from "./FactoryRetroEvidence.ts";
import * as FactorySource from "./FactorySource.ts";
import * as FactoryStore from "./FactoryStore.ts";
import {
  IntegrationRuntimeArtifact,
  assertIntegrationRuntimeIdentity,
  integrationDigest,
} from "./FactoryIntegrationRuntime.ts";

export class FactoryRetroExecution extends Context.Service<
  FactoryRetroExecution,
  {
    readonly prepare: (input: {
      readonly assignmentId: FactoryAssignmentId;
      readonly retroId: string;
      readonly threadId: ThreadId;
      readonly conclusionId: string;
      readonly evidenceDigest: string;
    }) => Effect.Effect<
      { readonly qualification: FactoryRetroQualification; readonly sourceDigest: string },
      FactoryError
    >;
    readonly stop: (input: { readonly retroId: string }) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryRetroExecution") {}

const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionProfile));
const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(FactoryExecutionProfile));
const decodeIntegration = Schema.decodeUnknownEffect(
  Schema.fromJsonString(IntegrationRuntimeArtifact),
);
const unavailable = () =>
  new FactoryError({
    code: "execution-unavailable",
    detail:
      "The preserved retrospective evidence could not be qualified. Implementation authority remains withdrawn.",
  });

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const store = yield* FactoryStore.FactoryStore;
  const evidence = yield* FactoryRetroEvidence.FactoryRetroEvidence;
  const sources = yield* FactorySource.FactorySource;
  const boundaries = yield* FactoryBoundaryExecution.FactoryBoundaryExecution;
  const runner = yield* ProcessRunner;
  const mutex = yield* Semaphore.make(1);
  const root = path.join(config.stateDir, "factory", "execution");
  const digest = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
  const digestIntegration = (value: unknown) =>
    integrationDigest(value).pipe(Effect.provideService(Crypto.Crypto, crypto));
  const profileIdFor = (retroId: string) =>
    digest(new TextEncoder().encode(stableStringify({ kind: "retrospective", retroId }))).pipe(
      Effect.map(
        (hex) =>
          `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
      ),
    );
  const assertCurrent = Effect.fn("FactoryRetroExecution.assertCurrent")(function* (
    input: Parameters<FactoryRetroExecution["Service"]["prepare"]>[0],
  ) {
    const state = yield* store.snapshot;
    const assignment = state.assignments.find((entry) => entry.id === input.assignmentId);
    const retro = state.retros.find((entry) => entry.id === input.retroId);
    const conclusion = assignment?.completion?.conclusion;
    if (
      !assignment ||
      !retro ||
      !conclusion ||
      retro.assignmentId !== assignment.id ||
      retro.threadId !== input.threadId ||
      retro.conclusionId !== input.conclusionId ||
      retro.evidenceDigest !== input.evidenceDigest ||
      conclusion.id !== input.conclusionId ||
      conclusion.evidenceDigest !== input.evidenceDigest ||
      retro.execution.status === "stopped" ||
      retro.reports.phase === "complete" ||
      state.controls.some(
        (entry) =>
          entry.kind === "project-pause" &&
          entry.status === "active" &&
          entry.projectId === assignment.projectId,
      )
    )
      return yield* unavailable();
    return assignment;
  });
  const writeFiles = Effect.fn("FactoryRetroExecution.writeFiles")(function* (
    destination: string,
    files: ReadonlyArray<FactorySource.FactorySourceFile>,
  ) {
    yield* fs.makeDirectory(destination, { recursive: true });
    for (const file of files) {
      const bytes = Buffer.from(file.content, "base64");
      if (
        !admissibleFactorySourcePath(file.path) ||
        path.isAbsolute(file.path) ||
        (yield* digest(bytes)) !== file.digest
      )
        return yield* unavailable();
      const target = path.join(destination, file.path);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFile(target, bytes, { flag: "wx" });
      yield* fs.chmod(target, file.mode === "100755" ? 0o755 : 0o644);
    }
  });
  const copyWorkflow = Effect.fn("FactoryRetroExecution.copyWorkflow")(function* (
    source: string,
    destination: string,
  ) {
    if (path.relative(source, yield* fs.realPath(source)) !== "") return yield* unavailable();
    yield* fs.makeDirectory(destination, { recursive: true });
    for (const name of yield* fs.readDirectory(source, { recursive: true })) {
      const from = path.join(source, name);
      if (path.relative(from, yield* fs.realPath(from)) !== "") return yield* unavailable();
      const stat = yield* fs.stat(from);
      const target = path.join(destination, name);
      if (stat.type === "Directory") yield* fs.makeDirectory(target, { recursive: true });
      else if (stat.type === "File" && admissibleFactorySourcePath(name)) {
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFile(target, yield* fs.readFile(from), { flag: "wx" });
      } else return yield* unavailable();
    }
  });
  const prepare = Effect.fn("FactoryRetroExecution.prepare")(
    function* (input: Parameters<FactoryRetroExecution["Service"]["prepare"]>[0]) {
      const assignment = yield* assertCurrent(input);
      const sealed = yield* evidence.read(input);
      const profileId = yield* profileIdFor(input.retroId);
      const directory = path.join(root, profileId);
      const stopPath = path.join(directory, "stopped.json");
      if (yield* fs.exists(stopPath)) return yield* unavailable();
      const profilePath = path.join(directory, "profile.json");
      let profile: FactoryExecutionProfile;
      if (yield* fs.exists(profilePath)) {
        profile = yield* fs.readFileString(profilePath).pipe(Effect.flatMap(decodeProfile));
        if (
          profile.retro?.retroId !== input.retroId ||
          profile.retro.assignmentId !== input.assignmentId ||
          profile.retro.conclusionId !== input.conclusionId ||
          profile.retro.evidenceDigest !== input.evidenceDigest ||
          profile.assignmentWorkspace !== undefined ||
          profile.inspection?.evidencePath !== sealed.directory
        )
          return yield* unavailable();
      } else {
        const state = yield* store.snapshot;
        // A workflow restart or integration re-preparation withdraws the current qualification,
        // so the retro inspects with the profile the team last ran in.
        const qualifiedProfileId =
          assignment.qualification.status === "qualified"
            ? assignment.qualification.profileId
            : undefined;
        const source = yield* Effect.gen(function* () {
          if (assignment.integrationId) {
            const integration = state.integrations.find(
              (entry) => entry.id === assignment.integrationId,
            );
            const conclusion = assignment.completion?.conclusion;
            const operation =
              conclusion?.kind === "shared-group-delivered"
                ? state.mergeOperations.find((entry) => entry.id === conclusion.operationId)
                : undefined;
            if (
              conclusion?.kind === "shared-group-delivered" &&
              (operation?.lifecycle.phase !== "completed" ||
                operation.integrationId !== assignment.integrationId ||
                operation.integrationAssignmentId !== assignment.id ||
                operation.groupId !== conclusion.groupId ||
                operation.lifecycle.receiptDigest !== conclusion.receiptDigest)
            )
              return yield* unavailable();
            const preparationId =
              operation?.lifecycle.phase === "completed"
                ? operation.lifecycle.frozen.integrationPreparationId
                : integration?.currentPreparationId;
            if (!preparationId || integration?.assignmentId !== assignment.id)
              return yield* unavailable();
            const location = yield* digestIntegration(preparationId);
            const runtime = yield* fs
              .readFileString(
                path.join(
                  config.stateDir,
                  "factory",
                  "integration",
                  "preparations",
                  location,
                  "runtime.json",
                ),
              )
              .pipe(Effect.flatMap(decodeIntegration));
            yield* assertIntegrationRuntimeIdentity(runtime).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
            );
            if (
              runtime.integrationId !== assignment.integrationId ||
              runtime.preparationId !== preparationId ||
              (qualifiedProfileId !== undefined &&
                runtime.profile.profileId !== qualifiedProfileId) ||
              runtime.profile.assignmentWorkspace?.assignmentId !== assignment.id ||
              (operation?.lifecycle.phase === "completed" &&
                (runtime.manifest.inputDigest !== operation.lifecycle.frozen.inputDigest ||
                  conclusion?.kind !== "shared-group-delivered" ||
                  operation.lifecycle.receiptDigest !== conclusion.receiptDigest))
            )
              return yield* unavailable();
            const files = runtime.projects.flatMap((project) =>
              project.files.map((file) => ({
                ...file,
                path: `participants/${project.alias}/${file.path}`,
              })),
            );
            return {
              files,
              sourceDigest: yield* digestIntegration(files),
              sourceBasis: "integration-inputs" as const,
              profileId: runtime.profile.profileId,
            };
          }
          if (!assignment.startingSource) return yield* unavailable();
          const starting = yield* sources.read(assignment.startingSource.id);
          if (starting.source.sourceDigest !== assignment.startingSource.sourceDigest)
            return yield* unavailable();
          const revision = assignment.delivery?.revisions.find(
            (entry) => entry.id === assignment.delivery?.currentRevisionId,
          );
          const candidate =
            revision?.candidateId !== undefined
              ? yield* boundaries.readCandidate(revision.candidateId)
              : undefined;
          if (
            candidate &&
            (candidate.assignmentId !== assignment.id ||
              candidate.finalized?.sourceDigest !== revision?.candidateDigest)
          )
            return yield* unavailable();
          const final = candidate?.finalized;
          // A cancelled grant cannot be revived to capture its old writable volume.
          return {
            files: final?.files ?? starting.files,
            sourceDigest: final?.sourceDigest ?? starting.source.sourceDigest,
            sourceBasis: final ? ("final-candidate" as const) : ("starting-snapshot" as const),
            profileId:
              qualifiedProfileId ??
              state.workflowMigrations.findLast((entry) => entry.assignmentId === assignment.id)
                ?.previousProfileId,
          };
        });
        if (!source.profileId || !/^[a-f0-9-]{36}$/.test(source.profileId))
          return yield* unavailable();
        const original = yield* fs
          .readFileString(path.join(root, source.profileId, "profile.json"))
          .pipe(Effect.flatMap(decodeProfile));
        const staging = path.join(directory, `snapshot-${yield* crypto.randomUUIDv4}`);
        const projectSnapshotPath = path.join(staging, "project");
        const workflowSnapshotPath =
          original.workflow?.snapshotPath ?? path.join(staging, "workflow");
        yield* writeFiles(projectSnapshotPath, source.files);
        if (original.workflow === undefined)
          yield* copyWorkflow(original.workflowSnapshotPath, workflowSnapshotPath);
        profile = FactoryExecutionProfile.make({
          boundaryId: profileId,
          profileId,
          dockerContext: original.dockerContext,
          imageId: original.imageId,
          projectSnapshotPath,
          workflowSnapshotPath,
          ...(original.workflow === undefined ? {} : { workflow: original.workflow }),
          ...(original.requiresSkillAuthoring === undefined
            ? {}
            : { requiresSkillAuthoring: original.requiresSkillAuthoring }),
          runtimePath: path.join(directory, "sessions"),
          ...(assignment.startingSource
            ? {
                startingSourceId: assignment.startingSource.id,
                startingSourceDigest: assignment.startingSource.sourceDigest,
              }
            : {}),
          inspection: { sourceDigest: source.sourceDigest, evidencePath: sealed.directory },
          retro: { ...input, sourceBasis: source.sourceBasis, stopPath },
        });
        yield* fs.makeDirectory(path.join(profile.runtimePath, "codex"), { recursive: true });
        const proof = yield* runner.run({
          command: "docker",
          args: [
            ...factoryDockerArguments(profile),
            "--entrypoint",
            "node",
            profile.imageId,
            "-e",
            factoryExecutionProbe,
          ],
          timeout: "30 seconds",
        });
        if (proof.code !== 0 || proof.stdout.trim() !== "factory-boundary-ok")
          return yield* unavailable();
        yield* assertCurrent(input);
        if (yield* fs.exists(stopPath)) return yield* unavailable();
        yield* fs.writeFileString(profilePath, yield* encodeProfile(profile), { flag: "wx" });
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
    Effect.mapError((cause) => (isFactoryError(cause) ? cause : unavailable())),
  );
  const stop = Effect.fn("FactoryRetroExecution.stop")(
    function* ({ retroId }: { readonly retroId: string }) {
      const directory = path.join(root, yield* profileIdFor(retroId));
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "stopped.json"), "{}");
    },
    mutex.withPermit,
    Effect.mapError(unavailable),
  );
  return FactoryRetroExecution.of({ prepare, stop });
});

export const layer = Layer.effect(FactoryRetroExecution, make);
