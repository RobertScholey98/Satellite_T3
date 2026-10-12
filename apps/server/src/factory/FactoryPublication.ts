import {
  FactoryAssignmentGrant,
  FactoryAssignmentId,
  FactoryBoundaryConfiguration,
  FactoryBoundaryId,
  FactorySourceId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitHubCredentials from "../sourceControl/GitHubCredentials.ts";
import {
  factoryCanWrite,
  factoryRelativePath,
  factorySafeRelativePath,
} from "./FactoryBoundaryPaths.ts";
import * as FactorySource from "./FactorySource.ts";

const Identity = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  timestamp: Schema.String,
});
export const FactoryPublicationDestination = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local"), repositoryPath: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("github"),
    host: Schema.String,
    owner: Schema.String,
    repository: Schema.String,
    credentialFingerprint: Schema.String,
  }),
]);
/**
 * Fixes a publication before any Git work. `parentCommit` is the commit to build on and
 * `expectedTip` the remote branch tip the push may replace (`null` for a new branch). A later
 * revision sets `previousReservationId` and builds on that reservation's commit.
 */
export const FactoryPublicationReservation = Schema.Struct({
  id: Schema.String,
  assignmentId: FactoryAssignmentId,
  sourceId: FactorySourceId,
  boundaryId: FactoryBoundaryId,
  epoch: Schema.Int,
  parentCommit: Schema.String,
  previousReservationId: Schema.optionalKey(Schema.String),
  destination: FactoryPublicationDestination,
  branch: Schema.String,
  baseBranch: Schema.String,
  expectedTip: Schema.NullOr(Schema.String),
  author: Identity,
  committer: Identity,
  message: Schema.String,
});
export type FactoryPublicationReservation = typeof FactoryPublicationReservation.Type;
export const FactoryPublicationCandidate = Schema.Struct({
  id: Schema.String,
  sourceDigest: Schema.String,
  files: Schema.Array(FactorySource.FactorySourceFile),
  deletedPaths: Schema.Array(Schema.String),
  selectedPaths: Schema.Array(Schema.String),
  grant: FactoryAssignmentGrant,
  configuration: FactoryBoundaryConfiguration,
});
export type FactoryPublicationCandidate = typeof FactoryPublicationCandidate.Type;
/**
 * The private commit built for a reservation. `publishedSourceDigest` covers the whole committed
 * tree; finalization adopts it as the candidate digest, so verification and review see exactly
 * what is pushed.
 */
export const FactoryPublicationPrepared = Schema.Struct({
  reservationId: Schema.String,
  candidateId: Schema.String,
  candidateDigest: Schema.String,
  startingIndexTreeOid: Schema.String,
  startingWorkTreeOid: Schema.String,
  treeOid: Schema.String,
  commitOid: Schema.String,
  publishedSourceDigest: Schema.String,
  selectedPaths: Schema.Array(Schema.String),
});
export type FactoryPublicationPrepared = typeof FactoryPublicationPrepared.Type;
const Artifact = Schema.Struct({
  reservation: FactoryPublicationReservation,
  candidate: FactoryPublicationCandidate,
  prepared: FactoryPublicationPrepared,
  publishedFiles: Schema.Array(FactorySource.FactorySourceFile),
});
export type FactoryPublicationArtifact = typeof Artifact.Type;
/**
 * What the remote branch shows. `confirmed`: it is at the prepared commit. `conflict`: it moved
 * somewhere the reservation did not expect. `unknown`: it is still at the expected tip, or could
 * not be read.
 */
export const FactoryPublicationObservation = Schema.Struct({
  status: Schema.Literals(["confirmed", "conflict", "unknown"]),
  remoteTip: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type FactoryPublicationObservation = typeof FactoryPublicationObservation.Type;

export class FactoryPublicationError extends Schema.TaggedError<FactoryPublicationError>()(
  "FactoryPublicationError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "reservation-conflict",
      "source-invalid",
      "git-failed",
      "unsupported-transport",
      "credential-changed",
      "persistence",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-input":
        return "The publication candidate or reservation is invalid.";
      case "reservation-conflict":
        return "This publication reservation already identifies different work.";
      case "source-invalid":
        return "The pinned publication source is unavailable or inconsistent.";
      case "git-failed":
        return "The private Git publication operation failed.";
      case "unsupported-transport":
        return "This publication destination has no qualified Git transport.";
      case "credential-changed":
        return "The approved publication account has changed. Reauthorize this destination.";
      case "persistence":
        return "The private publication artifact could not be stored or read.";
    }
  }
}

