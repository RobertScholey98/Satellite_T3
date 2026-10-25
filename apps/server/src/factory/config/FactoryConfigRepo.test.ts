import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as FactoryConfigRepo from "./FactoryConfigRepo.ts";

const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-config-repo-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const ISOLATED_GIT_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;

/** Git reads the user's own config and identity otherwise; each test sees an empty one. */
const isolatedGit = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const emptyConfig = yield* fs.makeTempFileScoped({ prefix: "t3-gitconfig-" });
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const saved = ISOLATED_GIT_KEYS.map((key) => [key, process.env[key]] as const);
      for (const key of ISOLATED_GIT_KEYS) delete process.env[key];
      Object.assign(process.env, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" });
      return saved;
    }),
    (saved) =>
      Effect.sync(() => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );
});

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return (yield* driver.execute({ operation: "FactoryConfigRepo.test", cwd, args })).stdout;
  });

/** A factory directory on one machine, with its own repo and, unless told otherwise, identity. */
const machine = (name: string, options: { readonly identity?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: `t3-factory-${name}-` });
    const directory = path.join(root, "factory");
    const backupsDirectory = path.join(root, "factory-backups");
    yield* fs.makeDirectory(directory);
    yield* git(directory, ["init", "--quiet"]);
    if (options.identity !== false) {
      yield* git(directory, ["config", "user.name", `Machine ${name}`]);
      yield* git(directory, ["config", "user.email", `${name}@example.com`]);
    }
    /** A new service on the same directory, as after a server restart. */
    const reopen = FactoryConfigRepo.FactoryConfigRepo.pipe(
      Effect.provide(FactoryConfigRepo.layerAt(directory)),
    );
    const repo = yield* reopen;
    const file = (relativePath: string) => path.join(directory, ...relativePath.split("/"));
    const write = (relativePath: string, contents: string) =>
      fs
        .makeDirectory(path.dirname(file(relativePath)), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(file(relativePath), contents)));
    const read = (relativePath: string) => fs.readFileString(file(relativePath));
    return { repo, reopen, directory, backupsDirectory, file, write, read };
  });

/** Git whose next command with `arg` waits, before it runs, until released. */
const holdingGit = (arg: string) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let armed = true;
    const driver = GitVcsDriver.GitVcsDriver.of({
      ...git,
      execute: (input) => {
        if (!armed || !input.args.includes(arg)) return git.execute(input);
        armed = false;
        return Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(git.execute(input)),
        );
      },
    });
    return { driver, started, release };
  });

const bareRemote = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-remote-" });
  const remote = path.join(root, "config.git");
  yield* git(root, ["init", "--bare", "--quiet", remote]);
  return remote;
});

/** A remote holding A's first push and B checked out from it. */
const connectedPair = Effect.gen(function* () {
  const remote = yield* bareRemote;
  const a = yield* machine("a");
  const b = yield* machine("b");
  yield* a.write("workers/implementer.md", "implementer v1\n");
  yield* a.write("workers/reviewer.md", "reviewer v1\n");
  yield* a.repo.connect({ url: remote });
  yield* b.repo.connect({ url: remote });
  return { remote, a, b };
});

const live = <A, E>(
  name: string,
  body: () => Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | GitVcsDriver.GitVcsDriver | Scope.Scope
  >,
) =>
  it.live(name, () =>
    Effect.gen(function* () {
      yield* isolatedGit;
      return yield* body();
    }).pipe(Effect.scoped, Effect.provide(gitLayer)),
  );

