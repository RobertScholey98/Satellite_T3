import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import migration from "../persistence/Migrations/057_OpenWork.ts";
import { makeOpenWorkService } from "./OpenWorkService.ts";
import { makePublicationRecorder } from "./PublicationRepository.ts";

const layer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  VcsProcess.layer.pipe(Layer.provide(ProcessRunner.layer)),
).pipe(Layer.provideMerge(NodeServices.layer));
const setup = Effect.gen(function* () {
  yield* migration;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* VcsProcess.VcsProcess;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-work-" });
  const cwd = path.join(root, "repo");
  yield* fs.makeDirectory(cwd);
  const run = (args: readonly string[], at = cwd, commitDate?: string) =>
    processes
      .run({
        operation: "OpenWork.test",
        command: "git",
        cwd: at,
        args,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          ...(commitDate ? { GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate } : {}),
        },
      })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* run(["init", "-b", "main"]);
  yield* fs.writeFileString(path.join(cwd, "code.txt"), "main\n");
  yield* run(["add", "."]);
  yield* run(["commit", "-m", "main"]);
  const main = yield* run(["rev-parse", "HEAD"]);
  yield* run(["switch", "-c", "feature"]);
  const projectId = ProjectId.make("open-project");
  const options = { projects: () => Effect.succeed([{ id: projectId, workspaceRoot: cwd }]) };
  const service = yield* makeOpenWorkService(options);
  const record = yield* makePublicationRecorder;
  const sql = yield* SqlClient.SqlClient;
  const publish = (revisionId: string) =>
    sql.withTransaction(
      record({
        documentId: "document",
        revisionId,
        threadId: ThreadId.make("thread"),
        title: revisionId,
        worktreePath: cwd,
      }),
    );
  const worktreeId = (yield* service.list({})).worktrees[0]!.id;
  return { fs, path, root, cwd, run, main, options, service, publish, record, sql, worktreeId };
});

