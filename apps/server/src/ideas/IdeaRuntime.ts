import * as Stream from "effect/Stream";
import {
  resolveAttachmentPath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import type { ChatAttachment } from "@t3tools/contracts";
import { resolveIdeaMain } from "./IdeaMain.ts";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CommandId, IdeaArtifactId, type IdeaArtifact, type ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";
import { ideaThreadDiscussion } from "./IdeaDiscussion.ts";
import {
  withIdeaLock,
  clearIdeaExecution,
  readIdeaExecution,
  refreshIdeaMain,
  setIdeaExecution,
  type IdeaExecutionContext,
} from "./IdeaExecution.ts";

export class IdeaRuntimeError extends Schema.TaggedError<IdeaRuntimeError>()("IdeaRuntimeError", {
  message: Schema.String,
}) {}

export const MAX_IDEA_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 100_000;
const fail = (message: string) => new IdeaRuntimeError({ message });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const asRuntimeError = (error: { readonly message: string }) => fail(error.message);
const isIdeaRuntimeError = Schema.is(IdeaRuntimeError);

export interface IdeaArtifactWrite {
  readonly threadId: ThreadId;
  readonly name: string;
  readonly mediaType: string;
  readonly contentBase64: string;
  readonly sourceAttachmentId?: string;
  readonly source?: "upload" | "agent";
}

export function decodeIdeaArtifactContent(contentBase64: string): Uint8Array {
  if (contentBase64.length > Math.ceil(MAX_IDEA_ARTIFACT_BYTES / 3) * 4)
    throw fail("Documents must be 20 MB or smaller.");
  const padding = contentBase64.indexOf("=");
  if (
    contentBase64.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(contentBase64) ||
    (padding !== -1 &&
      (padding < contentBase64.length - 2 || /[^=]/.test(contentBase64.slice(padding))))
  ) {
    throw fail("The document contains invalid base64 data.");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.byteLength > MAX_IDEA_ARTIFACT_BYTES) throw fail("Documents must be 20 MB or smaller.");
  return bytes;
}

export const isIdeaTextDocument = (mediaType: string, name: string) =>
  mediaType.startsWith("text/") || /\.(md|markdown|html?|txt|json|csv|svg)$/i.test(name);

export class IdeaRuntime extends Context.Service<
  IdeaRuntime,
  {
    readonly workingDirectory: (threadId: ThreadId) => Effect.Effect<string, IdeaRuntimeError>;
    readonly importAttachments: (
      threadId: ThreadId,
      attachments: readonly ChatAttachment[],
    ) => Effect.Effect<void, IdeaRuntimeError>;
    readonly prepare: (threadId: ThreadId) => Effect.Effect<IdeaExecutionContext, IdeaRuntimeError>;
    readonly foregroundContext: (
      threadId: ThreadId,
      refreshMain?: boolean,
    ) => Effect.Effect<string, IdeaRuntimeError>;
    readonly readMain: (input: {
      threadId: ThreadId;
      path?: string | undefined;
      query?: string | undefined;
    }) => Effect.Effect<{ revision: string; text: string }, IdeaRuntimeError>;
    readonly readContext: (input: {
      threadId: ThreadId;
      resource: "notebook" | "entry" | "history" | "artifact" | "promote" | "skill";
      id?: string | undefined;
      offset?: number | undefined;
    }) => Effect.Effect<string, IdeaRuntimeError>;
    readonly writeArtifact: (
      input: IdeaArtifactWrite,
    ) => Effect.Effect<IdeaArtifact, IdeaRuntimeError>;
    readonly readArtifact: (input: {
      threadId: ThreadId;
      artifactId: IdeaArtifactId;
    }) => Effect.Effect<{ artifact: IdeaArtifact; contentBase64: string }, IdeaRuntimeError>;
    readonly removeArtifact: (
      threadId: ThreadId,
      artifactId: IdeaArtifactId,
    ) => Effect.Effect<void, IdeaRuntimeError>;
    readonly removeOwned: (threadId: ThreadId) => Effect.Effect<void, IdeaRuntimeError>;
  }
>()("t3/ideas/IdeaRuntime") {
  static readonly layer = Layer.effect(
    IdeaRuntime,
    Effect.gen(function* () {
      const store = yield* IdeaNotebookStore;
      const snapshots = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      const fs = yield* FileSystem.FileSystem;
      const NodePath = yield* Path.Path;
      const config = yield* ServerConfig;
      const process = yield* ProcessRunner;
      const crypto = yield* Crypto.Crypto;
      const root = (id: ThreadId) =>
        NodePath.join(config.stateDir, "ideas", Buffer.from(id).toString("base64url"));
      const file = (id: ThreadId, artifactId: IdeaArtifactId) =>
        NodePath.join(root(id), "documents", encodeURIComponent(artifactId));
      const active = (id: ThreadId) =>
        store.requireActive(id).pipe(Effect.mapError(asRuntimeError));
      const git = Effect.fn("IdeaRuntime.git")(function* (cwd: string, args: readonly string[]) {
        const result = yield* process
          .run({
            command: "git",
            cwd,
            args: ["--no-optional-locks", ...args],
            maxOutputBytes: 512_000,
            timeout: "20 seconds",
          })
          .pipe(Effect.mapError(asRuntimeError));
        if (result.code !== 0)
          return yield* fail(
            "Could not read the project's main branch. Ensure a local main branch exists.",
          );
        return (
          result.stdout +
          (result.stdoutTruncated
            ? "\n[Output truncated at 512 KB. Narrow the file or search selection.]"
            : "")
        );
      });
      const mainRevision = (cwd: string) =>
        resolveIdeaMain(cwd).pipe(
          Effect.provideService(ProcessRunner, process),
          Effect.mapError(asRuntimeError),
          Effect.flatMap((revision) =>
            revision
              ? Effect.succeed(revision)
              : Effect.fail(
                  fail(
                    "The project's default branch is unavailable. Fetch its remote default branch or create a local main/master branch.",
                  ),
                ),
          ),
        );
      const project = Effect.fn("IdeaRuntime.project")(function* (threadId: ThreadId) {
        yield* active(threadId);
        const thread = yield* snapshots
          .getThreadShellById(threadId)
          .pipe(Effect.mapError(asRuntimeError));
        if (Option.isNone(thread) || thread.value.purpose !== "idea")
          return yield* fail("This thread is not an idea.");
        const value = yield* snapshots
          .getProjectShellById(thread.value.projectId)
          .pipe(Effect.mapError(asRuntimeError));
        if (Option.isNone(value)) return yield* fail("The idea's project is unavailable.");
        return value.value;
      });
      const ownedDirectory = Effect.fn("IdeaRuntime.ownedDirectory")(function* (
        threadId: ThreadId,
        create = false,
        includeDocuments = true,
      ) {
        let expected = yield* fs.realPath(config.stateDir).pipe(Effect.mapError(asRuntimeError));
        for (const segment of [
          "ideas",
          Buffer.from(threadId).toString("base64url"),
          ...(includeDocuments ? ["documents"] : []),
        ]) {
          expected = NodePath.join(expected, segment);
          if (!(yield* fs.exists(expected).pipe(Effect.mapError(asRuntimeError)))) {
            if (!create) return yield* fail("The idea's document storage is unavailable.");
            yield* fs.makeDirectory(expected).pipe(Effect.mapError(asRuntimeError));
          }
          const real = yield* fs.realPath(expected).pipe(Effect.mapError(asRuntimeError));
          if (NodePath.relative(expected, real) !== "")
            return yield* fail("The idea directory must not be a symbolic link.");
        }
        return NodePath.dirname(expected);
      });
      const foregroundContext = Effect.fn("IdeaRuntime.foregroundContext")(function* (
        threadId: ThreadId,
        refreshMain = false,
      ) {
        const notebook = yield* active(threadId);
        const execution = readIdeaExecution(threadId);
        if (execution && refreshMain)
          refreshIdeaMain(threadId, yield* mainRevision(execution.projectDirectory));
        return yield* encodeJson({
          revision: notebook.revision,
          mainRevision: readIdeaExecution(threadId)?.mainRevision,
          pitch: {
            ...notebook.pitch,
            markdown: notebook.pitch.markdown.slice(0, MAX_CONTEXT_CHARS),
          },
          pitchTruncated: notebook.pitch.markdown.length > MAX_CONTEXT_CHARS,
          entries: notebook.entries.map(({ id, title, categoryId }) => ({ id, title, categoryId })),
          categories: notebook.categories,
          artifacts: notebook.artifacts,
          update: notebook.update,
        }).pipe(Effect.mapError(asRuntimeError));
      });
      const prepare = Effect.fn("IdeaRuntime.prepare")(function* (threadId: ThreadId) {
        return yield* withIdeaLock(
          threadId,
          Effect.gen(function* () {
            const notebook = yield* active(threadId);
            const owner = yield* project(threadId);
            const revision = yield* mainRevision(owner.workspaceRoot);
            const cwd = yield* ownedDirectory(threadId, true);
            const history = yield* snapshots
              .getThreadDetailById(threadId)
              .pipe(Effect.mapError(asRuntimeError));
            const messages = Option.isSome(history) ? ideaThreadDiscussion(history.value) : [];
            const context = [
              "Saved notebook:",
              yield* foregroundContext(threadId),
              "Previous discussion, oldest first:",
              yield* encodeJson({
                messages: messages.slice(-20).map((message) => ({
                  ...message,
                  text: message.text.slice(0, 5000),
                  truncated: message.text.length > 5000,
                })),
                omittedCount: Math.max(0, messages.length - 20),
              }).pipe(Effect.mapError(asRuntimeError)),
              "Use idea_read history to retrieve earlier discussion if this context was shortened.",
            ].join("\n");
            const execution = {
              cwd,
              projectDirectory: owner.workspaceRoot,
              mainRevision: revision,
              deletionEpoch: notebook.deletionEpoch,
              context,
            };
            setIdeaExecution(threadId, execution);
            return execution;
          }),
        );
      });
      const readMain = Effect.fn("IdeaRuntime.readMain")(function* (input: {
        threadId: ThreadId;
        path?: string | undefined;
        query?: string | undefined;
      }) {
        yield* active(input.threadId);
        const current = readIdeaExecution(input.threadId) ?? (yield* prepare(input.threadId));
        const revision = current.mainRevision;
        if (input.path !== undefined) {
          if (
            input.path.includes("\0") ||
            input.path.includes("\\") ||
            input.path.startsWith("/") ||
            input.path.split("/").some((part) => part === "..")
          )
            return yield* fail("Use a repository-relative file path.");
          const record = yield* git(current.projectDirectory, [
            "ls-tree",
            "-z",
            revision,
            "--",
            input.path,
          ]);
          const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(record);
          if (!match || match[3] !== input.path)
            return yield* fail("The requested path is not a regular file in main.");
          return {
            revision,
            text: yield* git(current.projectDirectory, ["cat-file", "blob", match[2]!]),
          };
        }
        if (input.query !== undefined) {
          const result = yield* process
            .run({
              command: "git",
              cwd: current.projectDirectory,
              args: [
                "--no-optional-locks",
                "grep",
                "-n",
                "-I",
                "-F",
                "-e",
                input.query,
                revision,
                "--",
              ],
              maxOutputBytes: 512_000,
              timeout: "20 seconds",
            })
            .pipe(Effect.mapError(asRuntimeError));
          if (result.code !== 0 && result.code !== 1) return yield* fail("Could not search main.");
          return {
            revision,
            text:
              result.stdout +
              (result.stdoutTruncated
                ? "\n[Search results truncated at 512 KB. Narrow the query.]"
                : ""),
          };
        }
        return {
          revision,
          text: yield* git(current.projectDirectory, ["ls-tree", "-r", "--name-only", revision]),
        };
      });
      const readArtifact = Effect.fn("IdeaRuntime.readArtifact")(function* (input: {
        threadId: ThreadId;
        artifactId: IdeaArtifactId;
      }) {
        return yield* withIdeaLock(
          input.threadId,
          Effect.gen(function* () {
            const notebook = yield* active(input.threadId);
            const artifact = notebook.artifacts.find((a) => a.id === input.artifactId);
            if (!artifact) return yield* fail("This document is unavailable.");
            yield* ownedDirectory(input.threadId);
            const target = file(input.threadId, input.artifactId);
            if ((yield* fs.realPath(target).pipe(Effect.mapError(asRuntimeError))) !== target)
              return yield* fail("The document must not be a symbolic link.");
            const bytes = yield* fs.readFile(target).pipe(Effect.mapError(asRuntimeError));
            return { artifact, contentBase64: Buffer.from(bytes).toString("base64") };
          }),
        );
      });
      const writeArtifact = Effect.fn("IdeaRuntime.writeArtifact")(function* (
        input: IdeaArtifactWrite,
      ) {
        return yield* withIdeaLock(
          input.threadId,
          Effect.gen(function* () {
            const notebook = yield* active(input.threadId);
            if (!input.name.trim() || input.name.length > 240 || !input.mediaType.trim())
              return yield* fail("A document name and media type are required.");
            const importedId = input.sourceAttachmentId
              ? IdeaArtifactId.make("attachment-" + input.sourceAttachmentId)
              : undefined;
            const previous = importedId
              ? notebook.artifacts.find((artifact) => artifact.id === importedId)
              : undefined;
            if (previous) return previous;
            const bytes = yield* Effect.try({
              try: () => decodeIdeaArtifactContent(input.contentBase64),
              catch: (e) => (isIdeaRuntimeError(e) ? e : fail("Invalid document data.")),
            });
            yield* ownedDirectory(input.threadId, true);
            const artifact = {
              id:
                importedId ??
                IdeaArtifactId.make(
                  yield* crypto.randomUUIDv4.pipe(Effect.mapError(asRuntimeError)),
                ),
              name: input.name.trim(),
              mediaType: input.mediaType,
              sizeBytes: bytes.byteLength,
              textStatus: isIdeaTextDocument(input.mediaType, input.name)
                ? "available"
                : ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(input.mediaType)
                  ? "image"
                  : "unsupported",
              revision: 1,
              createdAt: DateTime.formatIso(yield* DateTime.now),
              source: input.source ?? "upload",
            } satisfies IdeaArtifact;
            const target = file(input.threadId, artifact.id);
            yield* fs
              .writeFile(target, bytes, { flag: "wx" })
              .pipe(Effect.mapError(asRuntimeError));
            yield* engine
              .dispatch({
                type: "idea.apply",
                commandId: CommandId.make(
                  yield* crypto.randomUUIDv4.pipe(Effect.mapError(asRuntimeError)),
                ),
                threadId: input.threadId,
                deletionEpoch: notebook.deletionEpoch,
                mutation: { kind: "artifact.register", artifact },
              })
              .pipe(
                Effect.mapError(asRuntimeError),
                Effect.onError(() => fs.remove(target, { force: true }).pipe(Effect.ignore)),
              );
            return artifact;
          }),
        );
      });
      const catchUp = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const stream = yield* engine.subscribeDomainEvents;
          const notebook = yield* active(threadId);
          if (notebook.update.status === "current") return;
          const throughSequence = yield* engine.latestSequence;
          yield* engine
            .dispatch({
              type: "idea.apply",
              commandId: CommandId.make(
                yield* crypto.randomUUIDv4.pipe(Effect.mapError(asRuntimeError)),
              ),
              threadId,
              deletionEpoch: notebook.deletionEpoch,
              mutation: { kind: "update.request", sequence: throughSequence },
            })
            .pipe(Effect.mapError(asRuntimeError));
          const check = active(threadId).pipe(
            Effect.flatMap((current) =>
              current.update.status === "failed"
                ? Effect.fail(
                    fail(
                      current.update.error ??
                        "The notebook update failed. Retry Idea updates before promotion.",
                    ),
                  )
                : Effect.succeed(
                    current.update.status === "current" &&
                      current.update.processedSequence >= throughSequence,
                  ),
            ),
          );
          if (yield* check) return;
          const completed = yield* stream.pipe(
            Stream.filter(
              (event) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === threadId &&
                (event.type === "idea.changed" || event.type === "idea.purged"),
            ),
            Stream.mapEffect(() => check),
            Stream.filter(Boolean),
            Stream.runHead,
            Effect.timeoutOption("4 minutes"),
          );
          if (Option.isNone(completed) || Option.isNone(completed.value))
            return yield* fail(
              "The notebook has not caught up yet. Check Idea updates, then retry /promote.",
            );
        }).pipe(Effect.scoped);
      const readContext = Effect.fn("IdeaRuntime.readContext")(function* (input: {
        threadId: ThreadId;
        resource: "notebook" | "entry" | "history" | "artifact" | "promote" | "skill";
        id?: string | undefined;
        offset?: number | undefined;
      }) {
        if (input.resource === "promote") yield* catchUp(input.threadId);
        const notebook = yield* active(input.threadId);
        if (input.resource === "notebook") return yield* foregroundContext(input.threadId);
        if (input.resource === "entry") {
          let entryId = input.id;
          const visited = new Set<string>();
          while (entryId && !visited.has(entryId)) {
            visited.add(entryId);
            const alias = notebook.aliases.find((a) => a.from === entryId);
            if (!alias) break;
            entryId = alias.to;
          }
          const entry = notebook.entries.find((e) => e.id === entryId);
          if (!entry) return yield* fail("The notebook entry is unavailable.");
          return yield* encodeJson(entry).pipe(Effect.mapError(asRuntimeError));
        }
        if (input.resource === "history") {
          const detail = yield* snapshots
            .getThreadDetailById(input.threadId)
            .pipe(Effect.mapError(asRuntimeError));
          const messages = Option.isSome(detail) ? ideaThreadDiscussion(detail.value) : [];
          const offset = Math.max(0, input.offset ?? 0);
          return yield* encodeJson({
            messages: messages.slice(offset, offset + 20).map(({ id, source, role, text }) => ({
              id,
              source,
              role,
              text: text.slice(0, 10000),
              truncated: text.length > 10000,
            })),
            nextOffset: offset + 20 < messages.length ? offset + 20 : null,
          }).pipe(Effect.mapError(asRuntimeError));
        }
        if (input.resource === "artifact") {
          if (!input.id) return yield* fail("Choose a document to read.");
          const result = yield* readArtifact({
            threadId: input.threadId,
            artifactId: IdeaArtifactId.make(input.id),
          });
          if (!isIdeaTextDocument(result.artifact.mediaType, result.artifact.name))
            return yield* fail(
              "This document cannot be extracted as text. Use idea_read_image for PNG, JPEG, GIF or WebP attachments. Other binary formats need a text export.",
            );
          const text = Buffer.from(result.contentBase64, "base64").toString("utf8");
          return (
            text.slice(0, 200_000) +
            (text.length > 200_000 ? "\n[Document excerpt truncated at 200,000 characters.]" : "")
          );
        }
        if (input.resource === "promote" && notebook.update.status !== "current")
          return yield* fail(
            "The notebook is behind the discussion. Wait for Idea updates to finish or retry the update before promotion.",
          );
        const skillName = input.resource === "skill" ? input.id : "to-issues";
        if (skillName !== "to-issues" && skillName !== "to-prd" && skillName !== "to-spec")
          return yield* fail("Choose to-issues, to-prd or to-spec.");
        const skillRoots = [
          NodePath.join(NodeOS.homedir(), ".agents", "skills"),
          NodePath.join(NodeOS.homedir(), ".codex", "skills"),
        ];
        let skill: string | undefined;
        for (const skillRoot of skillRoots) {
          const target = NodePath.join(skillRoot, skillName, "SKILL.md");
          if (yield* fs.exists(target).pipe(Effect.mapError(asRuntimeError))) {
            skill = yield* fs.readFileString(target).pipe(Effect.mapError(asRuntimeError));
            break;
          }
        }
        if (!skill)
          return yield* fail(
            `Install the ${skillName} skill for this environment before using it.`,
          );
        if (input.resource === "skill") return skill;
        return [
          "Promotion uses this idea's existing thread. Read the pitch first, then relevant entries, documents and current main.",
          "Create optional PRD/spec documents with idea_write_document only when useful. Include requirements in ticket bodies. Never link tickets back to this idea or its files.",
          "Use idea_propose_issues to save the breakdown for user review. After the user approves it in T3, idea_publish_issues publishes and verifies it. Do not use shell commands or create another thread.",
          "The installed to-issues instructions follow. T3's scoped tools replace tracker CLI actions and preserve its review requirement.",
          skill,
          "Current pitch:",
          notebook.pitch.markdown,
        ].join("\n\n");
      });
      const importAttachments = Effect.fn("IdeaRuntime.importAttachments")(function* (
        threadId: ThreadId,
        attachments: readonly ChatAttachment[],
      ) {
        yield* active(threadId);
        for (const attachment of attachments) {
          if (attachment.type !== "image" && attachment.type !== "file") continue;
          if (
            parseThreadSegmentFromAttachmentId(attachment.id) !==
            toSafeThreadAttachmentSegment(threadId)
          )
            return yield* fail("The attachment does not belong to this idea.");
          const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
          if (!path) return yield* fail("The idea attachment is unavailable.");
          const bytes = yield* fs.readFile(path).pipe(Effect.mapError(asRuntimeError));
          yield* writeArtifact({
            threadId,
            name: attachment.name,
            mediaType: attachment.mimeType,
            contentBase64: Buffer.from(bytes).toString("base64"),
            sourceAttachmentId: attachment.id,
          });
        }
      });
      return IdeaRuntime.of({
        importAttachments,
        workingDirectory: (threadId) =>
          withIdeaLock(
            threadId,
            active(threadId).pipe(Effect.flatMap(() => ownedDirectory(threadId, true))),
          ),
        prepare,
        foregroundContext,
        readMain,
        readContext,
        writeArtifact,
        readArtifact,
        removeArtifact: (threadId, artifactId) =>
          withIdeaLock(
            threadId,
            Effect.gen(function* () {
              if (
                !(yield* fs
                  .exists(file(threadId, artifactId))
                  .pipe(Effect.mapError(asRuntimeError)))
              )
                return;
              yield* ownedDirectory(threadId);
              yield* fs
                .remove(file(threadId, artifactId), { force: true })
                .pipe(Effect.mapError(asRuntimeError));
            }),
          ),
        removeOwned: (threadId) =>
          withIdeaLock(
            threadId,
            Effect.gen(function* () {
              clearIdeaExecution(threadId);
              if (!(yield* fs.exists(root(threadId)).pipe(Effect.mapError(asRuntimeError)))) return;
              yield* ownedDirectory(threadId, false, false);
              yield* fs
                .remove(root(threadId), { recursive: true, force: true })
                .pipe(Effect.mapError(asRuntimeError));
            }),
          ),
      });
    }),
  );
}