/**
 * Builds delivery commits in a private bare repository per reservation under the state
 * directory, and pushes them. Git runs without system or global config, hooks, signing or
 * credential helpers, so the user's environment cannot change the commit or see the token.
 * `FactoryPublicationHost` chooses reservations; the boundary and preview publication read the
 * stored artifacts.
 */
export class FactoryPublication extends Context.Service<
  FactoryPublication,
  {
    /**
     * Builds the commit for a reservation. Idempotent: the same input returns the stored result,
     * and different input under the same id is a `reservation-conflict`. Refuses a candidate that
     * changes or deletes a file its grant cannot write.
     */
    readonly prepare: (input: {
      readonly reservation: FactoryPublicationReservation;
      readonly candidate: FactoryPublicationCandidate;
    }) => Effect.Effect<FactoryPublicationPrepared, FactoryPublicationError>;
    readonly read: (
      reservationId: string,
    ) => Effect.Effect<FactoryPublicationArtifact, FactoryPublicationError>;
    /** Reads the remote branch without writing. An unreadable remote is reported as `unknown`. */
    readonly inspect: (
      reservationId: string,
    ) => Effect.Effect<FactoryPublicationObservation, FactoryPublicationError>;
    /**
     * Pushes the prepared commit when the remote is still at the expected tip and the push is a
     * fast-forward, leased on that tip, and reports what the remote shows afterwards. It never
     * overwrites unexpected remote work. `beforeWrite` runs immediately before the push.
     */
    readonly push: (input: {
      readonly reservationId: string;
      readonly beforeWrite?: Effect.Effect<void, FactoryPublicationError>;
    }) => Effect.Effect<FactoryPublicationObservation, FactoryPublicationError>;
  }
>()("t3/factory/FactoryPublication") {}

const ReservationInput = Schema.Struct({
  reservation: FactoryPublicationReservation,
  candidate: FactoryPublicationCandidate,
});
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(ReservationInput));
const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(ReservationInput));
const encodeArtifact = Schema.encodeEffect(Schema.fromJsonString(Artifact));
const decodeArtifact = Schema.decodeUnknownEffect(Schema.fromJsonString(Artifact));
const isPublicationError = Schema.is(FactoryPublicationError);
const preserve = (cause: unknown) =>
  isPublicationError(cause) ? cause : new FactoryPublicationError({ reason: "persistence", cause });
