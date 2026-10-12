import { FactoryError, FactoryWorkflowVersion, isFactoryError } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as FactorySource from "./FactorySource.ts";
import {
  FactoryWorkflowSnapshot,
  type FactoryExecutionProfile,
} from "./FactoryExecutionProfile.ts";
import { factoryRelativePath } from "./FactoryBoundaryPaths.ts";

const Manifest = Schema.Struct({
  version: FactoryWorkflowVersion,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      digest: Schema.String,
      mode: Schema.Literals(["100644", "100755"]),
    }),
  ),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest));
const encodePaths = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const unavailable = (detail: string) => new FactoryError({ code: "execution-unavailable", detail });
const preserve = (cause: unknown) =>
  isFactoryError(cause)
    ? cause
    : unavailable("The pinned workflow snapshot could not be verified.");
const authoringPaths = [
  "skills/writing-for-agents/SKILL.md",
  "skills/writing-for-agents/SKILL-MECHANICS.md",
];

/**
 * Owns the host's read-only workflow snapshots under the state directory, one directory per
 * content digest. Execution profiles mount them read-only at `/workflow`, so a team runs with
 * exactly the committed files of its pinned version.
 */
export class FactoryWorkflowExecution extends Context.Service<
  FactoryWorkflowExecution,
  {
    /**
     * Materializes a committed revision as a read-only snapshot, or reuses the one already on
     * disk, then verifies it. Fails when a partial snapshot from an interrupted write differs.
     */
    readonly snapshot: (input: {
      readonly version: FactoryWorkflowVersion;
      readonly requireSkillAuthoring?: boolean;
    }) => Effect.Effect<FactoryWorkflowSnapshot, FactoryError>;
    /**
     * Rechecks a snapshot against its manifest: identity, inventory and every file digest.
     * `requireSkillAuthoring` also demands the skill-authoring instructions that skill work needs.
     */
    readonly verify: (input: {
      readonly snapshot: FactoryWorkflowSnapshot;
      readonly expectedVersion: FactoryWorkflowVersion;
      readonly requireSkillAuthoring?: boolean;
    }) => Effect.Effect<void, FactoryError>;
    /**
     * The verified snapshot behind an execution profile. A legacy profile without a recorded
     * snapshot is accepted only when its files match the commit exactly, apart from an unchanged
     * `SATELLITE_DISCOVERY.md`.
     */
    readonly resolve: (input: {
      readonly profile: FactoryExecutionProfile;
      readonly expectedVersion: FactoryWorkflowVersion;
      readonly requireSkillAuthoring?: boolean;
    }) => Effect.Effect<FactoryWorkflowSnapshot, FactoryError>;
  }
