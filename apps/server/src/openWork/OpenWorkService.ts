import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  OpenWorkOperationError,
  OpenWorkDocument,
  OpenWorkFolderLink,
  ProjectId,
  ThreadId,
  type OpenWorkListInput,
  type OpenWorkListResult,
  type OpenWorkTimelineInput,
  type OpenWorkTimelineResult,
  type OpenWorkLinkFolderInput,
  type OpenWorkUnlinkFolderInput,
  type OpenWorkAssignDocumentInput,
  type OpenWorkFavoriteInput,
  type OpenWorkReadLinkedInput,
  type OpenWorkReadLinkedResult,
  type OpenWorkFavoritesResult,
} from "@t3tools/contracts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeGitReader } from "./GitReader.ts";
import { reconcileDocumentLinks, type OpenWorkDocumentRow } from "./PublicationRepository.ts";

type Input<S extends Schema.Top> = S["Type"];
export class OpenWorkService extends Context.Service<
  OpenWorkService,
  {
    readonly list: (
      input: Input<typeof OpenWorkListInput>,
    ) => Effect.Effect<Input<typeof OpenWorkListResult>, OpenWorkOperationError>;
    readonly timeline: (
      input: Input<typeof OpenWorkTimelineInput>,
    ) => Effect.Effect<OpenWorkTimelineResult, OpenWorkOperationError>;
    readonly linkFolder: (
      input: Input<typeof OpenWorkLinkFolderInput>,
    ) => Effect.Effect<OpenWorkFolderLink, OpenWorkOperationError>;
    readonly unlinkFolder: (
      input: Input<typeof OpenWorkUnlinkFolderInput>,
    ) => Effect.Effect<void, OpenWorkOperationError>;
    readonly assignDocument: (
      input: Input<typeof OpenWorkAssignDocumentInput>,
    ) => Effect.Effect<OpenWorkDocument, OpenWorkOperationError>;
    readonly favoriteDocument: (
      input: Input<typeof OpenWorkFavoriteInput>,
    ) => Effect.Effect<OpenWorkDocument, OpenWorkOperationError>;
    readonly favorites: (
      input?: object,
    ) => Effect.Effect<Input<typeof OpenWorkFavoritesResult>, OpenWorkOperationError>;
    readonly readLinkedDocument: (
      input: Input<typeof OpenWorkReadLinkedInput>,
    ) => Effect.Effect<OpenWorkReadLinkedResult, OpenWorkOperationError>;
  }
>()("t3/openWork/OpenWorkService") {
  static readonly layer = Layer.effect(
    OpenWorkService,
    Effect.gen(function* () {
      const projection = yield* ProjectionSnapshotQuery;
      return yield* makeOpenWorkService({ projects: () => projection.getProjectShells() });
    }),
  );
}

const failure = (reason: OpenWorkOperationError["reason"], message: string) =>
  new OpenWorkOperationError({ reason, message });
const isOpenWorkError = Schema.is(OpenWorkOperationError);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
interface FolderRow {
  id: string;
  worktree_id: string;
  path: string;
  time_link: OpenWorkFolderLink["timeLink"];
}
interface WorktreeRow {
  id: string;
  common_dir: string;
  path: string;
}
const decodeDocument = (row: OpenWorkDocumentRow): OpenWorkDocument => ({
  id: row.id,
  title: row.title,
  worktreeId: row.worktree_id,
  source:
    row.source === "published"
      ? {
          kind: "published",
          documentId: row.document_id ?? "",
          revisionId: row.revision_id ?? "",
          threadId: ThreadId.make(row.thread_id ?? ""),
        }
      : { kind: "linked", folderLinkId: row.folder_id ?? "", path: row.path ?? "" },
  step: row.commit_sha
    ? { kind: "commit", commitSha: row.commit_sha }
    : row.association_mode === "unassigned"
      ? { kind: "unassigned" }
      : { kind: "wip" },
  favorite: row.favorite === 1,
  available: row.available === 1,
  unresolved: row.unresolved,
});
const decodeFolder = (row: FolderRow): OpenWorkFolderLink => ({
  id: row.id,
  worktreeId: row.worktree_id,
  path: row.path,
  timeLink: row.time_link,
});