describe("FactoryConfigRepo", () => {
  live("connects to an empty repo, then a second machine chooses to use it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const remote = yield* bareRemote;
      const a = yield* machine("a");
      yield* a.write("workers/implementer.md", "implementer v1\n");
      yield* a.write("roles/reviewer.md", "a's reviewer override\n");

      // The role files are never committed, so they are not a local change either.
      const connected = yield* a.repo.connect({ url: remote });
      assert.deepStrictEqual(connected, {
        outcome: "connected",
        status: {
          connected: true,
          remoteUrl: remote,
          branch: "main",
          localChanges: [],
          unpushedCommits: 0,
          incomingCommits: 0,
          conflict: null,
        },
      });

      const b = yield* machine("b");
      yield* b.write("workers/notes.md", "b's own worker\n");
      yield* b.write("roles/lead.md", "b's lead override\n");
      assert.deepStrictEqual(yield* b.repo.connect({ url: remote }), { outcome: "needs-choice" });
      assert.deepStrictEqual(yield* b.repo.status, { connected: false });
      assert.strictEqual(yield* b.read("workers/notes.md"), "b's own worker\n");

      const used = yield* b.repo.connect({ url: remote, choice: "use-repo" });
      assert.deepInclude(used, { outcome: "connected" });
      assert.deepInclude(used.outcome === "connected" ? used.status : {}, { localChanges: [] });
      assert.strictEqual(yield* b.read("workers/implementer.md"), "implementer v1\n");
      assert.strictEqual(yield* fs.exists(b.file("workers/notes.md")), false);
      assert.strictEqual(yield* fs.exists(b.file("roles/reviewer.md")), false);
      assert.strictEqual(
        yield* fs.readFileString(`${b.backupsDirectory}/1/workers/notes.md`),
        "b's own worker\n",
      );
      // The role files stay in place for live briefs, so the backup has no copy of them.
      assert.strictEqual(yield* b.read("roles/lead.md"), "b's lead override\n");
      assert.strictEqual(yield* fs.exists(`${b.backupsDirectory}/1/roles`), false);

      yield* b.write("workers/implementer.md", "scratch\n");
      assert.deepInclude(yield* b.repo.discard, { localChanges: [] });
      assert.strictEqual(yield* b.read("roles/lead.md"), "b's lead override\n");
    }),
  );

  live("brings one machine's push to the other", () =>
    Effect.gen(function* () {
      const { a, b } = yield* connectedPair;
      yield* a.write("workers/implementer.md", "implementer v2\n");
      const pushed = yield* a.repo.push("Sharpen the implementer");
      assert.deepInclude(pushed, { localChanges: [], unpushedCommits: 0 });

      assert.deepInclude(yield* b.repo.check, { incomingCommits: 1 });
      const pulled = yield* b.repo.pull;
      assert.deepInclude(pulled, { localChanges: [], incomingCommits: 0, conflict: null });
      assert.strictEqual(yield* b.read("workers/implementer.md"), "implementer v2\n");
    }),
  );

  live("keeps local changes to another file through a pull", () =>
    Effect.gen(function* () {
      const { a, b } = yield* connectedPair;
      yield* a.write("workers/implementer.md", "implementer v2\n");
      yield* a.repo.push("Sharpen the implementer");
      yield* b.write("workers/reviewer.md", "reviewer from b\n");

      const pulled = yield* b.repo.pull;

      assert.deepInclude(pulled, {
        localChanges: [{ path: "workers/reviewer.md", change: "modified" }],
        unpushedCommits: 0,
        conflict: null,
      });
      assert.strictEqual(yield* b.read("workers/implementer.md"), "implementer v2\n");
      assert.strictEqual(yield* b.read("workers/reviewer.md"), "reviewer from b\n");
    }),
  );

  /** A and B both change the implementer; A pushes first and B's pull stops on it. */
  const conflictingPull = Effect.gen(function* () {
    const pair = yield* connectedPair;
    yield* pair.a.write("workers/implementer.md", "implementer from a\n");
    yield* pair.a.repo.push("A's implementer");
    yield* pair.b.write("workers/implementer.md", "implementer from b\n");
    const stopped = yield* pair.b.repo.pull;
    assert.deepInclude(stopped, { conflict: { paths: ["workers/implementer.md"] } });
    return pair;
  });

  live("settles a conflict as mine, leaving it as a local change", () =>
    Effect.gen(function* () {
      const { b } = yield* conflictingPull;
      // The stopped pull is read from the repo itself, so a restart still sees it.
      const restarted = yield* b.reopen;
      assert.deepInclude(yield* restarted.status, {
        conflict: { paths: ["workers/implementer.md"] },
      });
      const settled = yield* restarted.resolve("workers/implementer.md", "mine");
      assert.deepInclude(settled, {
        conflict: null,
        localChanges: [{ path: "workers/implementer.md", change: "modified" }],
        unpushedCommits: 0,
      });
      assert.strictEqual(yield* b.read("workers/implementer.md"), "implementer from b\n");
    }),
  );

  live("settles a conflict as theirs, leaving nothing to push", () =>
    Effect.gen(function* () {
      const { b } = yield* conflictingPull;
      const settled = yield* b.repo.resolve("workers/implementer.md", "theirs");
      assert.deepInclude(settled, { conflict: null, localChanges: [], unpushedCommits: 0 });
      assert.strictEqual(yield* b.read("workers/implementer.md"), "implementer from a\n");
    }),
  );

  live("discards local edits and new files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { b } = yield* connectedPair;
      yield* b.write("workers/implementer.md", "scratch\n");
      yield* b.write("workers/experiment.md", "scratch\n");

      assert.deepInclude(yield* b.repo.discard, { localChanges: [] });
      assert.strictEqual(yield* b.read("workers/implementer.md"), "implementer v1\n");
      assert.strictEqual(yield* fs.exists(b.file("workers/experiment.md")), false);
    }),
  );

  live("refuses to disconnect over unpushed changes unless forced, and keeps the files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { b } = yield* connectedPair;
      yield* b.write("workers/implementer.md", "unpushed\n");

      const refused = yield* b.repo.disconnect({ force: false }).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "conflict");
      assert.strictEqual(yield* fs.exists(b.file(".git")), true);

      assert.deepStrictEqual(yield* b.repo.disconnect({ force: true }), { connected: false });
      assert.strictEqual(yield* fs.exists(b.file(".git")), false);
      assert.strictEqual(yield* b.read("workers/implementer.md"), "unpushed\n");
    }),
  );

  live("refuses to push without a Git identity", () =>
    Effect.gen(function* () {
      const remote = yield* bareRemote;
      const a = yield* machine("a");
      yield* a.write("workers/implementer.md", "implementer v1\n");
      yield* a.repo.connect({ url: remote });
      const c = yield* machine("c", { identity: false });
      yield* c.repo.connect({ url: remote });
      yield* c.write("workers/implementer.md", "from c\n");

      const refused = yield* c.repo.push("C's change").pipe(Effect.flip);

      assert.deepInclude(refused, {
        reason: "invalid",
        message:
          "Git has no user.name or user.email on this environment. Set both with git config, then try again.",
      });
      assert.deepInclude(yield* c.repo.status, {
        localChanges: [{ path: "workers/implementer.md", change: "modified" }],
        unpushedCommits: 0,
      });
    }),
  );
  live("leaves the config as it was when the client disconnects during a connect", () =>
    Effect.gen(function* () {
      const remote = yield* bareRemote;
      const a = yield* machine("a");
      yield* a.write("workers/implementer.md", "implementer v1\n");
      yield* a.repo.connect({ url: remote });
      const b = yield* machine("b");
      yield* b.write("workers/own.md", "b's own worker\n");
      const held = yield* holdingGit("checkout");
      const repo = yield* b.reopen.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, held.driver),
      );

      const connecting = yield* repo
        .connect({ url: remote, choice: "use-repo" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(held.started);
      // What the RPC server does to a disconnected client's requests.
      connecting.interruptUnsafe();
      yield* Deferred.succeed(held.release, undefined);
      yield* Fiber.await(connecting);

      assert.deepStrictEqual(yield* b.repo.status, { connected: false });
      assert.strictEqual(yield* b.read("workers/own.md"), "b's own worker\n");
    }),
  );

  live("leaves the config as it was when the repo's config cannot be checked out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const remote = yield* bareRemote;
      const a = yield* machine("a");
      yield* a.write("workers/implementer.md", "implementer v1\n");
      yield* a.write("notes.md", "a's notes\n");
      yield* a.repo.connect({ url: remote });
      const b = yield* machine("b");
      yield* b.write("workers/own.md", "b's own worker\n");
      yield* b.write("notes.md", "b's notes\n");

      const refused = yield* b.repo.connect({ url: remote, choice: "use-repo" }).pipe(Effect.flip);

      assert.deepInclude(refused, {
        reason: "invalid",
        message:
          "The repo has notes.md, and this environment has its own file there outside the config. Move it out of the config folder, then connect again.",
      });
      assert.deepStrictEqual(yield* b.repo.status, { connected: false });
      assert.strictEqual(yield* b.read("workers/own.md"), "b's own worker\n");
      assert.strictEqual(yield* b.read("notes.md"), "b's notes\n");
      assert.strictEqual(yield* fs.exists(b.backupsDirectory), false);
    }),
  );

  /** B's pull stopped after its rebase, leaving the set-aside commit at HEAD, then restarted. */
  const interruptedPull = Effect.gen(function* () {
    const pair = yield* connectedPair;
    yield* pair.b.write("workers/reviewer.md", "reviewer from b\n");
    yield* git(pair.b.directory, ["add", "-A"]);
    yield* git(pair.b.directory, ["commit", "--quiet", "-m", FactoryConfigRepo.SET_ASIDE_SUBJECT]);
    return { b: pair.b, restarted: yield* pair.b.reopen };
  });

  live("brings back changes an interrupted pull set aside, on the next pull", () =>
    Effect.gen(function* () {
      const { b, restarted } = yield* interruptedPull;
      assert.deepInclude(yield* restarted.pull, {
        localChanges: [{ path: "workers/reviewer.md", change: "modified" }],
        unpushedCommits: 0,
      });
      assert.strictEqual(yield* b.read("workers/reviewer.md"), "reviewer from b\n");
    }),
  );

  live("pushes changes an interrupted pull set aside under the push's own message", () =>
    Effect.gen(function* () {
      const { b, restarted } = yield* interruptedPull;
      assert.deepInclude(yield* restarted.push("B's reviewer"), {
        localChanges: [],
        unpushedCommits: 0,
      });
      assert.strictEqual(yield* git(b.directory, ["log", "-1", "--format=%s"]), "B's reviewer\n");
    }),
  );

  live("backs up changes an interrupted pull set aside before discarding them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { b, restarted } = yield* interruptedPull;
      assert.deepInclude(yield* restarted.discard, { localChanges: [], unpushedCommits: 0 });
      assert.strictEqual(yield* b.read("workers/reviewer.md"), "reviewer v1\n");
      assert.strictEqual(
        yield* fs.readFileString(`${b.backupsDirectory}/1/workers/reviewer.md`),
        "reviewer from b\n",
      );
    }),
  );

  live("refuses a URL that carries credentials", () =>
    Effect.gen(function* () {
      const c = yield* machine("c");
      for (const url of [
        "https://user:token@example.com/config.git",
        "https://token@example.com/config.git",
        "ssh://git:secret@example.com/config.git",
      ]) {
        assert.deepInclude(yield* c.repo.connect({ url }).pipe(Effect.flip), {
          reason: "invalid",
          message: "Don't put credentials in the URL. Use a Git credential helper or SSH.",
        });
      }
      assert.deepStrictEqual(yield* c.repo.status, { connected: false });
    }),
  );

  live("never shows a password from a URL set outside Satellite", () =>
    Effect.gen(function* () {
      const d = yield* machine("d");
      yield* git(d.directory, [
        "remote",
        "add",
        "origin",
        "https://user:s3cret@127.0.0.1:9/config.git",
      ]);
      assert.deepInclude(yield* d.repo.status, { remoteUrl: "https://127.0.0.1:9/config.git" });
      const failed = yield* d.repo.check.pipe(Effect.flip);
      assert.strictEqual(failed.reason, "storage");
      assert.notInclude(failed.message, "s3cret");
    }),
  );
  live("never undoes a set-aside commit the repo already has", () =>
    Effect.gen(function* () {
      const { a } = yield* connectedPair;
      yield* a.write("workers/reviewer.md", "reviewer v2\n");
      yield* git(a.directory, ["add", "-A"]);
      yield* git(a.directory, ["commit", "--quiet", "-m", FactoryConfigRepo.SET_ASIDE_SUBJECT]);
      yield* git(a.directory, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);

      const restarted = yield* a.reopen;
      assert.deepInclude(yield* restarted.pull, { localChanges: [], unpushedCommits: 0 });
      assert.strictEqual(yield* a.read("workers/reviewer.md"), "reviewer v2\n");
    }),
  );
});
