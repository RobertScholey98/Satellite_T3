import {
  FactoryBoundary,
  FactoryIntegrationCapability,
  FactoryIntegrationGrant,
  FactoryIntegrationManifest,
  FactoryIntegrationTestArtifact,
  FactoryError,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FactorySourceFile } from "./FactorySource.ts";
import { FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";
import { factoryProtectedPath, factoryRelativePath } from "./FactoryBoundaryPaths.ts";

/** What qualification saw; preparation holds participants' protected files to `files`. */
export const IntegrationCapabilityArtifact = Schema.Struct({
  capability: FactoryIntegrationCapability,
  boundary: FactoryBoundary,
  profile: FactoryExecutionProfile,
  files: Schema.Array(FactorySourceFile),
  configurationDigest: Schema.String,
  coordinatorDigest: Schema.NullOr(Schema.String),
});
/**
 * One participant in a prepared runtime. `alias` is a digest-derived directory name under
 * `participants/`, so project ids never appear as paths. `files` are the readable input files
 * before any integration test work.
 */
export const IntegrationProjectArtifact = Schema.Struct({
  alias: Schema.String,
  grant: FactoryIntegrationGrant,
  capability: IntegrationCapabilityArtifact,
  files: Schema.Array(FactorySourceFile),
});
/**
 * A preparation's runtime record. Written as `request.json` before containers start and as
 * `runtime.json` once ready; `initialTestArtifact` is a placeholder until then.
 */
export const IntegrationRuntimeArtifact = Schema.Struct({
  integrationId: Schema.String,
  preparationId: Schema.String,
  profile: FactoryExecutionProfile,
  manifest: FactoryIntegrationManifest,
  projects: Schema.Array(IntegrationProjectArtifact),
  initialTestArtifact: FactoryIntegrationTestArtifact,
});
export type IntegrationRuntimeArtifact = typeof IntegrationRuntimeArtifact.Type;
/** The manifest a team thread's runtime is admitted against, kept beside its profile. */
export const IntegrationAdmissionArtifact = Schema.Struct({
  profileId: Schema.String,
  assignmentId: Schema.String,
  integrationId: Schema.String,
  preparationId: Schema.String,
  manifest: FactoryIntegrationManifest,
});
export const IntegrationPatchArtifact = Schema.Struct({
  id: Schema.String,
  preparationId: Schema.String,
  projectId: FactoryIntegrationGrant.fields.projectId,
  grantId: Schema.String,
  files: Schema.Array(FactorySourceFile),
  deletedPaths: Schema.Array(Schema.String),
});
export type IntegrationPatchArtifact = typeof IntegrationPatchArtifact.Type;
/** SHA-256 hex over a stable JSON encoding, so key order never changes a digest. */
export const integrationDigest = (value: unknown) =>
  Crypto.Crypto.use((crypto) =>
    crypto
      .digest("SHA-256", Buffer.from(stableStringify(value)))
      .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex"))),
  );
/** A deterministic UUID-shaped id for profile directories and helper journal entries. */
export const integrationId = (value: string) =>
  integrationDigest(value).pipe(
    Effect.map(
      (id) =>
        `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`,
    ),
  );
export const integrationError = (detail: string) =>
  new FactoryError({ code: "execution-unavailable", detail });
export const integrationReadable = (name: string, grant: FactoryIntegrationGrant["paths"]) =>
  grant.readPaths.some((root) => root === "." || name === root || name.startsWith(`${root}/`));
/**
 * Whether integration work may change this path: granted as a test or fixture file or under a
 * granted directory, and never protected by the factory or the project's boundary.
 */
export const integrationWritable = (
  name: string,
  grant: FactoryIntegrationGrant["paths"],
  boundary: FactoryBoundary,
) =>
  factoryRelativePath(name) &&
  !factoryProtectedPath(name) &&
  !boundary.protectedPaths.some((path) => name === path || name.startsWith(`${path}/`)) &&
  (grant.testPaths.includes(name) ||
    grant.fixturePaths.includes(name) ||
    [...grant.testDirectories, ...grant.fixtureDirectories].some((root) =>
      name.startsWith(`${root}/`),
    ));
export const integrationValidateFiles = Effect.fn(function* (files: readonly FactorySourceFile[]) {
  const crypto = yield* Crypto.Crypto;
  const seen = new Set<string>();
  for (const file of files) {
    const bytes = Buffer.from(file.content, "base64");
    if (
      !factoryRelativePath(file.path) ||
      seen.has(file.path.toLowerCase()) ||
      bytes.toString("base64") !== file.content ||
      bytes.length > 16 * 1024 * 1024 ||
      Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex") !== file.digest
    )
      return yield* integrationError(
        "Integration input contains an unsafe path or mismatched file bytes.",
      );
    seen.add(file.path.toLowerCase());
  }
  if (files.reduce((sum, file) => sum + file.content.length, 0) > 350 * 1024 * 1024)
    return yield* integrationError("The integration input exceeds the bounded snapshot size.");
});
/**
 * Reads every file under a directory, sorted by path. Symlinks, hard links and special entries
 * fail the read rather than being skipped, so a snapshot can never point outside itself.
 */
export const integrationInventory = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const result: FactorySourceFile[] = [];
  const pending = [""];
  while (pending.length) {
    const prefix = pending.pop()!;
    for (const name of yield* fs.readDirectory(path.join(directory, prefix))) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const target = path.join(directory, relative);
      if (
        !factoryRelativePath(relative) ||
        path.relative(directory, yield* fs.realPath(target)) !== relative.split("/").join(path.sep)
      )
        return yield* integrationError(
          "Integration sources must be regular private files without symlinks.",
        );
      const stat = yield* fs.stat(target);
      if (stat.type === "Directory") pending.push(relative);
      else if (stat.type === "File" && Option.getOrElse(stat.nlink, () => 2) <= 1) {
        const bytes = yield* fs.readFile(target);
        result.push({
          path: relative,
          content: Buffer.from(bytes).toString("base64"),
          digest: Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex"),
          mode: stat.mode & 0o111 ? "100755" : "100644",
        });
      } else
        return yield* integrationError(
          "Integration sources cannot contain linked or special entries.",
        );
    }
  }
  result.sort((a, b) => a.path.localeCompare(b.path));
  yield* integrationValidateFiles(result);
  return result;
});