export const makeOpenWorkService = <E>(options: {
  projects: () => Effect.Effect<readonly { id: ProjectId; workspaceRoot: string }[], E>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* makeGitReader;
    const mutex = yield* Semaphore.make(1);
    const protect = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isOpenWorkError(cause) ? cause : failure("storage", "Could not read or save Open work."),
        ),
      );
    const readDocument = Effect.fnUntraced(function* (id: string) {
      const rows =
        yield* sql<OpenWorkDocumentRow>`SELECT * FROM open_work_documents WHERE id=${id}`;
      if (!rows[0]) return yield* failure("not-found", "Document link is unavailable.");
      return rows[0];
    });
    const requireWorktree = Effect.fnUntraced(function* (id: string) {
      const rows = yield* sql<WorktreeRow>`SELECT * FROM open_worktrees WHERE id=${id}`;
      if (!rows[0])
        return yield* failure("not-found", "Worktree is unavailable. Refresh Open work.");
      const identity = yield* git.identity(rows[0].path);
      if (identity.commonDir !== rows[0].common_dir)
        return yield* failure("conflict", "This path now belongs to a different repository.");
      return identity;
    });
    const list = Effect.fn("OpenWork.list")(function* (input: Input<typeof OpenWorkListInput>) {
      const projects = yield* options
        .projects()
        .pipe(Effect.mapError(() => failure("storage", "Could not read registered projects.")));
      const repositories = new Map<string, { cwd: string; projectIds: ProjectId[] }>();
      for (const project of projects) {
        if (input.projectIds && !input.projectIds.includes(project.id)) continue;
        const identity = yield* git.identity(project.workspaceRoot).pipe(Effect.result);
        if (identity._tag === "Failure") continue;
        const prior = repositories.get(identity.success.commonDir);
        if (prior) prior.projectIds.push(project.id);
        else
          repositories.set(identity.success.commonDir, {
            cwd: identity.success.path,
            projectIds: [project.id],
          });
      }
      const worktrees: Input<typeof OpenWorkListResult>["worktrees"][number][] = [];
      for (const [commonDir, repository] of repositories) {
        const entries = yield* git.inventory(repository.cwd);
        for (const entry of new Set(entries)) {
          if (!entry) continue;
          yield* sql`INSERT INTO open_worktrees (id,common_dir,path) VALUES (${entry},${commonDir},${entry}) ON CONFLICT(id) DO NOTHING`;
          const state = yield* git.state(entry);
          worktrees.push({
            id: entry,
            path: entry,
            projectIds: repository.projectIds,
            branch: state.branch,
            head: state.head,
            baseRef: state.baseRef,
            ahead: state.ahead,
            behind: state.behind,
            hasChanges: state.hasChanges,
          });
        }
      }
      return { worktrees };
    });
    const scanFolder = Effect.fn("OpenWork.scanFolder")(function* (
      folder: FolderRow,
      head: string | null,
      commits: readonly { sha: string; committedAt: string }[],
    ) {
      const discovered = new Set<string>();
      const visited = new Set<string>();
      const visit = (directory: string): Effect.Effect<void, OpenWorkOperationError> =>
        protect(
          Effect.gen(function* () {
            const resolved = yield* fs.realPath(directory);
            if (visited.has(resolved)) return;
            visited.add(resolved);
            const entries = yield* fs.readDirectory(directory);
            for (const entry of entries) {
              const target = path.join(directory, entry);
              const stat = yield* fs.stat(target).pipe(Effect.result);
              if (stat._tag === "Failure") continue;
              if (stat.success.type === "Directory") {
                yield* visit(target);
                continue;
              }
              if (stat.success.type !== "File" || !/\.(?:md|html)$/i.test(entry)) continue;
              const canonical = yield* fs.realPath(target);
              discovered.add(canonical);
              const existing =
                yield* sql<OpenWorkDocumentRow>`SELECT * FROM open_work_documents WHERE worktree_id=${folder.worktree_id} AND path=${canonical}`;
              if (existing[0]) {
                const owner =
                  yield* sql<FolderRow>`SELECT * FROM open_work_folders WHERE id=${existing[0].folder_id}`;
                yield* sql`UPDATE open_work_documents SET available=1,folder_id=${owner[0] ? existing[0].folder_id : folder.id} WHERE id=${existing[0].id}`;
                continue;
              }
              const timestamp =
                folder.time_link === "none"
                  ? null
                  : folder.time_link === "mtime"
                    ? stat.success.mtime
                    : stat.success.birthtime;
              const date =
                timestamp?._tag === "Some" && timestamp.value.getTime() > 0
                  ? timestamp.value.toISOString()
                  : null;
              const sha = date
                ? (commits.find((commit) => Date.parse(commit.committedAt) >= Date.parse(date))
                    ?.sha ?? null)
                : null;
              const id = `file:${NodeCrypto.createHash("sha256").update(`${folder.worktree_id}\0${canonical}`).digest("hex")}`;
              const now = DateTime.formatIso(yield* DateTime.now);
              yield* sql`INSERT INTO open_work_documents (id,worktree_id,title,source,folder_id,path,commit_sha,anchor_head,observed_at,unresolved,association_mode)
          VALUES (${id},${folder.worktree_id},${path.basename(canonical)},'linked',${folder.id},${canonical},${sha},${head},${date ?? now},${folder.time_link !== "none" && !date ? "creation-time-unavailable" : null},${folder.time_link === "none" ? "unassigned" : "pending"})`;
            }
          }),
        );
      const result = yield* visit(folder.path).pipe(Effect.result);
      if (result._tag === "Failure") {
        yield* sql`UPDATE open_work_documents SET available=0 WHERE folder_id=${folder.id}`;
        return;
      }
      const rows =
        yield* sql<OpenWorkDocumentRow>`SELECT * FROM open_work_documents WHERE folder_id=${folder.id}`;
      for (const row of rows)
        if (!row.path || !discovered.has(row.path))
          yield* sql`UPDATE open_work_documents SET available=0 WHERE id=${row.id}`;
    });
    const timeline = Effect.fn("OpenWork.timeline")(function* (
      input: Input<typeof OpenWorkTimelineInput>,
    ) {
      const worktree = yield* requireWorktree(input.worktreeId);
      const state = yield* git.state(worktree.path);
      const commits =
        state.head && state.baseRef
          ? yield* git.commits(worktree.path, `${state.baseRef}..HEAD`)
          : [];
      yield* sql.withTransaction(reconcileDocumentLinks(sql, git, worktree.id, state.head));
      const folders =
        yield* sql<FolderRow>`SELECT * FROM open_work_folders WHERE worktree_id=${worktree.id} ORDER BY path`;
      for (const folder of folders) yield* scanFolder(folder, state.head, commits);
      const documents =
        yield* sql<OpenWorkDocumentRow>`SELECT * FROM open_work_documents WHERE worktree_id=${worktree.id} AND (source='published' OR folder_id IN (SELECT id FROM open_work_folders)) ORDER BY observed_at,id`;
      const projects = yield* options
        .projects()
        .pipe(Effect.mapError(() => failure("storage", "Could not read registered projects.")));
      const projectIds: ProjectId[] = [];
      for (const project of projects) {
        const identity = yield* git.identity(project.workspaceRoot).pipe(Effect.result);
        if (identity._tag === "Success" && identity.success.commonDir === worktree.commonDir)
          projectIds.push(project.id);
      }
      return {
        worktree: {
          id: worktree.id,
          path: worktree.path,
          projectIds,
          branch: state.branch,
          head: state.head,
          baseRef: state.baseRef,
          ahead: state.ahead,
          behind: state.behind,
          hasChanges: state.hasChanges,
        },
        commits,
        wip: state.wip,
        documents: documents.map(decodeDocument),
        folderLinks: folders.map(decodeFolder),
      };
    });
    const mutate = <S extends Schema.Top, E>(
      input: { requestId: string },
      schema: S,
      effect: Effect.Effect<S["Type"], E>,
    ) =>
      mutex.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const payload = yield* encodeJson(input);
            const rows = yield* sql<{
              payload: string;
              result_json: string;
            }>`SELECT * FROM open_work_requests WHERE request_id=${input.requestId}`;
            if (rows[0]) {
              if (rows[0].payload !== payload)
                return yield* failure(
                  "conflict",
                  "Request ID was already used with different data.",
                );
              return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(rows[0].result_json);
            }
            const result = yield* effect;
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(schema))(result);
            yield* sql`INSERT INTO open_work_requests(request_id,payload,result_json) VALUES (${input.requestId},${payload},${encoded})`;
            return result;
          }),
        ),
      );
    const linkFolder = (input: Input<typeof OpenWorkLinkFolderInput>) =>
      mutate(
        input,
        OpenWorkFolderLink,
        Effect.gen(function* () {
          yield* requireWorktree(input.worktreeId);
          if (!path.isAbsolute(input.path))
            return yield* failure("invalid", "Choose an absolute folder path on this environment.");
          const folderPath = yield* fs.realPath(input.path);
          if ((yield* fs.stat(folderPath)).type !== "Directory")
            return yield* failure("invalid", "Choose a folder.");
          const existing =
            yield* sql<FolderRow>`SELECT * FROM open_work_folders WHERE worktree_id=${input.worktreeId} AND path=${folderPath}`;
          if (existing[0]) return decodeFolder(existing[0]);
          const id = NodeCrypto.randomUUID();
          yield* sql`INSERT INTO open_work_folders(id,worktree_id,path,time_link) VALUES (${id},${input.worktreeId},${folderPath},${input.timeLink})`;
          return { id, worktreeId: input.worktreeId, path: folderPath, timeLink: input.timeLink };
        }),
      );
    const unlinkFolder = (input: Input<typeof OpenWorkUnlinkFolderInput>) =>
      mutate(
        input,
        Schema.Null,
        Effect.gen(function* () {
          yield* sql`DELETE FROM open_work_folders WHERE id=${input.folderLinkId}`;
          const documents =
            yield* sql<OpenWorkDocumentRow>`SELECT * FROM open_work_documents WHERE folder_id=${input.folderLinkId}`;
          for (const document of documents) {
            const folders =
              yield* sql<FolderRow>`SELECT * FROM open_work_folders WHERE worktree_id=${document.worktree_id} ORDER BY path`;
            const replacement = folders.find((folder) => {
              if (!document.path) return false;
              const relative = path.relative(folder.path, document.path);
              return (
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relative)
              );
            });
            yield* sql`UPDATE open_work_documents SET folder_id=${replacement?.id ?? document.folder_id},available=${replacement ? document.available : 0} WHERE id=${document.id}`;
          }
          return null;
        }),
      ).pipe(Effect.asVoid);
    const assignDocument = (input: Input<typeof OpenWorkAssignDocumentInput>) =>
      mutate(
        input,
        OpenWorkDocument,
        Effect.gen(function* () {
          const row = yield* readDocument(input.documentId);
          if (row.source === "published" && input.step.kind === "unassigned")
            return yield* failure(
              "invalid",
              "Published documents belong to WIP or a saved commit.",
            );
          yield* requireWorktree(row.worktree_id);
          const state = yield* git.state(row.worktree_id);
          const sha =
            input.step.kind === "commit"
              ? yield* git.validateCommit(row.worktree_id, input.step.commitSha)
              : null;
          yield* sql`UPDATE open_work_documents SET commit_sha=${sha},anchor_head=${state.head},unresolved=NULL,association_mode=${input.step.kind === "unassigned" ? "unassigned" : "pending"} WHERE id=${row.id}`;
          return decodeDocument(yield* readDocument(row.id));
        }),
      );
    const favoriteDocument = (input: Input<typeof OpenWorkFavoriteInput>) =>
      mutate(
        input,
        OpenWorkDocument,
        Effect.gen(function* () {
          yield* readDocument(input.documentId);
          yield* sql`UPDATE open_work_documents SET favorite=${input.favorite ? 1 : 0} WHERE id=${input.documentId}`;
          return decodeDocument(yield* readDocument(input.documentId));
        }),
      );
    const favorites = Effect.fn("OpenWork.favorites")(function* () {
      const rows =
        yield* sql<OpenWorkDocumentRow>`SELECT * FROM open_work_documents WHERE favorite=1 ORDER BY title,id`;
      return { documents: rows.map(decodeDocument) };
    });
    const readLinkedDocument = Effect.fn("OpenWork.readLinkedDocument")(function* (
      input: Input<typeof OpenWorkReadLinkedInput>,
    ) {
      const row = yield* readDocument(input.documentId);
      if (row.source !== "linked" || !row.path)
        return yield* failure("invalid", "This document is a retained publication.");
      const folders =
        yield* sql<FolderRow>`SELECT * FROM open_work_folders WHERE id=${row.folder_id}`;
      if (!folders[0])
        return yield* failure("not-found", "This document's folder is no longer linked.");
      const stat = yield* fs.stat(row.path);
      if (stat.type !== "File")
        return yield* failure("not-found", "The linked document is unavailable.");
      if (Number(stat.size) > 2 * 1024 * 1024)
        return yield* failure("invalid", "Linked documents must be smaller than 2 MB.");
      const chunks = yield* fs
        .stream(row.path, { bytesToRead: 2 * 1024 * 1024 + 1 })
        .pipe(Stream.runCollect);
      const bytes = Buffer.concat(chunks);
      if (bytes.length > 2 * 1024 * 1024)
        return yield* failure("invalid", "Linked documents must be smaller than 2 MB.");
      const content = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => failure("invalid", "Linked documents must contain UTF-8 text."),
      });
      return {
        format: /\.html$/i.test(row.path) ? ("html" as const) : ("markdown" as const),
        content,
        truncated: false,
      };
    });
    return OpenWorkService.of({
      list: (input) => protect(list(input)),
      timeline: (input) => protect(mutex.withPermits(1)(timeline(input))),
      linkFolder: (input) => protect(linkFolder(input)),
      unlinkFolder: (input) => protect(unlinkFolder(input)),
      assignDocument: (input) => protect(assignDocument(input)),
      favoriteDocument: (input) => protect(favoriteDocument(input)),
      favorites: () => protect(favorites()),
      readLinkedDocument: (input) => protect(readLinkedDocument(input)),
    });
  });