describe("Open work", () => {
  it.effect(
    "does not present shared history when main is unavailable and does not substitute missing creation time",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.run(["branch", "-m", "main", "trunk"]);
        const folder = f.path.join(f.root, "birthtime");
        yield* f.fs.makeDirectory(folder);
        const file = f.path.join(folder, "report.md");
        yield* f.fs.writeFileString(file, "birthtime unavailable");
        const service = yield* makeOpenWorkService(f.options).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            stat: (target) =>
              f.fs.stat(target).pipe(
                Effect.map((stat) =>
                  target === file
                    ? {
                        ...stat,
                        birthtime: Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(0))),
                      }
                    : stat,
                ),
              ),
          }),
        );
        yield* service.linkFolder({
          requestId: "birthtime",
          worktreeId: f.worktreeId,
          path: folder,
          timeLink: "birthtime",
        });
        const view = yield* service.timeline({ worktreeId: f.worktreeId });
        assert.equal(view.worktree.baseRef, null);
        assert.equal(view.worktree.ahead, null);
        assert.deepEqual(view.commits, []);
        assert.equal(view.documents[0]?.unresolved, "creation-time-unavailable");
        yield* f.fs.writeFileString(f.path.join(f.cwd, "code.txt"), "next\n");
        yield* f.run(["commit", "-am", "next"]);
        assert.equal(
          (yield* service.timeline({ worktreeId: f.worktreeId })).documents[0]?.step.kind,
          "wip",
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect(
    "locks each publication to the first external commit across restart and preserves earlier provenance",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.publish("revision-one");
        yield* f.fs.writeFileString(f.path.join(f.cwd, "code.txt"), "first\n");
        yield* f.run(["commit", "-am", "first"]);
        const first = yield* f.run(["rev-parse", "HEAD"]);
        yield* f.fs.writeFileString(f.path.join(f.cwd, "code.txt"), "second\n");
        yield* f.run(["commit", "-am", "second"]);
        yield* f.publish("revision-two");
        const restarted = yield* makeOpenWorkService(f.options);
        let view = yield* restarted.timeline({ worktreeId: f.worktreeId });
        assert.deepEqual(
          view.commits.map((commit) => commit.subject),
          ["first", "second"],
        );
        assert.deepEqual(view.documents[0]?.step, { kind: "commit", commitSha: first });
        assert.deepEqual(view.documents[1]?.step, { kind: "wip" });
        yield* f.fs.writeFileString(f.path.join(f.cwd, "code.txt"), "third\n");
        yield* f.run(["commit", "-am", "third"]);
        const third = yield* f.run(["rev-parse", "HEAD"]);
        view = yield* restarted.timeline({ worktreeId: f.worktreeId });
        assert.deepEqual(
          view.documents.map((document) => document.step),
          [
            { kind: "commit", commitSha: first },
            { kind: "commit", commitSha: third },
          ],
        );
        const rows = yield* f.sql<{
          revision_id: string;
          worktree_id: string;
        }>`SELECT revision_id,worktree_id FROM open_work_documents ORDER BY id`;
        assert.deepEqual(
          rows.map((row) => row.worktree_id),
          [f.worktreeId, f.worktreeId],
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "includes detached and shared worktrees with divergence against main and staged/unstaged/untracked WIP",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        const detached = f.path.join(f.root, "detached");
        yield* f.run(["worktree", "add", "--detach", detached, f.main]);
        yield* f.fs.makeDirectory(f.path.join(f.cwd, "subdir"));
        const service = yield* makeOpenWorkService({
          projects: () =>
            Effect.succeed([
              { id: ProjectId.make("one"), workspaceRoot: f.cwd },
              { id: ProjectId.make("two"), workspaceRoot: f.path.join(f.cwd, "subdir") },
            ]),
        });
        yield* f.fs.writeFileString(f.path.join(f.cwd, "code.txt"), "saved\n");
        yield* f.run(["commit", "-am", "feature"]);
        yield* f.run(["branch", "upstream-feature"]);
        yield* f.run(["branch", "--set-upstream-to", "upstream-feature"]);
        yield* f.fs.writeFileString(f.path.join(f.cwd, "staged.txt"), "staged\n");
        yield* f.run(["add", "staged.txt"]);
        yield* f.fs.writeFileString(f.path.join(f.cwd, "code.txt"), "live\n");
        yield* f.fs.writeFileString(f.path.join(f.cwd, "new.txt"), "new\n");
        const list = yield* service.list({});
        assert.equal(list.worktrees.length, 2);
        assert.equal(list.worktrees.find((tree) => tree.path.endsWith("detached"))?.branch, null);
        const current = list.worktrees.find((tree) => tree.branch === "feature")!;
        assert.deepEqual(current.projectIds, [ProjectId.make("one"), ProjectId.make("two")]);
        assert.equal(current.ahead, 1);
        assert.equal(current.behind, 0);
        const view = yield* service.timeline({ worktreeId: current.id });
        assert.deepEqual(
          view.wip.files.map((file) => file.path),
          ["code.txt", "new.txt", "staged.txt"],
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "discovers nested live files once across overlapping links, preserves commit links, and unpins unavailable favorites",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        const folder = f.path.join(f.root, "docs");
        const nested = f.path.join(folder, "nested");
        yield* f.fs.makeDirectory(nested, { recursive: true });
        const file = f.path.join(nested, "report.md");
        yield* f.fs.writeFileString(file, "original");
        const parent = yield* f.service.linkFolder({
          requestId: "folder",
          worktreeId: f.worktreeId,
          path: folder,
          timeLink: "none",
        });
        yield* f.service.linkFolder({
          requestId: "nested",
          worktreeId: f.worktreeId,
          path: nested,
          timeLink: "mtime",
        });
        let view = yield* f.service.timeline({ worktreeId: f.worktreeId });
        assert.equal(view.documents.length, 1);
        const document = view.documents[0]!;
        assert.deepEqual(document.step, { kind: "unassigned" });
        yield* f.fs.writeFileString(f.path.join(f.cwd, "code.txt"), "new commit\n");
        yield* f.run(["commit", "-am", "later"]);
        assert.deepEqual(
          (yield* f.service.timeline({ worktreeId: f.worktreeId })).documents[0]?.step,
          { kind: "unassigned" },
        );
        yield* f.service.assignDocument({
          requestId: "assign",
          documentId: document.id,
          step: { kind: "commit", commitSha: f.main },
        });
        yield* f.service.favoriteDocument({
          requestId: "pin",
          documentId: document.id,
          favorite: true,
        });
        yield* f.fs.writeFileString(file, "edited live");
        assert.equal(
          (yield* f.service.readLinkedDocument({ documentId: document.id })).content,
          "edited live",
        );
        yield* f.fs.writeFileString(f.path.join(folder, "new.html"), "<h1>New</h1>");
        view = yield* f.service.timeline({ worktreeId: f.worktreeId });
        assert.equal(view.documents.length, 2);
        assert.deepEqual(view.documents.find((entry) => entry.id === document.id)?.step, {
          kind: "commit",
          commitSha: f.main,
        });
        yield* f.service.unlinkFolder({ requestId: "remove-parent", folderLinkId: parent.id });
        assert.equal(
          (yield* f.service.readLinkedDocument({ documentId: document.id })).content,
          "edited live",
        );
        view = yield* f.service.timeline({ worktreeId: f.worktreeId });
        assert.equal(view.documents.length, 1);
        yield* f.fs.remove(file);
        yield* f.service.timeline({ worktreeId: f.worktreeId });
        assert.equal((yield* f.service.favorites()).documents[0]?.available, false);
        yield* f.service.favoriteDocument({
          requestId: "unpin",
          documentId: document.id,
          favorite: false,
        });
        assert.deepEqual((yield* f.service.favorites()).documents, []);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "time linking compares actual instants across commit timezone offsets and keeps the initial association",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.fs.writeFileString(f.path.join(f.cwd, "code.txt"), "early\n");
        yield* f.run(["commit", "-am", "early"], f.cwd, "2020-01-01T10:00:00+02:00");
        yield* f.fs.writeFileString(f.path.join(f.cwd, "code.txt"), "later\n");
        yield* f.run(["commit", "-am", "later"], f.cwd, "2020-01-01T09:30:00+00:00");
        const later = yield* f.run(["rev-parse", "HEAD"]);
        const folder = f.path.join(f.root, "timed");
        yield* f.fs.makeDirectory(folder);
        const file = f.path.join(folder, "report.md");
        yield* f.fs.writeFileString(file, "timed");
        yield* f.fs.utimes(
          file,
          Date.parse("2020-01-01T09:00:00Z") / 1000,
          Date.parse("2020-01-01T09:00:00Z") / 1000,
        );
        yield* f.service.linkFolder({
          requestId: "time",
          worktreeId: f.worktreeId,
          path: folder,
          timeLink: "mtime",
        });
        const view = yield* f.service.timeline({ worktreeId: f.worktreeId });
        assert.deepEqual(view.documents[0]?.step, { kind: "commit", commitSha: later });
        yield* f.fs.writeFileString(file, "edited");
        assert.deepEqual(
          (yield* f.service.timeline({ worktreeId: f.worktreeId })).documents[0]?.step,
          { kind: "commit", commitSha: later },
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "preserves unresolved WIP after branch rewrite and makes mutation replay idempotent",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.fs.writeFileString(f.path.join(f.cwd, "code.txt"), "anchor\n");
        yield* f.run(["commit", "-am", "anchor"]);
        yield* f.publish("pending");
        yield* f.run(["reset", "--hard", f.main]);
        let view = yield* f.service.timeline({ worktreeId: f.worktreeId });
        assert.equal(view.documents[0]?.unresolved, "history-diverged");
        const input = { requestId: "pin", documentId: view.documents[0]!.id, favorite: true };
        const first = yield* f.service.favoriteDocument(input);
        assert.deepEqual(yield* f.service.favoriteDocument(input), first);
        assert.equal(
          (yield* f.service.favoriteDocument({ ...input, favorite: false }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        view = yield* f.service.timeline({ worktreeId: f.worktreeId });
        assert.deepEqual(view.documents[0]?.step, { kind: "wip" });
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
