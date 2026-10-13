import {
  CommandId,
  FactoryError,
  FactorySourceId,
  FactoryStartingSource,
  type FactoryWorkflowVersion,
  ProjectId,
  ThreadId,
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
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import { factorySafeRelativePath } from "./FactoryBoundaryPaths.ts";
import { admissibleFactorySourcePath } from "./FactoryExecutionProfile.ts";

export const FactorySourceFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  digest: Schema.String,
  mode: Schema.Literals(["100644", "100755"]),
});
export type FactorySourceFile = typeof FactorySourceFile.Type;
const CaptureRequest = Schema.Struct({
  requestId: CommandId,
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  expectedRevision: Schema.optionalKey(Schema.String),
});
const SourceManifest = Schema.Struct({
  source: FactoryStartingSource,
  request: CaptureRequest,
  workspaceRoot: Schema.String,
  files: Schema.Array(FactorySourceFile),
  indexFiles: Schema.Array(FactorySourceFile),
  indexData: Schema.NullOr(Schema.String),
  artifactCapture: Schema.optionalKey(
    Schema.Struct({ previousSourceId: FactorySourceId, filesDigest: Schema.String }),
  ),
});
export type FactorySourceArtifact = typeof SourceManifest.Type;

/**
 * Captures the source an assignment starts from, as a host-side snapshot that the boundary
 * seeds into the assignment volume. Reads go through the repository's own Git objects with hooks,
 * global and system config, fsmonitor and lazy fetch disabled. Sensitive paths (credentials,
 * keys, `.env`, `.git`) are excluded rather than copied, and a handover that changed one fails.
 * Any change to HEAD or the index during a capture fails it. The original workspace is only read.
 */
