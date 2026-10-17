import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  OpenWorkListResult,
  OpenWorkTimelineResult,
  ProjectId,
  RpcScopeAuthorization,
  WsSatelliteRpcGroup,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SatelliteWsRpc from "../satellite/SatelliteWsRpc.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OpenWork from "./OpenWork.ts";

const encodeList = Schema.encodeSync(OpenWorkListResult);
const encodeTimeline = Schema.encodeSync(OpenWorkTimelineResult);

const testLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-open-work-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>, stdin?: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "OpenWork.test",
      cwd,
      args,
      timeoutMs: 60_000,
      ...(stdin === undefined ? {} : { stdin }),
    });
    return result.stdout.trim();
  });

const write = (cwd: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const commitAll = (cwd: string, message: string) =>
  git(cwd, ["add", "-A"]).pipe(Effect.andThen(git(cwd, ["commit", "-q", "-m", message])));

/** A repository on main with one commit, in a canonical temporary folder. */
const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-open-work-" }),
  );
  const repo = path.join(root, "repo");
  yield* fileSystem.makeDirectory(repo);
  yield* git(repo, ["init", "-q", "-b", "main"]);
  yield* git(repo, ["config", "user.email", "test@example.com"]);
  yield* git(repo, ["config", "user.name", "Test"]);
  yield* write(repo, "README.md", "one\n");
  yield* commitAll(repo, "main 1");
  return { root, repo, at: (...segments: ReadonlyArray<string>) => path.join(root, ...segments) };
});

/** Commits written straight into the object store, then checked out in `cwd`. */
const fastImport = (
  cwd: string,
  options: {
    readonly branch: string;
    readonly from: string;
    readonly commits: number;
    readonly filesPerCommit: number;
  },
) => {
  const lines: Array<string> = [];
  for (let commit = 0; commit < options.commits; commit++) {
    const message = `bulk ${commit + 1}`;
    lines.push(
      `commit refs/heads/${options.branch}`,
      `committer Test <test@example.com> ${1_700_000_000 + commit} +0000`,
      `data ${message.length}`,
      message,
    );
    if (commit === 0) lines.push(`from ${options.from}`);
    for (let file = 0; file < options.filesPerCommit; file++) {
      const contents = `commit ${commit} file ${file}\n`;
      lines.push(`M 100644 inline bulk/file-${file}.txt`, `data ${contents.length}`, contents);
    }
    lines.push("");
  }
  return git(cwd, ["fast-import", "--quiet"], lines.join("\n")).pipe(
    Effect.andThen(git(cwd, ["reset", "-q", "--hard"])),
  );
};

type TestProject = { readonly id: string; readonly workspaceRoot: string };

const projectStore = (projects: ReadonlyArray<TestProject>) =>
  Layer.succeed(ProjectStore.ProjectStoreV2, {
    listShells: (options?: { readonly projectIds?: ReadonlyArray<ProjectId> }) =>
      Effect.sync(() =>
        projects
          .map((project) => ({
            id: ProjectId.make(project.id),
            workspaceRoot: project.workspaceRoot,
          }))
          .filter((shell) => !options?.projectIds || options.projectIds.includes(shell.id)),
      ),
  } as unknown as ProjectStore.ProjectStoreV2["Service"]);

const openWorkFor = (projects: ReadonlyArray<TestProject>) =>
  Effect.gen(function* () {
    return yield* OpenWork.OpenWork;
  }).pipe(Effect.provide(OpenWork.layer.pipe(Layer.provide(projectStore(projects)))));

/** main at three commits; worktree A on `feature`, three commits ahead and two behind. */
const makeDiverged = Effect.gen(function* () {
  const fixture = yield* makeRepository;
  const a = fixture.at("a");
  yield* git(fixture.repo, ["worktree", "add", "-q", "-b", "feature", a]);
  for (const subject of ["a1", "a2", "a3"]) {
    yield* write(a, `${subject}.txt`, `${subject}\n`);
    yield* commitAll(a, subject);
  }
  for (const subject of ["main 2", "main 3"]) {
    yield* write(fixture.repo, "README.md", `${subject}\n`);
    yield* commitAll(fixture.repo, subject);
  }
  const service = yield* openWorkFor([{ id: "project", workspaceRoot: fixture.repo }]);
  return { ...fixture, a, service };
});