const validOid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const MAX_BYTES = 256 * 1024 * 1024;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const sources = yield* FactorySource.FactorySource;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const platform = yield* HostProcessPlatform;
  const mutex = yield* Semaphore.make(1);
  const root = path.join(config.stateDir, "factory", "publications");
  const digest = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
  const manifestDigest = (files: ReadonlyArray<FactorySource.FactorySourceFile>) =>
    digest(
      Buffer.from(
        JSON.stringify(files.map(({ path: name, digest, mode }) => ({ path: name, digest, mode }))),
      ),
    );
  const location = (id: string) =>
    digest(Buffer.from(id)).pipe(Effect.map((value) => path.join(root, value)));
  const environment = (repository: string) => ({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_PARAMETERS: "",
    GIT_CONFIG: undefined,
    GIT_DIR: repository,
    GIT_COMMON_DIR: repository,
    GIT_WORK_TREE: undefined,
    GIT_NAMESPACE: undefined,
    GIT_SHALLOW_FILE: undefined,
    GIT_GRAFT_FILE: undefined,
    GIT_QUARANTINE_PATH: undefined,
    GIT_OBJECT_DIRECTORY: path.join(repository, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
    GIT_INDEX_FILE: path.join(repository, "unused-index"),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_SSL_NO_VERIFY: undefined,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_TEMPLATE_DIR: "",
    GIT_CONFIG_SYSTEM: platform === "win32" ? "NUL" : "/dev/null",
    GIT_TRACE: "0",
    GIT_TRACE_PACKET: "0",
    GIT_TRACE_CURL: "0",
    GIT_CURL_VERBOSE: "0",
    GIT_TRACE2: "0",
    GIT_TRACE2_EVENT: "0",
    GIT_TRACE2_PERF: "0",
  });
  const git = Effect.fn("FactoryPublication.git")(function* (
    repository: string,
    args: ReadonlyArray<string>,
    options: {
      readonly stdin?: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly binary?: boolean;
      readonly allowFailure?: boolean;
    } = {},
  ) {
    const chunks: Array<Uint8Array> = [];
    let count = 0;
    const result = yield* runner
      .run({
        command: "git",
        args: [
          `--git-dir=${repository}`,
          "-c",
          "core.hooksPath=",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "tag.gpgSign=false",
          "-c",
          "credential.helper=",
          "-c",
          "http.followRedirects=false",
          ...args,
        ],
        cwd: root,
        env: { ...environment(repository), ...options.env },
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        maxOutputBytes: MAX_BYTES,
        outputMode: "error",
        timeout: 120_000,
        ...(options.binary
          ? {
              onStdoutChunk: (chunk: Uint8Array) => {
                count += chunk.length;
                if (count <= MAX_BYTES) chunks.push(Buffer.from(chunk));
              },
            }
          : {}),
      })
      .pipe(
        Effect.mapError((cause) => new FactoryPublicationError({ reason: "git-failed", cause })),
      );
    if ((!options.allowFailure && result.code !== 0) || result.stdoutTruncated || count > MAX_BYTES)
      return yield* new FactoryPublicationError({
        reason: "git-failed",
        cause: { code: result.code, stderr: result.stderr },
      });
    return { ...result, bytes: Buffer.concat(chunks), value: result.stdout.trim() };
  });
  const read = Effect.fn("FactoryPublication.read")(function* (id: string) {
    const directory = yield* location(id);
    return yield* fs
      .readFileString(path.join(directory, "artifact.json"))
      .pipe(Effect.flatMap(decodeArtifact));
  }, Effect.mapError(preserve));
  const writeArtifact = Effect.fn(function* (
    directory: string,
    artifact: FactoryPublicationArtifact,
  ) {
    const temporary = path.join(directory, "artifact.pending.json");
    yield* fs.writeFileString(temporary, yield* encodeArtifact(artifact));
    yield* fs.rename(temporary, path.join(directory, "artifact.json"));
  });
  // Duplicate paths are refused case-insensitively, and content must be canonical base64 that
  // matches its digest.
  const validateFiles = Effect.fn(function* (
    files: ReadonlyArray<FactorySource.FactorySourceFile>,
  ) {
    const seen = new Set<string>();
    let bytesTotal = 0;
    for (const file of files) {
      const bytes = Buffer.from(file.content, "base64");
      bytesTotal += bytes.length;
      if (
        !factoryRelativePath(file.path) ||
        seen.has(file.path.toLowerCase()) ||
        bytes.toString("base64") !== file.content ||
        bytes.length > 16 * 1024 * 1024 ||
        bytesTotal > MAX_BYTES ||
        (file.mode !== "100644" && file.mode !== "100755") ||
        (yield* digest(bytes)) !== file.digest
      )
        return yield* new FactoryPublicationError({ reason: "invalid-input" });
      seen.add(file.path.toLowerCase());
    }
  });
  // Copies the objects reachable from `revision` into the private repository as a pack, so it
  // never borrows another object store through alternates.
  const importObjects = Effect.fn(function* (
    repository: string,
    objectDirectory: string,
    revision: string,
  ) {
    const packed = yield* git(repository, ["pack-objects", "--stdout", "--revs"], {
      stdin: `${revision}\n`,
      env: { GIT_OBJECT_DIRECTORY: objectDirectory },
      binary: true,
    });
    const temporary = yield* fs.makeTempDirectoryScoped({ directory: path.dirname(repository) });
    const packFile = path.join(temporary, "import.pack");
    yield* fs.writeFile(packFile, packed.bytes);
    const indexed = yield* git(repository, ["index-pack", packFile]);
    if (!validOid(indexed.value))
      return yield* new FactoryPublicationError({ reason: "git-failed" });
    const destination = path.join(repository, "objects", "pack", `pack-${indexed.value}`);
    if (!(yield* fs.exists(`${destination}.pack`))) {
      yield* fs.rename(packFile, `${destination}.pack`);
    }
    if (!(yield* fs.exists(`${destination}.idx`))) {
      yield* fs.rename(path.join(temporary, "import.idx"), `${destination}.idx`);
    }
  });
  // The workspace's object directory, following a worktree's `.git` file to its common dir.
  const sourceObjects = Effect.fn(function* (workspaceRoot: string) {
    const workspace = yield* fs.realPath(workspaceRoot);
    const metadata = path.join(workspace, ".git");
    const info = yield* fs.stat(metadata);
    const gitDirectory =
      info.type === "Directory"
        ? metadata
        : path.resolve(
            workspace,
            /^gitdir: ([^\r\n]+)$/.exec((yield* fs.readFileString(metadata)).trim())?.[1] ?? "",
          );
    if (gitDirectory === workspace || (yield* fs.stat(gitDirectory)).type !== "Directory")
      return yield* new FactoryPublicationError({ reason: "source-invalid" });
    const commonFile = path.join(gitDirectory, "commondir");
    const common = (yield* fs.exists(commonFile))
      ? path.resolve(gitDirectory, (yield* fs.readFileString(commonFile)).trim())
      : gitDirectory;
    return path.join(common, "objects");
  });
  // Writes the tree of `base` with `files` replaced or added and `deletedPaths` removed, using a
  // throwaway index.
  const overlayTree = Effect.fn(function* (
    repository: string,
    base: string,
    files: ReadonlyArray<FactorySource.FactorySourceFile>,
    deletedPaths: ReadonlyArray<string>,
  ) {
    const temporary = yield* fs.makeTempDirectoryScoped({ directory: path.dirname(repository) });
    const env = { GIT_INDEX_FILE: path.join(temporary, "index") };
    yield* git(repository, ["read-tree", base], { env });
    const updates: Array<string> = [];
    const zero = "0".repeat(base.length);
    for (const name of deletedPaths) updates.push(`0 ${zero}\t${name}\0`);
    for (const file of files) {
      const blob = path.join(temporary, "blob");
      yield* fs.writeFile(blob, Buffer.from(file.content, "base64"));
      const hashed = yield* git(repository, ["hash-object", "-w", "--no-filters", blob]);
      updates.push(`${file.mode} ${hashed.value}\t${file.path}\0`);
    }
    if (updates.length > 0)
      yield* git(repository, ["update-index", "-z", "--index-info"], {
        env,
        stdin: updates.join(""),
      });
    return (yield* git(repository, ["write-tree"], { env })).value;
  });
  const prepare = Effect.fn("FactoryPublication.prepare")(
    function* (input: typeof ReservationInput.Type) {
      const { reservation, candidate } = input;
      if (
        !reservation.id ||
        !candidate.id ||
        !validOid(reservation.parentCommit) ||
        (reservation.expectedTip !== null && !validOid(reservation.expectedTip)) ||
        reservation.epoch < 0
      )
        return yield* new FactoryPublicationError({ reason: "invalid-input" });
      if (
        candidate.grant.boundaryId !== reservation.boundaryId ||
        candidate.grant.epoch !== reservation.epoch ||
        reservation.branch === reservation.baseBranch ||
        !reservation.branch ||
        !reservation.baseBranch ||
        !reservation.message.trim()
      )
        return yield* new FactoryPublicationError({ reason: "invalid-input" });
      for (const identity of [reservation.author, reservation.committer]) {
        if (
          !identity.name.trim() ||
          !identity.email.trim() ||
          /[<>\r\n\0]/.test(identity.name + identity.email) ||
          !/^\d+ [+-]\d{4}$/.test(identity.timestamp)
        )
          return yield* new FactoryPublicationError({ reason: "invalid-input" });
      }
      yield* validateFiles(candidate.files);
      if ((yield* manifestDigest(candidate.files)) !== candidate.sourceDigest)
        return yield* new FactoryPublicationError({ reason: "invalid-input" });
      const candidateFiles = new Map(candidate.files.map((file) => [file.path, file]));
      if (
        [...candidate.deletedPaths, ...candidate.selectedPaths].some(
          (name) => !factoryRelativePath(name),
        ) ||
        new Set(candidate.deletedPaths.map((name) => name.toLowerCase())).size !==
          candidate.deletedPaths.length ||
        new Set(candidate.selectedPaths.map((name) => name.toLowerCase())).size !==
          candidate.selectedPaths.length ||
        candidate.deletedPaths.some((name) => candidateFiles.has(name)) ||
        candidate.selectedPaths.length === 0 ||
        candidate.selectedPaths.some(
          (name) => !candidateFiles.has(name) && !candidate.deletedPaths.includes(name),
        )
      )
        return yield* new FactoryPublicationError({ reason: "invalid-input" });
      // The input is stored before any Git work, so a retry after a crash resumes the same
      // reservation and any other input under this id conflicts.
      const directory = yield* location(reservation.id);
      yield* fs.makeDirectory(directory, { recursive: true });
      const inputPath = path.join(directory, "reservation.json");
      if (yield* fs.exists(inputPath)) {
        const previous = yield* fs.readFileString(inputPath).pipe(Effect.flatMap(decodeInput));
        if (stableStringify(previous) !== stableStringify(input))
          return yield* new FactoryPublicationError({ reason: "reservation-conflict" });
        if (yield* fs.exists(path.join(directory, "artifact.json")))
          return (yield* read(reservation.id)).prepared;
      } else {
        const temporary = path.join(directory, "reservation.pending.json");
        yield* fs.writeFileString(temporary, yield* encodeInput(input));
        yield* fs.rename(temporary, inputPath);
      }
      const source = yield* sources
        .read(reservation.sourceId)
        .pipe(
          Effect.mapError(
            (cause) => new FactoryPublicationError({ reason: "source-invalid", cause }),
          ),
        );
      yield* validateFiles(source.files);
      yield* validateFiles(source.indexFiles);
      if (
        !validOid(source.source.revision) ||
        source.source.id !== reservation.sourceId ||
        source.source.deletedPaths.some((name) => !factoryRelativePath(name)) ||
        source.source.stagedPaths.some((name) => !factorySafeRelativePath(name))
      )
        return yield* new FactoryPublicationError({ reason: "source-invalid" });
      // The grant is rechecked against the starting source: every changed or added file must be
      // writable, and every starting file the candidate lacks must be a writable deletion.
      const startingFiles = new Map(source.files.map((file) => [file.path, file]));
      for (const file of candidate.files) {
        const before = startingFiles.get(file.path);
        if (
          (!before || before.digest !== file.digest || before.mode !== file.mode) &&
          !factoryCanWrite(file.path, candidate.grant, candidate.configuration)
        )
          return yield* new FactoryPublicationError({ reason: "invalid-input" });
      }
      for (const before of source.files) {
        if (
          !candidateFiles.has(before.path) &&
          (!candidate.deletedPaths.includes(before.path) ||
            !factoryCanWrite(before.path, candidate.grant, candidate.configuration))
        )
          return yield* new FactoryPublicationError({ reason: "invalid-input" });
      }
      if (
        candidate.deletedPaths.some(
          (name) => !startingFiles.has(name) && !source.source.deletedPaths.includes(name),
        )
      )
        return yield* new FactoryPublicationError({ reason: "invalid-input" });
      const repository = path.join(directory, "repository.git");
      yield* fs.makeDirectory(root, { recursive: true });
      if (!(yield* fs.exists(path.join(repository, "HEAD"))))
        yield* git(repository, [
          "init",
          "--bare",
          "--template=",
          `--object-format=${source.source.revision.length === 64 ? "sha256" : "sha1"}`,
          repository,
        ]);
      for (const branch of [reservation.branch, reservation.baseBranch])
        yield* git(repository, ["check-ref-format", `refs/heads/${branch}`]);
      if (
        (yield* git(repository, ["cat-file", "-e", `${source.source.revision}^{commit}`], {
          allowFailure: true,
        })).code !== 0
      )
        yield* importObjects(
          repository,
          yield* sourceObjects(source.workspaceRoot),
          source.source.revision,
        );
      // A later revision stacks a new commit on the previous one's, on the same branch and
      // destination, so the pull request gains a commit instead of being rewritten.
      let previous: FactoryPublicationArtifact | undefined;
      if (reservation.previousReservationId !== undefined) {
        previous = yield* read(reservation.previousReservationId);
        if (
          previous.reservation.assignmentId !== reservation.assignmentId ||
          previous.reservation.sourceId !== reservation.sourceId ||
          previous.prepared.commitOid !== reservation.parentCommit ||
          previous.reservation.branch !== reservation.branch ||
          stableStringify(previous.reservation.destination) !==
            stableStringify(reservation.destination)
        )
          return yield* new FactoryPublicationError({ reason: "reservation-conflict" });
        yield* importObjects(
          repository,
          path.join(yield* location(previous.reservation.id), "repository.git", "objects"),
          previous.prepared.commitOid,
        );
      } else if (reservation.parentCommit !== source.source.revision)
        return yield* new FactoryPublicationError({ reason: "source-invalid" });
      const startingIndexTreeOid = yield* overlayTree(
        repository,
        source.source.revision,
        source.indexFiles,
        source.source.stagedPaths.filter(
          (name) =>
            !source.indexFiles.some((file) => file.path === name) &&
            !source.source.excludedPaths.includes(name),
        ),
      );
      const startingWorkTreeOid = yield* overlayTree(
        repository,
        source.source.revision,
        source.files,
        source.source.deletedPaths,
      );
      // Only the selected paths enter the commit; other candidate changes stay unpublished.
      const selected = new Set(candidate.selectedPaths);
      const treeOid = yield* overlayTree(
        repository,
        reservation.parentCommit,
        candidate.files.filter((file) => selected.has(file.path)),
        candidate.deletedPaths.filter((name) => selected.has(name)),
      );
      const commit = yield* git(
        repository,
        ["commit-tree", treeOid, "-p", reservation.parentCommit],
        {
          stdin: reservation.message,
          env: {
            GIT_AUTHOR_NAME: reservation.author.name,
            GIT_AUTHOR_EMAIL: reservation.author.email,
            GIT_AUTHOR_DATE: reservation.author.timestamp,
            GIT_COMMITTER_NAME: reservation.committer.name,
            GIT_COMMITTER_EMAIL: reservation.committer.email,
            GIT_COMMITTER_DATE: reservation.committer.timestamp,
          },
        },
      );
      // The published manifest is read back from the committed tree, less the source's excluded
      // paths, so its digest describes the commit rather than the request.
      const publishedFiles: Array<FactorySource.FactorySourceFile> = [];
      const listing = (yield* git(repository, ["ls-tree", "-rz", "--full-tree", treeOid], {
        binary: true,
      })).bytes.toString("utf8");
      for (const entry of listing.split("\0").filter(Boolean)) {
        const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
        if (
          !match ||
          !factoryRelativePath(match[3]!) ||
          source.source.excludedPaths.includes(match[3]!)
        )
          continue;
        const bytes = (yield* git(repository, ["cat-file", "blob", match[2]!], { binary: true }))
          .bytes;
        publishedFiles.push({
          path: match[3]!,
          mode: match[1] === "100755" ? "100755" : "100644",
          content: bytes.toString("base64"),
          digest: yield* digest(bytes),
        });
      }
      publishedFiles.sort((left, right) => {
        const leftParts = left.path.split("/");
        const rightParts = right.path.split("/");
        for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
          if (leftParts[index]! < rightParts[index]!) return -1;
          if (leftParts[index]! > rightParts[index]!) return 1;
        }
        return leftParts.length - rightParts.length;
      });
      const prepared = FactoryPublicationPrepared.make({
        reservationId: reservation.id,
        candidateId: candidate.id,
        candidateDigest: candidate.sourceDigest,
        startingIndexTreeOid,
        startingWorkTreeOid,
        treeOid,
        commitOid: commit.value,
        publishedSourceDigest: yield* manifestDigest(publishedFiles),
        selectedPaths: candidate.selectedPaths,
      });
      yield* writeArtifact(directory, { reservation, candidate, prepared, publishedFiles });
      return prepared;
    },
    Effect.scoped,
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  const transport = Effect.fn(function* (reservation: FactoryPublicationReservation) {
    const destination = reservation.destination;
    if (destination.kind === "local") {
      if (
        !path.isAbsolute(destination.repositoryPath) ||
        /[\0\r\n]/.test(destination.repositoryPath)
      )
        return yield* new FactoryPublicationError({ reason: "unsupported-transport" });
      return {
        remote: destination.repositoryPath,
        env: { GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_COUNT: "0" },
      };
    }
    if (
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(destination.host) ||
      !/^[A-Za-z0-9_.-]+$/.test(destination.owner) ||
      !/^[A-Za-z0-9_.-]+$/.test(destination.repository) ||
      destination.owner === "." ||
      destination.owner === ".." ||
      destination.repository === "." ||
      destination.repository === ".."
    )
      return yield* new FactoryPublicationError({ reason: "unsupported-transport" });
    // The token travels as a header scoped to this remote through the command's environment,
    // never in a URL or a config file.
    const credential = yield* credentials
      .get(destination.host)
      .pipe(
        Effect.mapError(
          (cause) => new FactoryPublicationError({ reason: "unsupported-transport", cause }),
        ),
      );
    if (
      credential.host !== destination.host ||
      credential.fingerprint !== destination.credentialFingerprint
    )
      return yield* new FactoryPublicationError({ reason: "credential-changed" });
    const remote = `https://${destination.host}/${destination.owner}/${destination.repository}.git`;
    return {
      remote,
      env: {
        GIT_ALLOW_PROTOCOL: "https",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${remote}.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${Redacted.value(credential.token)}`).toString("base64")}`,
      },
    };
  });
  const remoteTip = Effect.fn(function* (
    artifact: FactoryPublicationArtifact,
    connection: Effect.Success<ReturnType<typeof transport>>,
  ) {
    const repository = path.join(yield* location(artifact.reservation.id), "repository.git");
    const result = yield* git(
      repository,
      ["ls-remote", "--refs", "--", connection.remote, `refs/heads/${artifact.reservation.branch}`],
      { env: connection.env },
    );
    if (!result.value) return null;
    const entries = result.value.split(/\r?\n/);
    const parts = entries[0]!.split("\t");
    if (
      entries.length !== 1 ||
      !validOid(parts[0] ?? "") ||
      parts[1] !== `refs/heads/${artifact.reservation.branch}`
    )
      return yield* new FactoryPublicationError({ reason: "git-failed" });
    return parts[0]!;
  });
  const observe = (artifact: FactoryPublicationArtifact, tip: string | null) =>
    FactoryPublicationObservation.make({
      status:
        tip === artifact.prepared.commitOid
          ? "confirmed"
          : tip !== artifact.reservation.expectedTip
            ? "conflict"
            : "unknown",
      remoteTip: tip,
    });
  const inspect = Effect.fn("FactoryPublication.inspect")(function* (id: string) {
    const artifact = yield* read(id);
    const connection = yield* transport(artifact.reservation);
    return yield* remoteTip(artifact, connection).pipe(
      Effect.map((tip) => observe(artifact, tip)),
      Effect.orElseSucceed(() => FactoryPublicationObservation.make({ status: "unknown" })),
    );
  }, Effect.mapError(preserve));
  const push = Effect.fn("FactoryPublication.push")(
    function* (input: {
      readonly reservationId: string;
      readonly beforeWrite?: Effect.Effect<void, FactoryPublicationError>;
    }) {
      const artifact = yield* read(input.reservationId);
      const { reservation, prepared } = artifact;
      const connection = yield* transport(reservation);
      const tip = yield* remoteTip(artifact, connection);
      if (tip === prepared.commitOid || tip !== reservation.expectedTip)
        return observe(artifact, tip);
      const repository = path.join(yield* location(reservation.id), "repository.git");
      if (
        tip !== null &&
        (yield* git(repository, ["merge-base", "--is-ancestor", tip, prepared.commitOid], {
          allowFailure: true,
        })).code !== 0
      )
        return FactoryPublicationObservation.make({ status: "conflict", remoteTip: tip });
      if (input.beforeWrite) yield* input.beforeWrite;
      // A failed push is not an answer; the remote is read again and decides the outcome.
      yield* git(
        repository,
        [
          "push",
          "--porcelain",
          `--force-with-lease=refs/heads/${reservation.branch}:${reservation.expectedTip ?? ""}`,
          "--",
          connection.remote,
          `${prepared.commitOid}:refs/heads/${reservation.branch}`,
        ],
        { env: connection.env, allowFailure: true },
      ).pipe(Effect.orElseSucceed(() => undefined));
      return yield* remoteTip(artifact, connection).pipe(
        Effect.map((next) => observe(artifact, next)),
        Effect.orElseSucceed(() => FactoryPublicationObservation.make({ status: "unknown" })),
      );
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  return FactoryPublication.of({ prepare, read, inspect, push });
});

export const layer = Layer.effect(FactoryPublication, make);