/**
 * Checks that a runtime read from disk is internally consistent: the profile names this
 * preparation, the manifest digest matches its fields, and each project matches its input,
 * grant and capability. It does not check that the inputs are still current.
 */
export const assertIntegrationRuntimeIdentity = Effect.fn(function* (
  runtime: IntegrationRuntimeArtifact,
) {
  const { inputDigest, ...fields } = runtime.manifest;
  const identity = runtime.profile.integration;
  if (
    !identity ||
    identity.integrationId !== runtime.integrationId ||
    identity.preparationId !== runtime.preparationId ||
    identity.inputDigest !== inputDigest ||
    (yield* integrationDigest(fields)) !== inputDigest ||
    runtime.projects.length !== runtime.manifest.inputs.length ||
    new Set(runtime.projects.map((entry) => entry.alias)).size !== runtime.projects.length
  )
    return yield* integrationError(
      "The integration profile does not match its immutable input manifest.",
    );
  for (const project of runtime.projects) {
    const input = runtime.manifest.inputs.find(
      (entry) => entry.projectId === project.grant.projectId,
    );
    if (
      !input ||
      !/^project-[a-f0-9]{16}$/.test(project.alias) ||
      input.integrationGrantId !== project.grant.id ||
      !identity.grantIds.includes(project.grant.id) ||
      input.capabilityId !== project.capability.capability.id
    )
      return yield* integrationError(
        "An integration participant no longer matches its runtime grant.",
      );
    yield* integrationValidateFiles(project.files);
  }
});
