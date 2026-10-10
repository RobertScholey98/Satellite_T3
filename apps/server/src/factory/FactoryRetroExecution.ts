import {
  FactoryError,
  type FactoryAssignmentId,
  type FactoryRetroQualification,
  type ThreadId,
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
const isFactoryError = Schema.is(FactoryError);
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
        if (
          assignment.qualification?.status !== "qualified" ||
          !/^[a-f0-9-]{36}$/.test(assignment.qualification.profileId) ||
          !assignment.startingSource
        )
          return yield* unavailable();
        const original = yield* fs
          .readFileString(path.join(root, assignment.qualification.profileId, "profile.json"))
          .pipe(Effect.flatMap(decodeProfile));
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
        const sourceDigest = final?.sourceDigest ?? starting.source.sourceDigest;
        // A cancelled grant cannot be revived to capture its old writable volume.
        const sourceBasis = final ? "final-candidate" : "starting-snapshot";
        const staging = path.join(directory, `snapshot-${yield* crypto.randomUUIDv4}`);
        const projectSnapshotPath = path.join(staging, "project");
        const workflowSnapshotPath = path.join(staging, "workflow");
        yield* writeFiles(projectSnapshotPath, final?.files ?? starting.files);
        yield* copyWorkflow(original.workflowSnapshotPath, workflowSnapshotPath);
        profile = FactoryExecutionProfile.make({
          boundaryId: profileId,
          profileId,
          dockerContext: original.dockerContext,
          imageId: original.imageId,
          projectSnapshotPath,
          workflowSnapshotPath,
          runtimePath: path.join(directory, "sessions"),
          startingSourceId: assignment.startingSource.id,
          startingSourceDigest: assignment.startingSource.sourceDigest,
          inspection: { sourceDigest, evidencePath: sealed.directory },
          retro: { ...input, sourceBasis, stopPath },
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