describe("Open work timeline", () => {
  it.effect("lists the commits beyond main oldest first with ahead and behind counts", () =>
    Effect.gen(function* () {
      const f = yield* makeDiverged;
      const view = yield* f.service.timeline({ path: f.a });
      assert.deepStrictEqual(
        view.commits.map((commit) => [commit.subject, commit.files.map((file) => file.path)]),
        [
          ["a1", ["a1.txt"]],
          ["a2", ["a2.txt"]],
          ["a3", ["a3.txt"]],
        ],
      );
      assert.deepStrictEqual(
        {
          path: view.worktree.path,
          branch: view.worktree.branch,
          baseRef: view.worktree.baseRef,
          ahead: view.worktree.ahead,
          behind: view.worktree.behind,
          primary: view.worktree.primary,
          projectIds: view.worktree.projectIds,
        },
        {
          path: f.a,
          branch: "feature",
          baseRef: "main",
          ahead: 3,
          behind: 2,
          primary: false,
          projectIds: [ProjectId.make("project")],
        },
      );
      assert.deepStrictEqual(view.wip, {
        files: [],
        insertions: 0,
        deletions: 0,
        truncated: false,
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("compares a merge with its first parent and reports renames and deletes", () =>
    Effect.gen(function* () {
      const f = yield* makeDiverged;
      yield* git(f.a, ["mv", "a1.txt", "renamed a1.txt"]);
      yield* git(f.a, ["rm", "-q", "a2.txt"]);
      yield* commitAll(f.a, "rename and delete");
      yield* git(f.a, ["switch", "-q", "-c", "side"]);
      yield* write(f.a, "side.txt", "side\n");
      yield* commitAll(f.a, "side");
      yield* git(f.a, ["switch", "-q", "feature"]);
      yield* write(f.a, "a3.txt", "first parent\n");
      yield* commitAll(f.a, "first parent");
      const firstParent = yield* git(f.a, ["rev-parse", "HEAD"]);
      yield* git(f.a, ["merge", "-q", "--no-ff", "side", "-m", "merge side"]);

      const view = yield* f.service.timeline({ path: f.a });
      const rename = view.commits.find((commit) => commit.subject === "rename and delete");
      assert.deepStrictEqual(rename?.files, [
        { path: "a2.txt", previousPath: null, status: "deleted", insertions: 0, deletions: 1 },
        {
          path: "renamed a1.txt",
          previousPath: "a1.txt",
          status: "renamed",
          insertions: 0,
          deletions: 0,
        },
      ]);
      const merge = view.commits.at(-1);
      assert.strictEqual(merge?.subject, "merge side");
      assert.strictEqual(merge?.parents[0], firstParent);
      assert.deepStrictEqual(merge?.files, [
        { path: "side.txt", previousPath: null, status: "added", insertions: 1, deletions: 0 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shows a root commit as added files and an empty range when HEAD is main", () =>
    Effect.gen(function* () {
      const f = yield* makeDiverged;
      const orphan = f.at("orphan");
      yield* git(f.repo, ["worktree", "add", "-q", "--orphan", "-b", "fresh", orphan]);
      yield* write(orphan, "new.txt", "new\n");
      yield* commitAll(orphan, "root");

      const root = yield* f.service.timeline({ path: orphan });
      assert.deepStrictEqual(
        root.commits.map((commit) => ({ parents: commit.parents, files: commit.files })),
        [
          {
            parents: [],
            files: [
              { path: "new.txt", previousPath: null, status: "added", insertions: 1, deletions: 0 },
            ],
          },
        ],
      );
      const primary = yield* f.service.timeline({ path: f.repo });
      assert.deepStrictEqual(
        [
          primary.commits,
          primary.worktree.ahead,
          primary.worktree.behind,
          primary.worktree.primary,
        ],
        [[], 0, 0, true],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps the WIP step and null counts when no main exists", () =>
    Effect.gen(function* () {
      const f = yield* makeDiverged;
      yield* git(f.repo, ["branch", "-q", "-m", "main", "trunk"]);
      yield* write(f.a, "loose.txt", "loose\n");

      const view = yield* f.service.timeline({ path: f.a });
      assert.deepStrictEqual(
        [view.worktree.baseRef, view.worktree.ahead, view.worktree.behind, view.commits],
        [null, null, null, []],
      );
      assert.deepStrictEqual(
        view.wip.files.map((file) => [file.path, file.layer]),
        [["loose.txt", "untracked"]],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("caps commits, files per commit, and WIP files with truncated flags", () =>
    Effect.gen(function* () {
      const f = yield* makeDiverged;
      const head = yield* git(f.a, ["rev-parse", "HEAD"]);
      yield* fastImport(f.a, { branch: "feature", from: head, commits: 198, filesPerCommit: 1 });
      for (let file = 0; file < 201; file++) yield* write(f.a, `wide/${file}.txt`, "x\n");
      yield* commitAll(f.a, "wide");
      for (let file = 0; file < 501; file++) yield* write(f.a, `loose/${file}.txt`, "x\n");

      const view = yield* f.service.timeline({ path: f.a });
      // a1..a3, 198 bulk commits, and "wide" make 202; the two oldest drop.
      assert.deepStrictEqual(
        {
          count: view.commits.length,
          truncated: view.commitsTruncated,
          oldest: view.commits[0]?.subject,
          newest: view.commits.at(-1)?.subject,
          newestFiles: view.commits.at(-1)?.files.length,
          newestTruncated: view.commits.at(-1)?.filesTruncated,
          wipFiles: view.wip.files.length,
          wipTruncated: view.wip.truncated,
          ahead: view.worktree.ahead,
        },
        {
          count: 200,
          truncated: true,
          oldest: "a3",
          newest: "wide",
          newestFiles: 200,
          newestTruncated: true,
          wipFiles: 500,
          wipTruncated: true,
          ahead: 202,
        },
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("groups staged, unstaged, and untracked files with a double-layer file twice", () =>
    Effect.gen(function* () {
      const f = yield* makeDiverged;
      yield* write(f.a, "a1.txt", "staged\n");
      yield* git(f.a, ["add", "a1.txt"]);
      yield* write(f.a, "a2.txt", "unstaged\n");
      yield* write(f.a, "a3.txt", "staged\n");
      yield* git(f.a, ["add", "a3.txt"]);
      yield* write(f.a, "a3.txt", "staged\nthen edited\n");
      yield* write(f.a, "new folder/untracked.txt", "one\ntwo\n");

      const view = yield* f.service.timeline({ path: f.a });
      assert.deepStrictEqual(
        view.wip.files.map((file) => [file.path, file.layer, file.status, file.insertions]),
        [
          ["a1.txt", "staged", "modified", 1],
          ["a2.txt", "unstaged", "modified", 1],
          ["a3.txt", "staged", "modified", 1],
          ["a3.txt", "unstaged", "modified", 1],
          ["new folder/untracked.txt", "untracked", "added", 0],
        ],
      );
      assert.deepStrictEqual([view.wip.insertions, view.wip.deletions], [4, 3]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("Open work list", () => {
  it.effect("counts ahead and behind against the best main candidate", () =>
    Effect.gen(function* () {
      const f = yield* makeDiverged;
      const mainOne = yield* git(f.repo, ["rev-parse", "HEAD~2"]);
      yield* git(f.repo, ["worktree", "add", "-q", "-b", "behind/only", f.at("behind"), mainOne]);
      yield* git(f.repo, ["worktree", "add", "-q", "-b", "ahead/only", f.at("ahead")]);
      yield* write(f.at("ahead"), "ahead.txt", "ahead\n");
      yield* commitAll(f.at("ahead"), "ahead");
      const counts = (result: OpenWorkListResult) =>
        result.worktrees.map((worktree) => [
          worktree.branch,
          worktree.baseRef,
          worktree.ahead,
          worktree.behind,
        ]);

      assert.deepStrictEqual(counts(yield* f.service.list({})), [
        ["main", "main", 0, 0],
        ["feature", "main", 3, 2],
        ["ahead/only", "main", 1, 0],
        ["behind/only", "main", 0, 2],
      ]);

      // origin's main wins over local main, even when it is older.
      yield* git(f.repo, ["update-ref", "refs/remotes/origin/main", mainOne]);
      assert.deepStrictEqual((yield* f.service.list({})).worktrees[0]?.baseRef, "origin/main");
      assert.deepStrictEqual(counts(yield* f.service.list({}))[0], ["main", "origin/main", 2, 0]);

      yield* git(f.repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
      yield* git(f.repo, ["branch", "-q", "-m", "main", "master"]);
      assert.deepStrictEqual(counts(yield* f.service.list({}))[1], ["feature", "master", 3, 2]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("lists detached, slashed, and outside worktrees once and skips prunable ones", () =>
    Effect.gen(function* () {
      const f = yield* makeDiverged;
      const fileSystem = yield* FileSystem.FileSystem;
      const head = yield* git(f.repo, ["rev-parse", "HEAD"]);
      yield* git(f.repo, ["worktree", "add", "-q", "--detach", f.at("detached"), head]);
      yield* git(f.repo, ["worktree", "add", "-q", "-b", "gone", f.at("gone")]);
      yield* fileSystem.remove(f.at("gone"), { recursive: true });
      // Two projects in one repository: the checkout and a folder inside it.
      yield* write(f.repo, "packages/inner/index.ts", "");
      yield* commitAll(f.repo, "inner");
      const service = yield* openWorkFor([
        { id: "outer", workspaceRoot: f.repo },
        { id: "inner", workspaceRoot: `${f.repo}/packages/inner` },
      ]);

      const listed = yield* service.list({});
      assert.deepStrictEqual(
        listed.worktrees.map((worktree) => [
          worktree.path,
          worktree.branch,
          worktree.head === head,
          worktree.primary,
          worktree.projectIds.join(","),
        ]),
        [
          [f.repo, "main", false, true, "outer,inner"],
          [f.a, "feature", false, false, "outer,inner"],
          [f.at("detached"), null, true, false, "outer,inner"],
        ],
      );
      assert.deepStrictEqual(
        (yield* service.list({ projectIds: [ProjectId.make("inner")] })).worktrees.map((worktree) =>
          worktree.projectIds.join(","),
        )[0],
        "inner",
      );

      yield* git(f.repo, ["worktree", "remove", f.at("detached")]);
      assert.deepStrictEqual(
        (yield* service.list({})).worktrees.map((worktree) => worktree.path),
        [f.repo, f.a],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("skips a bare repository's own entry and lists its linked worktrees", () =>
    Effect.gen(function* () {
      const f = yield* makeRepository;
      const bare = f.at("bare.git");
      yield* git(f.root, ["clone", "-q", "--bare", f.repo, bare]);
      yield* git(bare, ["worktree", "add", "-q", "-b", "linked", f.at("linked")]);
      const service = yield* openWorkFor([{ id: "linked", workspaceRoot: f.at("linked") }]);

      assert.deepStrictEqual(
        (yield* service.list({})).worktrees.map((worktree) => [
          worktree.path,
          worktree.branch,
          worktree.primary,
        ]),
        [[f.at("linked"), "linked", false]],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps the 30-worktree list within its payload budget", () =>
    Effect.gen(function* () {
      const f = yield* makeRepository;
      for (let index = 0; index < 29; index++) {
        yield* git(f.repo, [
          "worktree",
          "add",
          "-q",
          "-b",
          `feature/worktree-${index}`,
          f.at("worktrees", `worktree-${index}`),
        ]);
      }
      const service = yield* openWorkFor([{ id: "project", workspaceRoot: f.repo }]);
      const listed = yield* service.list({});
      const bytes = new TextEncoder().encode(JSON.stringify(encodeList(listed))).byteLength;
      assert.strictEqual(listed.worktrees.length, 30);
      assert.isAtMost(bytes, 16 * 1024);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("Open work diff", () => {
  it.effect("keeps a commit's file diff fixed after later commits land", () =>
    Effect.gen(function* () {
      const f = yield* makeDiverged;
      const second = yield* git(f.a, ["rev-parse", "HEAD~1"]);
      const read = f.service.diff({
        path: f.a,
        step: { kind: "commit", sha: second },
        file: { path: "a2.txt", previousPath: null },
      });
      const before = yield* read;
      yield* write(f.a, "a2.txt", "a2\nlater\n");
      yield* commitAll(f.a, "later");

      const after = yield* read;
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(
        [after.title, after.headRef, after.files, after.truncated],
        [
          `${second.slice(0, 7)} · a2`,
          second,
          [{ path: "a2.txt", previousPath: null, additions: 1, deletions: 0 }],
          false,
        ],
      );
      assert.include(after.diff, "+++ b/a2.txt\n@@ -0,0 +1 @@\n+a2");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shows an untracked WIP file in a new folder as fully added", () =>
    Effect.gen(function* () {
      const f = yield* makeDiverged;
      yield* write(f.a, "new folder/untracked.txt", "one\ntwo\n");

      const result = yield* f.service.diff({
        path: f.a,
        step: { kind: "wip" },
        file: { path: "new folder/untracked.txt", previousPath: null },
      });
      assert.deepStrictEqual(result.files, [
        { path: "new folder/untracked.txt", previousPath: null, additions: 2, deletions: 0 },
      ]);
      assert.include(result.diff, "new file mode");
      assert.include(result.diff, "+one\n+two");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refuses paths outside every registered repository", () =>
    Effect.gen(function* () {
      const f = yield* makeDiverged;
      const other = yield* makeRepository;
      const failures = yield* Effect.forEach([other.repo, f.at("missing"), f.root], (path) =>
        f.service
          .diff({ path, step: { kind: "wip" }, file: { path: "README.md", previousPath: null } })
          .pipe(Effect.flip),
      );
      assert.deepStrictEqual(
        failures.map((failure) => [failure._tag, "path" in failure ? failure.path : null]),
        [
          ["OpenWorkWorktreeNotFoundError", other.repo],
          ["OpenWorkWorktreeNotFoundError", f.at("missing")],
          ["OpenWorkWorktreeNotFoundError", f.root],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("Open work payload", () => {
  it.effect("encodes a 50-commit, eight-files-per-commit timeline within 64 KB", () =>
    Effect.gen(function* () {
      const f = yield* makeRepository;
      const head = yield* git(f.repo, ["rev-parse", "HEAD"]);
      yield* git(f.repo, ["switch", "-q", "-c", "feature"]);
      yield* git(f.repo, ["branch", "-q", "-f", "main", head]);
      yield* fastImport(f.repo, { branch: "feature", from: head, commits: 50, filesPerCommit: 8 });
      const service = yield* openWorkFor([{ id: "project", workspaceRoot: f.repo }]);

      const view = yield* service.timeline({ path: f.repo });
      const bytes = new TextEncoder().encode(JSON.stringify(encodeTimeline(view))).byteLength;
      assert.deepStrictEqual(
        [view.commits.length, view.commits.every((commit) => commit.files.length === 8)],
        [50, true],
      );
      assert.isAtMost(bytes, 64 * 1024);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("Open work RPCs", () => {
  const session = {
    sessionId: AuthSessionId.make("open-work-rpc"),
    subject: "open-work-rpc",
    method: "browser-session-cookie",
    scopes: [],
  } as const;

  const call = (scopes: ReadonlyArray<AuthEnvironmentScope>, method: "list" | "diff") =>
    Effect.gen(function* () {
      const f = yield* makeDiverged;
      const makeLayer = yield* SatelliteWsRpc.makeConnectionLayer.pipe(
        Effect.provideService(OpenWork.OpenWork, f.service),
      );
      const client = yield* RpcTest.makeClient(
        WsSatelliteRpcGroup.middleware(RpcScopeAuthorization),
      ).pipe(Effect.provide(Layer.merge(makeLayer(session), RpcAuthorization.layer(scopes))));
      if (method === "list") {
        return yield* client["openWork.list"]({}).pipe(
          Effect.map((result) => result.worktrees.length),
          Effect.catch((error) => Effect.succeed(error._tag)),
        );
      }
      return yield* client["openWork.diff"]({
        path: f.root,
        step: { kind: "wip" },
        file: { path: "README.md", previousPath: null },
      }).pipe(Effect.catch((error) => Effect.succeed(error._tag)));
    });

  it.effect("serves list with orchestration read and diff only with filesystem read", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        [
          yield* call([AuthOrchestrationReadScope], "list"),
          yield* call([AuthOrchestrationReadScope], "diff"),
          yield* call([AuthFilesystemReadScope], "diff"),
        ],
        [2, "EnvironmentAuthorizationError", "OpenWorkWorktreeNotFoundError"],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