>()("t3/factory/FactoryWorkflowExecution") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const sources = yield* FactorySource.FactorySource;
  const config = yield* ServerConfig.ServerConfig;
  const mutex = yield* Semaphore.make(1);
  const root = path.join(config.stateDir, "factory", "workflows");
  const digest = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
  const identity = (manifest: typeof Manifest.Type) =>
    digest(Buffer.from(stableStringify(manifest)));
  // Lists regular files only. Any link, or a path whose real location differs, fails the
  // snapshot rather than letting it point outside its directory.
  const inventory = Effect.fn(function* (directory: string) {
    const found: string[] = [];
    const visit = Effect.fn(function* (
      relative: string,
    ): Effect.fn.Return<void, FactoryError | import("effect/PlatformError").PlatformError> {
      for (const name of yield* fs.readDirectory(path.join(directory, relative))) {
        const child = relative ? `${relative}/${name}` : name;
        const absolute = path.join(directory, child);
        if (
          !factoryRelativePath(child) ||
          path.relative(directory, yield* fs.realPath(absolute)) !== child.split("/").join(path.sep)
        )
          return yield* unavailable(
            "Workflow snapshots contain only safe regular files and directories.",
          );
        const stat = yield* fs.stat(absolute);
        if (stat.type === "Directory") yield* visit(child);
        else if (stat.type === "File") found.push(child);
        else return yield* unavailable("Workflow snapshot entries must be regular files.");
      }
    });
    yield* visit("");
    return found;
  });
  const verify = Effect.fn("FactoryWorkflowExecution.verify")(function* (
    input: Parameters<FactoryWorkflowExecution["Service"]["verify"]>[0],
  ) {
    const snapshot = input.snapshot;
    const directory = path.join(root, snapshot.digest);
    if (
      !/^[a-f0-9]{64}$/.test(snapshot.digest) ||
      stableStringify(snapshot.version) !== stableStringify(input.expectedVersion) ||
      snapshot.snapshotPath !== path.join(directory, "source") ||
      snapshot.manifestPath !== path.join(directory, "manifest.json")
    )
      return yield* unavailable("This runtime does not identify the assignment's pinned workflow.");
    const manifest = yield* fs
      .readFileString(snapshot.manifestPath)
      .pipe(Effect.flatMap(decodeManifest));
    if (
      stableStringify(manifest.version) !== stableStringify(input.expectedVersion) ||
      (yield* identity(manifest)) !== snapshot.digest
    )
      return yield* unavailable("The workflow identity manifest changed.");
    const names = new Set(manifest.files.map((file) => file.path));
    if (
      !manifest.files.some((file) => file.path.startsWith("skills/")) ||
      (input.requireSkillAuthoring && authoringPaths.some((name) => !names.has(name)))
    )
      return yield* unavailable(
        "Skill work requires writing-for-agents and SKILL-MECHANICS.md in the approved workflow baseline.",
      );
    const found = yield* inventory(snapshot.snapshotPath);
    if (found.length !== names.size || found.some((name) => !names.has(name)))
      return yield* unavailable("The workflow snapshot inventory changed.");
    for (const file of manifest.files) {
      if (
        !factoryRelativePath(file.path) ||
        (yield* digest(yield* fs.readFile(path.join(snapshot.snapshotPath, file.path)))) !==
          file.digest
      )
        return yield* unavailable("Pinned workflow file contents changed.");
    }
  }, Effect.mapError(preserve));
  const snapshot = Effect.fn("FactoryWorkflowExecution.snapshot")(
    function* (input: Parameters<FactoryWorkflowExecution["Service"]["snapshot"]>[0]) {
      const source = yield* sources.readRevision(
        input.version.repositoryRoot,
        input.version.revision,
      );
      const files = source.files.toSorted((left, right) => left.path.localeCompare(right.path));
      const manifest = {
        version: input.version,
        files: files.map(({ path, digest, mode }) => ({ path, digest, mode })),
      };
      const key = yield* identity(manifest);
      const directory = path.join(root, key);
      const result = {
        version: input.version,
        digest: key,
        snapshotPath: path.join(directory, "source"),
        manifestPath: path.join(directory, "manifest.json"),
      };
      // The manifest is written last, so its presence marks a complete snapshot.
      if (!(yield* fs.exists(result.manifestPath))) {
        yield* fs.makeDirectory(result.snapshotPath, { recursive: true });
        const names = new Set<string>();
        for (const file of files) {
          const bytes = Buffer.from(file.content, "base64");
          if (
            !factoryRelativePath(file.path) ||
            names.has(file.path.toLowerCase()) ||
            (yield* digest(bytes)) !== file.digest
          )
            return yield* unavailable("The committed workflow contains an invalid source entry.");
          names.add(file.path.toLowerCase());
          const target = path.join(result.snapshotPath, file.path);
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          if (yield* fs.exists(target)) {
            if ((yield* digest(yield* fs.readFile(target))) !== file.digest)
              return yield* unavailable(
                "An interrupted workflow snapshot contains changed files. Requalify its storage before continuing.",
              );
          } else yield* fs.writeFile(target, bytes);
          yield* fs.chmod(target, file.mode === "100755" ? 0o555 : 0o444);
        }
        yield* fs.writeFileString(result.manifestPath, yield* encodeManifest(manifest));
      }
      yield* verify({
        snapshot: result,
        expectedVersion: input.version,
        ...(input.requireSkillAuthoring ? { requireSkillAuthoring: true } : {}),
      });
      return result;
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  const resolve = Effect.fn("FactoryWorkflowExecution.resolve")(function* (
    input: Parameters<FactoryWorkflowExecution["Service"]["resolve"]>[0],
  ) {
    if (input.profile.workflow !== undefined) {
      if (input.profile.workflowSnapshotPath !== input.profile.workflow.snapshotPath)
        return yield* unavailable("The runtime workflow mount does not match its identity.");
      yield* verify({ ...input, snapshot: input.profile.workflow });
      return input.profile.workflow;
    }
    const verified = yield* snapshot({
      version: input.expectedVersion,
      ...(input.requireSkillAuthoring ? { requireSkillAuthoring: true } : {}),
    });
    const manifest = yield* fs
      .readFileString(verified.manifestPath)
      .pipe(Effect.flatMap(decodeManifest));
    const names = yield* inventory(input.profile.workflowSnapshotPath);
    const expected = new Set(manifest.files.map((file) => file.path));
    for (const file of manifest.files)
      if (
        !names.includes(file.path) ||
        (yield* digest(
          yield* fs.readFile(path.join(input.profile.workflowSnapshotPath, file.path)),
        )) !== file.digest
      )
        return yield* unavailable(
          "Legacy workflow files differ from the recorded commit. Requalify this runtime before continuing.",
        );
    const extra = names.filter((name) => !expected.has(name));
    if (extra.some((name) => name !== "SATELLITE_DISCOVERY.md"))
      return yield* unavailable("Legacy workflow contains files outside its recorded commit.");
    if (extra.length) {
      const source = yield* sources.readRevision(
        input.expectedVersion.repositoryRoot,
        input.expectedVersion.revision,
      );
      const metadata = [
        `Read-only tracked-file snapshot at ${input.expectedVersion.revision}.`,
        "Untracked files, credentials, and environment files are omitted. Links and unsupported entries prevent capture.",
        "Source files may contain application configuration. No host credential directories are mounted.",
        "This snapshot has no Git metadata. Report findings through the scoped Satellite tools.",
        `Omitted entries: ${encodePaths(source.excludedPaths)}`,
      ].join("\n");
      if (
        (yield* fs.readFileString(
          path.join(input.profile.workflowSnapshotPath, "SATELLITE_DISCOVERY.md"),
        )) !== metadata
      )
        return yield* unavailable("Legacy workflow metadata changed. Requalify before continuing.");
    }
    return verified;
  }, Effect.mapError(preserve));
  return FactoryWorkflowExecution.of({ snapshot, verify, resolve });
});
export const layer = Layer.effect(FactoryWorkflowExecution, make);