export class FactorySource extends Context.Service<
  FactorySource,
  {
    /**
     * Captures a project's HEAD, or a handover thread's worktree including staged, unstaged and
     * untracked work. The source id derives from `requestId`, so a repeat returns the stored
     * source and a different request under the same id is a conflict. A handover workspace is
     * read twice and must match, so a capture never mixes two edits.
     */
    readonly capture: (
      input: typeof CaptureRequest.Type,
    ) => Effect.Effect<FactoryStartingSource, FactoryError>;
    readonly read: (id: FactorySourceId) => Effect.Effect<FactorySourceArtifact, FactoryError>;
    /**
     * Records files taken from a stopped assignment volume as a new handover source on top of
     * `previousSourceId`, keeping its revision and index. Idempotent by `requestId`.
     */
    readonly captureArtifact: (input: {
      readonly requestId: CommandId;
      readonly previousSourceId: FactorySourceId;
      readonly threadId: ThreadId;
      readonly files: ReadonlyArray<FactorySourceFile>;
    }) => Effect.Effect<FactoryStartingSource, FactoryError>;
    /** Reads the admissible files of an exact committed revision, such as a pinned workflow. */
    readonly readRevision: (
      repositoryRoot: string,
      revision: string,
    ) => Effect.Effect<
      {
        readonly files: ReadonlyArray<FactorySourceFile>;
        readonly excludedPaths: ReadonlyArray<string>;
      },
      FactoryError
    >;
    /**
     * The commit at HEAD of a skills repository, with its real path as the repository root.
     * Fails with a reason the user can act on unless HEAD has a `skills/` directory.
     */
    readonly skillsHead: (
      repositoryRoot: string,
    ) => Effect.Effect<FactoryWorkflowVersion, FactoryError>;
    /**
     * Fails unless the original workspace still matches the captured source, so a handover does
     * not activate over work that moved on. A source captured from a volume never validates here.
     */
    readonly validateCurrent: (id: FactorySourceId) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactorySource") {}

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(SourceManifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(SourceManifest));
const unavailable = (detail: string) => new FactoryError({ code: "execution-unavailable", detail });
const preserve = (cause: unknown) =>
  isFactoryError(cause)
    ? cause
    : unavailable(
        "Starting work could not be captured coherently. The original project files remain unchanged.",
      );
const LIMIT = 256 * 1024 * 1024;
type Entry = { readonly path: string; readonly oid: string; readonly mode: "100644" | "100755" };

/**
 * Normalizes CRLF to LF in valid UTF-8 text so a working file can be matched against its Git blob
 * after a line-ending conversion on checkout. Binary or non-UTF-8 bytes are returned unchanged.
 */
export function factoryCanonicalText(bytes: Uint8Array): Uint8Array {
  if (bytes.includes(0)) return bytes;
  try {
    return new TextEncoder().encode(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(bytes)
        .replaceAll("\r\n", "\n"),
    );
  } catch {
    return bytes;
  }
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runner = yield* ProcessRunner.ProcessRunner;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const mutex = yield* Semaphore.make(1);
  const platform = yield* HostProcessPlatform;
  const root = path.join(config.stateDir, "factory", "sources");
  const digest = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
  const objectId = (bytes: Uint8Array, oid: string) =>
    crypto
      .digest(
        oid.length === 64 ? "SHA-256" : "SHA-1",
        Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]),
      )
      .pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
  const file = Effect.fn("FactorySource.file")(function* (
    name: string,
    bytes: Uint8Array,
    mode: Entry["mode"],
  ) {
    if (bytes.length > 16 * 1024 * 1024)
      return yield* unavailable(`The source file ${name} exceeds the 16 MB managed-file limit.`);
    return FactorySourceFile.make({
      path: name,
      content: Buffer.from(bytes).toString("base64"),
      digest: yield* digest(bytes),
      mode,
    });
  });
  // Opens a local repository for reads through its own Git objects only: hooks, global and
  // system config, fsmonitor and lazy fetch are disabled.
  const open = Effect.fn("FactorySource.open")(function* (workspaceRoot: string) {
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
      return yield* unavailable("Starting work requires a non-bare local Git repository.");
    const commonFile = path.join(gitDirectory, "commondir");
    const commonDirectory = (yield* fs.exists(commonFile))
      ? path.resolve(gitDirectory, (yield* fs.readFileString(commonFile)).trim())
      : gitDirectory;
    const indexPath = path.join(gitDirectory, "index");
    const environment = {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_PARAMETERS: "",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_INDEX_FILE: indexPath,
      GIT_COMMON_DIR: commonDirectory,
      GIT_OBJECT_DIRECTORY: path.join(commonDirectory, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
    };
    const git = Effect.fn("FactorySource.git")(function* (
      args: ReadonlyArray<string>,
      stdin?: string,
      binary = false,
    ) {
      const chunks: Array<Uint8Array> = [];
      let count = 0;
      const result = yield* runner.run({
        command: "git",
        args: [
          `--git-dir=${gitDirectory}`,
          `--work-tree=${workspace}`,
          "-c",
          "core.hooksPath=",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          ...args,
        ],
        cwd: workspace,
        env: environment,
        stdin,
        outputMode: "error",
        maxOutputBytes: LIMIT + 8 * 1024 * 1024,
        onStdoutChunk: binary
          ? (chunk) => {
              count += chunk.length;
              if (count <= LIMIT + 8 * 1024 * 1024) chunks.push(chunk);
            }
          : undefined,
      });
      if (
        result.code !== 0 ||
        (!binary && result.stdoutInvalidUtf8) ||
        count > LIMIT + 8 * 1024 * 1024
      )
        return yield* unavailable(
          "Git could not read the local source snapshot without external execution. Fetch missing objects or resolve unsupported repository state before retrying.",
        );
      return binary ? Buffer.concat(chunks) : Buffer.from(result.stdout);
    });
    return { workspace, indexPath, git };
  });
  const inspect = Effect.fn("FactorySource.inspect")(function* (
    workspaceRoot: string,
    handover: boolean,
    pinnedRevision?: string,
  ) {
    const { workspace, indexPath, git } = yield* open(workspaceRoot);
    const headRevision = (yield* git(["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim();
    const revision =
      pinnedRevision === undefined
        ? headRevision
        : (yield* git(["rev-parse", "--verify", "--end-of-options", `${pinnedRevision}^{commit}`]))
            .toString()
            .trim();
    const branchName = (yield* git(["rev-parse", "--abbrev-ref", "HEAD"])).toString().trim();
    const branch = branchName === "HEAD" ? null : branchName;
    const parse = (bytes: Buffer, indexed: boolean): Array<Entry> =>
      bytes
        .toString()
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const match = (
            indexed
              ? /^(\d+) ([a-f0-9]{40,64}) (\d)\t([\s\S]+)$/
              : /^(\d+) blob ([a-f0-9]{40,64})\t([\s\S]+)$/
          ).exec(record);
          const name = match?.[indexed ? 4 : 3];
          if (
            !match ||
            !name ||
            !factorySafeRelativePath(name) ||
            !["100644", "100755"].includes(match[1]!) ||
            (indexed && match[3] !== "0")
          )
            throw unavailable(
              "Source capture cannot preserve unresolved merges, links, submodules, special files, or unsupported path names. Resolve them before handover.",
            );
          return { path: name, oid: match[2]!, mode: match[1] as Entry["mode"] };
        });
    const headBytes = yield* git(["ls-tree", "-rz", "--full-tree", revision]);
    const head = yield* Effect.try({ try: () => parse(headBytes, false), catch: preserve });
    const indexData =
      handover && (yield* fs.exists(indexPath))
        ? Buffer.from(yield* fs.readFile(indexPath)).toString("base64")
        : null;
    const indexBytes = handover ? yield* git(["ls-files", "--stage", "-z"]) : undefined;
    const index =
      indexBytes === undefined
        ? head
        : yield* Effect.try({ try: () => parse(indexBytes, true), catch: preserve });
    const untracked = handover
      ? (yield* git(["ls-files", "--others", "--exclude-standard", "-z"]))
          .toString()
          .split("\0")
          .filter(Boolean)
      : [];
    const allPaths = [
      ...new Set([
        ...head.map((entry) => entry.path),
        ...index.map((entry) => entry.path),
        ...untracked,
      ]),
    ].sort();
    if (
      new Set(allPaths.map((name) => name.toLowerCase())).size !== allPaths.length ||
      allPaths.some((name) => !factorySafeRelativePath(name))
    )
      return yield* unavailable("Source paths contain unsupported aliases or unsafe names.");
    const objects = [
      ...new Set(
        [...head, ...index]
          .filter((entry) => admissibleFactorySourcePath(entry.path))
          .map((entry) => entry.oid),
      ),
    ];
    const blobs = new Map<string, Buffer>();
    const response = objects.length
      ? yield* git(["cat-file", "--batch"], `${objects.join("\n")}\n`, true)
      : Buffer.alloc(0);
    let offset = 0;
    for (const oid of objects) {
      const end = response.indexOf(10, offset);
      const header = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(
        response.subarray(offset, end).toString(),
      );
      const size = Number(header?.[2]);
      if (
        !header ||
        header[1] !== oid ||
        size > 16 * 1024 * 1024 ||
        !Number.isSafeInteger(size) ||
        end < offset ||
        end + size + 2 > response.length
      )
        return yield* unavailable(
          "A Git source object is missing, unsupported, or exceeds the managed-file limit.",
        );
      blobs.set(oid, response.subarray(end + 1, end + size + 1));
      offset = end + size + 2;
    }
    const headByPath = new Map(head.map((entry) => [entry.path, entry]));
    const indexByPath = new Map(index.map((entry) => [entry.path, entry]));
    const stagedPaths = handover
      ? allPaths
          .filter(
            (name) =>
              headByPath.get(name)?.oid !== indexByPath.get(name)?.oid ||
              headByPath.get(name)?.mode !== indexByPath.get(name)?.mode,
          )
          .filter((name) => headByPath.has(name) || indexByPath.has(name))
      : [];
    const files: Array<FactorySourceFile> = [];
    const indexFiles: Array<FactorySourceFile> = [];
    const excludedPaths: Array<string> = [];
    const unstagedPaths: Array<string> = [];
    const deletedPaths: Array<string> = [];
    const checkedParents = new Set<string>();
    const rejectLinks = Effect.fn("FactorySource.rejectLinks")(function* (name: string) {
      let current = workspace;
      for (const part of name.split("/")) {
        current = path.join(current, part);
        if (checkedParents.has(current)) continue;
        if (Option.isSome(yield* fs.readLink(current).pipe(Effect.option)))
          return yield* unavailable(
            `A link at ${name} cannot be preserved by the managed runtime.`,
          );
        checkedParents.add(current);
      }
    });
    let total = 0;
    for (const name of allPaths) {
      if (handover) yield* rejectLinks(name);
      const indexed = indexByPath.get(name);
      const original = headByPath.get(name);
      if (!admissibleFactorySourcePath(name)) {
        if (handover) {
          const target = path.join(workspace, name);
          if (
            !original ||
            !indexed ||
            original.oid !== indexed.oid ||
            original.mode !== indexed.mode ||
            !(yield* fs.exists(target)) ||
            path.relative(target, yield* fs.realPath(target)) !== "" ||
            (yield* fs.stat(target)).type !== "File"
          )
            return yield* unavailable(
              `Sensitive-path work at ${name} cannot be handed over. Resolve it separately; no file was dropped or changed.`,
            );
          const bytes = yield* fs.readFile(target);
          if (
            (yield* objectId(bytes, original.oid)) !== original.oid &&
            (yield* objectId(factoryCanonicalText(bytes), original.oid)) !== original.oid
          )
            return yield* unavailable(
              `Sensitive-path changes at ${name} require separate handling before handover.`,
            );
        }
        excludedPaths.push(name);
        continue;
      }
      if (indexed) indexFiles.push(yield* file(name, blobs.get(indexed.oid)!, indexed.mode));
      if (!handover) {
        if (original) {
          const bytes = blobs.get(original.oid)!;
          total += bytes.length;
          if (total > LIMIT)
            return yield* unavailable("Starting work exceeds the 256 MB managed-source limit.");
          files.push(yield* file(name, bytes, original.mode));
        }
        continue;
      }
      const target = path.join(workspace, name);
      if (!(yield* fs.exists(target))) {
        if (indexed) unstagedPaths.push(name);
        if (original || indexed) deletedPaths.push(name);
        continue;
      }
      if (path.relative(target, yield* fs.realPath(target)) !== "")
        return yield* unavailable(`A link at ${name} cannot be preserved by the managed runtime.`);
      const stat = yield* fs.stat(target);
      if (stat.type !== "File" || (Option.isSome(stat.nlink) && stat.nlink.value !== 1))
        return yield* unavailable(
          `A special file or hard link at ${name} cannot be preserved by the managed runtime.`,
        );
      const bytes = yield* fs.readFile(target);
      total += bytes.length;
      if (total > LIMIT)
        return yield* unavailable("Starting work exceeds the 256 MB managed-source limit.");
      const mode =
        platform === "win32"
          ? (indexed?.mode ?? original?.mode ?? "100644")
          : stat.mode & 0o111
            ? "100755"
            : "100644";
      files.push(yield* file(name, bytes, mode));
      if (
        indexed &&
        (((yield* objectId(bytes, indexed.oid)) !== indexed.oid &&
          (yield* objectId(factoryCanonicalText(bytes), indexed.oid)) !== indexed.oid) ||
          mode !== indexed.mode)
      )
        unstagedPaths.push(name);
    }
    const indexAfter =
      handover && (yield* fs.exists(indexPath))
        ? Buffer.from(yield* fs.readFile(indexPath)).toString("base64")
        : null;
    if (
      (yield* git(["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim() !== headRevision ||
      indexData !== indexAfter
    )
      return yield* unavailable(
        "The repository changed during source capture. Wait for editing and Git operations to stop, then retry.",
      );
    const sourceDigest = yield* digest(
      new TextEncoder().encode(
        stableStringify({
          revision,
          branch,
          files: files.map(({ path: name, digest, mode }) => ({ path: name, digest, mode })),
          indexFiles: indexFiles.map(({ path: name, digest, mode }) => ({
            path: name,
            digest,
            mode,
          })),
          indexData,
          excludedPaths,
        }),
      ),
    );
    return {
      revision,
      branch,
      sourceDigest,
      files,
      indexFiles,
      indexData,
      stagedPaths,
      unstagedPaths,
      untrackedPaths: untracked,
      deletedPaths,
      excludedPaths,
    };
  });
  const read = Effect.fn("FactorySource.read")(function* (id: FactorySourceId) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return yield* new FactoryError({ code: "permission-denied" });
    const artifact = yield* fs
      .readFileString(path.join(root, id, "source.json"))
      .pipe(Effect.flatMap(decodeManifest));
    if (
      artifact.source.id !== id ||
      artifact.source.projectId !== artifact.request.projectId ||
      artifact.source.threadId !== artifact.request.threadId
    )
      return yield* new FactoryError({ code: "permission-denied" });
    return artifact;
  }, Effect.mapError(preserve));
  const capture = Effect.fn("FactorySource.capture")(
    function* (input: typeof CaptureRequest.Type) {
      const encoded = yield* digest(new TextEncoder().encode(`factory-source:${input.requestId}`));
      const id = FactorySourceId.make(
        `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20, 32)}`,
      );
      const destination = path.join(root, id, "source.json");
      if (yield* fs.exists(destination)) {
        const previous = yield* read(id);
        if (
          previous.artifactCapture ||
          stableStringify(previous.request) !== stableStringify(input)
        )
          return yield* new FactoryError({ code: "command-conflict" });
        return previous.source;
      }
      const project = yield* projects.get(input.projectId);
      if (Option.isNone(project)) return yield* unavailable("The project no longer exists.");
      const thread =
        input.threadId === undefined ? undefined : yield* projections.getThread(input.threadId);
      if (
        thread &&
        (thread.projectId !== input.projectId ||
          thread.deletedAt !== null ||
          thread.archivedAt !== null ||
          thread.lineage?.parentThreadId)
      )
        return yield* new FactoryError({ code: "permission-denied" });
      const workspaceRoot = thread?.worktreePath ?? project.value.workspaceRoot;
      const snapshot = yield* inspect(workspaceRoot, thread !== undefined);
      if (input.expectedRevision !== undefined && input.expectedRevision !== snapshot.revision)
        return yield* unavailable(
          "The source revision changed since this work was authorized. Review the starting revision and retry.",
        );
      if (
        thread !== undefined &&
        (yield* inspect(workspaceRoot, true)).sourceDigest !== snapshot.sourceDigest
      )
        return yield* unavailable(
          "Working files changed during handover capture. Stop editing and retry; the original workspace is untouched.",
        );
      const source = FactoryStartingSource.make({
        id,
        projectId: input.projectId,
        revision: snapshot.revision,
        sourceDigest: snapshot.sourceDigest,
        branch: snapshot.branch,
        origin: thread === undefined ? "project" : "handover",
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        capturedAt: DateTime.formatIso(yield* DateTime.now),
        fileCount: snapshot.files.length,
        stagedPaths: snapshot.stagedPaths,
        unstagedPaths: snapshot.unstagedPaths,
        untrackedPaths: snapshot.untrackedPaths,
        deletedPaths: snapshot.deletedPaths,
        excludedPaths: snapshot.excludedPaths,
      });
      const manifest = SourceManifest.make({
        source,
        request: input,
        workspaceRoot,
        files: snapshot.files,
        indexFiles: snapshot.indexFiles,
        indexData: snapshot.indexData,
      });
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${yield* crypto.randomUUIDv4}`;
      yield* fs.writeFileString(temporary, yield* encodeManifest(manifest), { flag: "wx" });
      yield* fs.rename(temporary, destination);
      return source;
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  const captureArtifact = Effect.fn("FactorySource.captureArtifact")(
    function* (input: Parameters<FactorySource["Service"]["captureArtifact"]>[0]) {
      const original = yield* read(input.previousSourceId);
      const files = input.files.toSorted((a, b) => a.path.localeCompare(b.path));
      const names = new Set<string>();
      let total = 0;
      for (const entry of files) {
        const bytes = Buffer.from(entry.content, "base64");
        total += bytes.length;
        if (
          !factorySafeRelativePath(entry.path) ||
          !admissibleFactorySourcePath(entry.path) ||
          names.has(entry.path.toLowerCase()) ||
          bytes.length > 16 * 1024 * 1024 ||
          total > LIMIT ||
          (entry.mode !== "100644" && entry.mode !== "100755") ||
          (yield* digest(bytes)) !== entry.digest
        )
          return yield* unavailable(
            "The stopped candidate contains an invalid or oversized source file.",
          );
        names.add(entry.path.toLowerCase());
      }
      const filesDigest = yield* digest(Buffer.from(stableStringify(files)));
      const encoded = yield* digest(Buffer.from(`factory-source:${input.requestId}`));
      const id = FactorySourceId.make(
        `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20, 32)}`,
      );
      const destination = path.join(root, id, "source.json");
      const request = {
        requestId: input.requestId,
        projectId: original.source.projectId,
        threadId: input.threadId,
      };
      const artifactCapture = { previousSourceId: input.previousSourceId, filesDigest };
      if (yield* fs.exists(destination)) {
        const previous = yield* read(id);
        if (
          stableStringify(previous.request) !== stableStringify(request) ||
          stableStringify(previous.artifactCapture) !== stableStringify(artifactCapture)
        )
          return yield* new FactoryError({ code: "command-conflict" });
        return previous.source;
      }
      const sourceDigest = yield* digest(
        Buffer.from(
          stableStringify({
            revision: original.source.revision,
            branch: original.source.branch,
            files: files.map(({ path, digest, mode }) => ({ path, digest, mode })),
            indexFiles: original.indexFiles.map(({ path, digest, mode }) => ({
              path,
              digest,
              mode,
            })),
            indexData: original.indexData,
            excludedPaths: original.source.excludedPaths,
          }),
        ),
      );
      const current = new Map(files.map((entry) => [entry.path, entry]));
      const indexed = new Map(original.indexFiles.map((entry) => [entry.path, entry]));
      const source = FactoryStartingSource.make({
        ...original.source,
        id,
        sourceDigest,
        origin: "handover",
        threadId: input.threadId,
        capturedAt: DateTime.formatIso(yield* DateTime.now),
        fileCount: files.length,
        unstagedPaths: original.indexFiles
          .filter(
            (entry) =>
              current.get(entry.path)?.digest !== entry.digest ||
              current.get(entry.path)?.mode !== entry.mode,
          )
          .map((entry) => entry.path),
        untrackedPaths: files
          .filter((entry) => !indexed.has(entry.path))
          .map((entry) => entry.path),
        deletedPaths: [
          ...new Set([
            ...original.source.deletedPaths,
            ...original.files.map((entry) => entry.path),
            ...indexed.keys(),
          ]),
        ]
          .filter((name) => !current.has(name))
          .sort(),
      });
      const manifest = SourceManifest.make({
        ...original,
        source,
        request,
        files,
        artifactCapture,
      });
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${yield* crypto.randomUUIDv4}`;
      yield* fs.writeFileString(temporary, yield* encodeManifest(manifest), { flag: "wx" });
      yield* fs.rename(temporary, destination);
      return source;
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  const validateCurrent = Effect.fn("FactorySource.validateCurrent")(function* (
    id: FactorySourceId,
  ) {
    const artifact = yield* read(id);
    if (artifact.artifactCapture)
      return yield* unavailable(
        "This source was captured from a stopped managed candidate and requires its migration authority.",
      );
    if (
      (yield* inspect(artifact.workspaceRoot, artifact.source.origin === "handover"))
        .sourceDigest !== artifact.source.sourceDigest
    )
      return yield* unavailable(
        "The original starting work changed after capture. Review it before activating handover.",
      );
  }, Effect.mapError(preserve));
  const readRevision = Effect.fn("FactorySource.readRevision")(function* (
    repositoryRoot: string,
    revision: string,
  ) {
    if (!/^[a-f0-9]{40,64}$/i.test(revision))
      return yield* unavailable(
        "Reading a workflow snapshot requires an exact committed revision.",
      );
    const result = yield* inspect(repositoryRoot, false, revision);
    return { files: result.files, excludedPaths: result.excludedPaths };
  }, Effect.mapError(preserve));
  const skillsHead = Effect.fn("FactorySource.skillsHead")(function* (repositoryRoot: string) {
    const repository = yield* open(repositoryRoot).pipe(
      Effect.mapError(() => unavailable(`${repositoryRoot} is not a local Git repository.`)),
    );
    const revision = yield* repository.git(["rev-parse", "--verify", "HEAD^{commit}"]).pipe(
      Effect.map((output) => output.toString().trim()),
      Effect.mapError(() => unavailable(`${repositoryRoot} has no commit at HEAD.`)),
    );
    const skills = yield* repository.git([
      "ls-tree",
      "-d",
      "--name-only",
      revision,
      "--",
      "skills",
    ]);
    if (skills.toString().trim() !== "skills")
      return yield* unavailable(`${repositoryRoot} has no committed skills directory at HEAD.`);
    return { repositoryRoot: repository.workspace, revision };
  }, Effect.mapError(preserve));
  return FactorySource.of({
    capture,
    captureArtifact,
    read,
    readRevision,
    skillsHead,
    validateCurrent,
  });
});

export const layer = Layer.effect(FactorySource, make);
