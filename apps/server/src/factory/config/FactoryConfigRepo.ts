import {
  FactoryOperationError,
  type FactoryConfigRepoChange,
  type FactoryConfigRepoConnectInput,
  type FactoryConfigRepoConnectResult,
  type FactoryConfigRepoStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { backupFactoryConfig } from "./backup.ts";
import { FACTORY_SETTINGS_FILE } from "./definitionFiles.ts";
import { FactoryConfigStore } from "./FactoryConfigStore.ts";

/** The retired role-skill overrides, still read by live briefs until they move to definitions. */
const LEGACY_ROLES_DIRECTORY = "roles";
const LEGACY_ROLES_EXCLUDE = `/${LEGACY_ROLES_DIRECTORY}/`;

/** The top-level entries of the config layout: what a backup holds. */
const CONFIG_LAYOUT_ENTRIES = [FACTORY_SETTINGS_FILE, "workers", "leads", "managers", "teams"];

/**
 * The factory config directory's own Git checkout, synced only when the user asks. See "The
 * optional config repo" in docs/internals/factory-config.md.
 */
export class FactoryConfigRepo extends Context.Service<
  FactoryConfigRepo,
  {
    readonly status: Effect.Effect<FactoryConfigRepoStatus, FactoryOperationError>;
    readonly connect: (
      input: FactoryConfigRepoConnectInput,
    ) => Effect.Effect<FactoryConfigRepoConnectResult, FactoryOperationError>;
    /** Fetches and counts the commits a pull would bring in. */
    readonly check: Effect.Effect<FactoryConfigRepoStatus, FactoryOperationError>;
    /** Commits every local change as one commit, then pushes. */
    readonly push: (
      message: string,
    ) => Effect.Effect<FactoryConfigRepoStatus, FactoryOperationError>;
    /** Replays local changes on the repo's; a file changed on both sides stops it. */
    readonly pull: Effect.Effect<FactoryConfigRepoStatus, FactoryOperationError>;
    readonly resolve: (
      path: string,
      side: "mine" | "theirs",
    ) => Effect.Effect<FactoryConfigRepoStatus, FactoryOperationError>;
    /** Back to the last commit fetched from the repo. */
    readonly discard: Effect.Effect<FactoryConfigRepoStatus, FactoryOperationError>;
    /** Keeps the files and removes the checkout. */
    readonly disconnect: (input: {
      readonly force: boolean;
    }) => Effect.Effect<FactoryConfigRepoStatus, FactoryOperationError>;
  }
>()("t3/factory/config/FactoryConfigRepo") {}

const error = (reason: FactoryOperationError["reason"], message: string) =>
  new FactoryOperationError({ reason, message });

/** Fetch and push wait on the network and on credential helpers, not on the local disk. */
const NETWORK_TIMEOUT_MS = 120_000;
const NETWORK_ENV = { GIT_TERMINAL_PROMPT: "0" };

/**
 * A pull sets local changes aside as a commit with this subject and rebases it with any unpushed
 * commits, rather than stashing them. One mechanism then covers both kinds of conflict, and the
 * whole state lives in the repo, so a conflict outlasts a restart. The commit never leaves this
 * private repo: once the rebase ends it is undone, and the changes are uncommitted again.
 */
const SET_ASIDE_SUBJECT = "satellite: local changes set aside during a pull";
const SET_ASIDE_IDENTITY = {
  GIT_AUTHOR_NAME: "Satellite",
  GIT_AUTHOR_EMAIL: "satellite@localhost",
  GIT_COMMITTER_NAME: "Satellite",
  GIT_COMMITTER_EMAIL: "satellite@localhost",
};

const PUSH_REJECTED = /\[rejected\]|non-fast-forward|fetch first/i;
const AUTH_FAILED =
  /authentication failed|could not read (?:username|password)|permission denied|host key verification failed/i;
const UNREACHABLE =
  /could not resolve host|could not read from remote repository|does not appear to be a git repository|repository .* not found|unable to access|failed to connect/i;

/** Git echoes remote URLs, which can carry a token, so no URL reaches the message. */
const withoutUrls = (text: string) => text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, "the repo");

const summarise = (action: string, stderr: string) => {
  if (AUTH_FAILED.test(stderr))
    return `Git could not ${action}: the repo refused this environment's Git credentials.`;
  if (UNREACHABLE.test(stderr))
    return `Git could not ${action}: the repo could not be reached. Check its URL and this environment's access to it.`;
  const diagnostic = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(?:fatal|error):/.test(line));
  return diagnostic === undefined
    ? `Git could not ${action}.`
    : `Git could not ${action}: ${withoutUrls(diagnostic.replace(/^(?:fatal|error):\s*/, ""))}`;
};

/** A URL's password or token is not shown back. */
const displayUrl = (url: string) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");

const parseChanges = (fields: ReadonlyArray<string>): FactoryConfigRepoChange[] => {
  const changes: FactoryConfigRepoChange[] = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index]!;
    if (entry.length < 4) continue;
    const [x, y] = [entry[0], entry[1]];
    // A rename or copy is followed by the path it came from.
    if (x === "R" || x === "C") index++;
    changes.push({
      path: entry.slice(3),
      change: x === "?" || x === "A" ? "added" : x === "D" || y === "D" ? "deleted" : "modified",
    });
  }
  return changes;
};

interface GitOptions {
  readonly network?: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

const make = Effect.fn("FactoryConfigRepo.make")(function* (directory: string) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitDir = path.join(directory, ".git");
  const lock = yield* Semaphore.make(1);
  const fetched = yield* Ref.make(false);
  const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);

  const storage = (action: string) => () =>
    error("storage", `Could not ${action} the factory config directory.`);

  // The directory can sit inside another checkout, such as a dev worktree's `.t3`, so every
  // command names this repo outright instead of letting Git search upward for one. `init` is the
  // exception: naming a work tree there would write its absolute path into the repo's config.
  const run = (args: ReadonlyArray<string>, gitOptions: GitOptions = {}, bare = false) =>
    git
      .execute({
        operation: `FactoryConfigRepo.git.${args[0]}`,
        cwd: directory,
        args: bare ? args : ["--git-dir", gitDir, "--work-tree", directory, ...args],
        allowNonZeroExit: true,
        ...(gitOptions.network ? { timeoutMs: NETWORK_TIMEOUT_MS } : {}),
        ...(gitOptions.network || gitOptions.env
          ? { env: { ...(gitOptions.network ? NETWORK_ENV : {}), ...gitOptions.env } }
          : {}),
      })
      .pipe(
        Effect.mapError((cause) => error("storage", `Git failed: ${withoutUrls(cause.detail)}`)),
      );

  const ok = (action: string, args: ReadonlyArray<string>, gitOptions?: GitOptions) =>
    run(args, gitOptions).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(error("storage", summarise(action, result.stderr))),
      ),
    );

  const succeeds = (args: ReadonlyArray<string>) =>
    run(args).pipe(Effect.map((result) => result.exitCode === 0));

  const output = (args: ReadonlyArray<string>) =>
    run(args).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));

  /** NUL-separated output, untrimmed: a status entry can start with a meaningful space. */
  const fields = (args: ReadonlyArray<string>) =>
    run(args).pipe(
      Effect.map((result) =>
        result.exitCode === 0 ? result.stdout.split("\0").filter((entry) => entry.length > 0) : [],
      ),
    );

  const count = (range: string) =>
    output(["rev-list", "--count", range]).pipe(Effect.map((text) => Number(text ?? "0")));

  const hasCommit = (ref: string) =>
    succeeds(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);

  const hasRepo = fs.exists(gitDir).pipe(Effect.mapError(storage("read")));

  const remoteUrl = Effect.gen(function* () {
    if (!(yield* hasRepo)) return null;
    const url = yield* output(["remote", "get-url", "origin"]);
    return url === null || url.length === 0 ? null : url;
  });

  const rebaseInProgress = Effect.gen(function* () {
    const merge = yield* fs.exists(path.join(gitDir, "rebase-merge"));
    const apply = yield* fs.exists(path.join(gitDir, "rebase-apply"));
    return merge || apply;
  }).pipe(Effect.mapError(storage("read")));

  /** HEAD is detached while a pull's rebase is stopped, so the branch comes from its state. */
  const currentBranch = Effect.gen(function* () {
    const branch = yield* output(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch !== null && branch.length > 0) return branch;
    const headName = yield* fs
      .readFileString(path.join(gitDir, "rebase-merge", "head-name"))
      .pipe(Effect.orElseSucceed(() => ""));
    return headName.trim().replace(/^refs\/heads\//, "") || "main";
  });

  const upstreamOf = (branch: string) => `refs/remotes/origin/${branch}`;

  const unmergedPaths = fields(["diff", "--name-only", "--diff-filter=U", "-z"]);

  const localChanges = fields(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).pipe(
    Effect.map(parseChanges),
  );

  const hasIdentity = Effect.gen(function* () {
    const name = yield* output(["config", "--get", "user.name"]);
    const email = yield* output(["config", "--get", "user.email"]);
    return Boolean(name) && Boolean(email);
  });

  /** Rebasing writes commits, so a pull without an identity commits as the placeholder. */
  const rebaseEnv = Effect.map(hasIdentity, (identity) =>
    identity
      ? { GIT_EDITOR: "true" }
      : {
          GIT_EDITOR: "true",
          GIT_COMMITTER_NAME: SET_ASIDE_IDENTITY.GIT_COMMITTER_NAME,
          GIT_COMMITTER_EMAIL: SET_ASIDE_IDENTITY.GIT_COMMITTER_EMAIL,
        },
  );

  const readStatus = Effect.gen(function* () {
    const url = yield* remoteUrl;
    if (url === null) return { connected: false } satisfies FactoryConfigRepoStatus;
    const branch = yield* currentBranch;
    const upstream = upstreamOf(branch);
    const [hasHead, hasUpstream] = [yield* hasCommit("HEAD"), yield* hasCommit(upstream)];
    const unpushedCommits = !hasHead
      ? 0
      : hasUpstream
        ? yield* count(`${upstream}..HEAD`)
        : yield* count("HEAD");
    const incomingCommits = !(yield* Ref.get(fetched))
      ? null
      : !hasUpstream
        ? 0
        : hasHead
          ? yield* count(`HEAD..${upstream}`)
          : yield* count(upstream);
    const paths = yield* unmergedPaths;
    return {
      connected: true,
      remoteUrl: displayUrl(url),
      branch,
      localChanges: yield* localChanges,
      unpushedCommits,
      incomingCommits,
      conflict: paths.length > 0 || (yield* rebaseInProgress) ? { paths } : null,
    } satisfies FactoryConfigRepoStatus;
  });

  const requireConnected = Effect.gen(function* () {
    if ((yield* remoteUrl) === null) return yield* error("invalid", "No config repo is connected.");
  });

  const fetch = Effect.gen(function* () {
    yield* ok("fetch from the repo", ["fetch", "--prune", "--quiet", "origin"], { network: true });
    yield* Ref.set(fetched, true);
  });

  /** Ends a pull that stopped after its rebase but before the set-aside commit was undone. */
  const restoreSetAside = Effect.gen(function* () {
    if (yield* rebaseInProgress) return;
    if ((yield* output(["log", "-1", "--format=%s"])) !== SET_ASIDE_SUBJECT) return;
    yield* ok("bring back the local changes", ["reset", "--mixed", "--quiet", "HEAD~1"]);
  });

  /** A rebase that stops on a conflict leaves it for `resolve`; any other failure is undone. */
  const afterRebase = Effect.fnUntraced(function* (result: GitVcsDriver.ExecuteGitResult) {
    if (result.exitCode !== 0) {
      if ((yield* unmergedPaths).length > 0) return yield* readStatus;
      yield* run(["rebase", "--abort"]);
      yield* restoreSetAside;
      return yield* error("storage", summarise("replay the local changes", result.stderr));
    }
    yield* restoreSetAside;
    return yield* readStatus;
  });

  const continueRebase = Effect.gen(function* () {
    if (!(yield* rebaseInProgress)) {
      yield* restoreSetAside;
      return yield* readStatus;
    }
    // Taking theirs for every file can leave the replayed commit empty, which Git only skips.
    const nothingStaged = yield* succeeds(["diff", "--cached", "--quiet"]);
    const result = yield* run(["rebase", nothingStaged ? "--skip" : "--continue"], {
      env: yield* rebaseEnv,
    });
    return yield* afterRebase(result);
  });

  /** What this environment's config holds, beside the repo and the legacy role files. */
  const configEntries = fs.readDirectory(directory).pipe(
    Effect.map((names) =>
      names.filter((name) => name !== ".git" && name !== LEGACY_ROLES_DIRECTORY),
    ),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<string[]>([])),
    Effect.mapError(storage("list")),
  );

  // Live briefs still read the role files, which are this environment's alone, so the repo
  // ignores them. An exclude rather than a `.gitignore` keeps that rule out of the shared repo.
  const excludeLegacyRoles = Effect.gen(function* () {
    const excludeFile = path.join(gitDir, "info", "exclude");
    const current = yield* fs
      .readFileString(excludeFile)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));
    if (current.split(/\r?\n/).includes(LEGACY_ROLES_EXCLUDE)) return;
    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    yield* fs.makeDirectory(path.dirname(excludeFile), { recursive: true });
    yield* fs.writeFileString(excludeFile, `${current}${separator}${LEGACY_ROLES_EXCLUDE}\n`);
  }).pipe(Effect.mapError(storage("configure")));

  /**
   * Backs the config up beside the directory, then removes what the backup holds so the repo's
   * config can be checked out. Anything outside the config layout stays, as a local change.
   */
  const replaceWithRepo = Effect.gen(function* () {
    yield* backupFactoryConfig(directory).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    for (const entry of CONFIG_LAYOUT_ENTRIES) {
      yield* fs.remove(path.join(directory, entry), { recursive: true }).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
        Effect.mapError(storage("clear")),
      );
    }
  });

  const remoteDefaultBranch = Effect.fnUntraced(function* (branches: ReadonlyArray<string>) {
    const head = yield* ok(
      "read the repo's default branch",
      ["ls-remote", "--symref", "origin", "HEAD"],
      {
        network: true,
      },
    );
    const named = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1];
    if (named !== undefined && branches.includes(named)) return named;
    return branches.includes("main") ? "main" : branches[0]!;
  });

  const identityMissing = error(
    "invalid",
    "Git has no user.name or user.email on this environment. Set both with git config, then try again.",
  );

  /** An empty repo receives this config as its first commit, on `main`. */
  const publishLocal = Effect.gen(function* () {
    if (yield* hasCommit("HEAD")) yield* ok("name the branch", ["branch", "-M", "main"]);
    else yield* ok("name the branch", ["symbolic-ref", "HEAD", "refs/heads/main"]);
    yield* ok("stage the config", ["add", "-A"]);
    if (!(yield* succeeds(["diff", "--cached", "--quiet"]))) {
      if (!(yield* hasIdentity)) return yield* identityMissing;
      yield* ok("commit the config", ["commit", "--quiet", "-m", "Add the factory config"]);
    }
    if (yield* hasCommit("HEAD")) {
      yield* ok("push to the repo", ["push", "--quiet", "-u", "origin", "HEAD:refs/heads/main"], {
        network: true,
      });
    }
  });

  const connect = Effect.fn("FactoryConfigRepo.connect")(function* (
    input: FactoryConfigRepoConnectInput,
  ) {
    const current = yield* remoteUrl;
    if (current !== null) {
      if (current === input.url)
        return { outcome: "connected", status: yield* readStatus } as const;
      return yield* error("invalid", "A different repo is connected. Disconnect it first.");
    }
    yield* fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.mapError(storage("create")));
    const created = !(yield* hasRepo);
    // Connecting changes nothing unless it finishes: whatever it set up is undone otherwise.
    const undo = created
      ? fs.remove(gitDir, { recursive: true }).pipe(Effect.ignore)
      : run(["remote", "remove", "origin"]).pipe(Effect.ignore);

    const attempt = Effect.gen(function* () {
      if (created) {
        const init = yield* run(["init", "--quiet"], {}, true);
        if (init.exitCode !== 0)
          return yield* error("storage", summarise("set up the repo", init.stderr));
      }
      // Files are written with LF endings and must not change on checkout.
      yield* ok("configure the repo", ["config", "core.autocrlf", "false"]);
      yield* excludeLegacyRoles;
      yield* ok("add the repo", ["remote", "add", "origin", input.url]);
      yield* fetch;
      const branches =
        (yield* output(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]))
          ?.split("\n")
          .map((ref) => ref.trim().replace(/^refs\/remotes\/origin\//, ""))
          .filter((name) => name.length > 0 && name !== "HEAD") ?? [];
      if (branches.length === 0) {
        yield* publishLocal;
        return "connected" as const;
      }
      const branch = yield* remoteDefaultBranch(branches);
      if ((yield* configEntries).length > 0) {
        // Both sides have a config. A `merge` choice, keeping these files by importing them into
        // the repo's config, arrives with import; `use-repo` keeps the repo's and backs these up.
        if (input.choice !== "use-repo") return "needs-choice" as const;
        yield* replaceWithRepo;
      }
      yield* ok("check out the repo", [
        "checkout",
        "--quiet",
        "-B",
        branch,
        "--track",
        `origin/${branch}`,
      ]);
      return "connected" as const;
    });

    const outcome = yield* attempt.pipe(Effect.tapError(() => undo));
    if (outcome === "needs-choice") {
      yield* undo;
      return { outcome } as const;
    }
    return { outcome, status: yield* readStatus } as const;
  }, serialized);

  const check = Effect.fn("FactoryConfigRepo.check")(function* () {
    yield* requireConnected;
    yield* fetch;
    return yield* readStatus;
  }, serialized);

  const push = Effect.fn("FactoryConfigRepo.push")(function* (message: string) {
    yield* requireConnected;
    if (message.trim().length === 0) return yield* error("invalid", "A push needs a message.");
    if (!(yield* hasIdentity)) return yield* identityMissing;
    if ((yield* rebaseInProgress) || (yield* unmergedPaths).length > 0)
      return yield* error("conflict", "Settle the pull's conflicts before pushing.");
    yield* restoreSetAside;
    yield* ok("stage the changes", ["add", "-A"]);
    if (!(yield* succeeds(["diff", "--cached", "--quiet"]))) {
      yield* ok("commit the changes", ["commit", "--quiet", "-m", message.trim()]);
    }
    if (!(yield* hasCommit("HEAD"))) return yield* readStatus;
    const branch = yield* currentBranch;
    const pushed = yield* run(["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${branch}`], {
      network: true,
    });
    if (pushed.exitCode !== 0) {
      // The commit stays, so pushing again after a pull sends it.
      if (PUSH_REJECTED.test(pushed.stderr))
        return yield* error(
          "conflict",
          "The repo has changes this environment does not have yet. Pull first, then push.",
        );
      return yield* error("storage", summarise("push to the repo", pushed.stderr));
    }
    return yield* readStatus;
  }, serialized);

  const pull = Effect.fn("FactoryConfigRepo.pull")(function* () {
    yield* requireConnected;
    if (yield* rebaseInProgress) {
      if ((yield* unmergedPaths).length > 0)
        return yield* error("conflict", "Settle each conflicted file as mine or theirs first.");
      return yield* continueRebase;
    }
    yield* restoreSetAside;
    yield* fetch;
    const branch = yield* currentBranch;
    const upstream = upstreamOf(branch);
    if (!(yield* hasCommit(upstream))) return yield* readStatus;
    const dirty = (yield* localChanges).length > 0;
    if (dirty) {
      yield* ok("set the local changes aside", ["add", "-A"]);
      yield* ok(
        "set the local changes aside",
        ["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", SET_ASIDE_SUBJECT],
        { env: SET_ASIDE_IDENTITY },
      );
    }
    if (!(yield* hasCommit("HEAD"))) {
      yield* ok("check out the repo", ["checkout", "--quiet", "-B", branch, "--track", upstream]);
      return yield* readStatus;
    }
    const result = yield* run(["rebase", "--quiet", upstream], { env: yield* rebaseEnv });
    return yield* afterRebase(result);
  }, serialized);

  const resolve = Effect.fn("FactoryConfigRepo.resolve")(function* (
    file: string,
    side: "mine" | "theirs",
  ) {
    yield* requireConnected;
    const paths = yield* unmergedPaths;
    if (paths.length === 0 && !(yield* rebaseInProgress))
      return yield* error("invalid", "No pull is waiting on a conflict.");
    if (!paths.includes(file)) return yield* error("invalid", `${file} has no conflict to settle.`);
    // In a rebase, "ours" is the repo's side being built on and "theirs" this environment's
    // change replayed onto it. Stage 2 holds ours and stage 3 theirs; a missing stage is a delete.
    const stages = yield* fields(["ls-files", "-u", "-z", "--", file]);
    const stage = side === "mine" ? "3" : "2";
    const kept = stages.some((entry) => entry.split("\t")[0]?.split(" ")[2] === stage);
    if (kept) {
      yield* ok("settle the conflict", [
        "checkout",
        side === "mine" ? "--theirs" : "--ours",
        "--",
        file,
      ]);
      yield* ok("settle the conflict", ["add", "--", file]);
    } else {
      yield* ok("settle the conflict", ["rm", "--quiet", "-f", "--", file]);
    }
    if ((yield* unmergedPaths).length > 0) return yield* readStatus;
    return yield* continueRebase;
  }, serialized);

  const discard = Effect.fn("FactoryConfigRepo.discard")(function* () {
    yield* requireConnected;
    if (yield* rebaseInProgress) yield* ok("stop the pull", ["rebase", "--abort"]);
    yield* restoreSetAside;
    const upstream = upstreamOf(yield* currentBranch);
    if (!(yield* hasCommit(upstream)))
      return yield* error(
        "invalid",
        "Nothing has been pulled or pushed yet, so there is no copy to go back to.",
      );
    yield* ok("discard the local changes", ["reset", "--hard", "--quiet", upstream]);
    // Without -x, clean leaves excluded paths alone, and so the legacy role files.
    yield* ok("discard the local changes", ["clean", "-fdq"]);
    return yield* readStatus;
  }, serialized);

  const disconnect = Effect.fn("FactoryConfigRepo.disconnect")(function* (input: {
    readonly force: boolean;
  }) {
    if (!(yield* hasRepo)) return { connected: false } satisfies FactoryConfigRepoStatus;
    const status = yield* readStatus;
    const unpushed =
      status.connected &&
      (status.localChanges.length > 0 || status.unpushedCommits > 0 || status.conflict !== null);
    if (unpushed && !input.force)
      return yield* error(
        "conflict",
        "Some changes were never pushed. Push them first, or disconnect anyway to keep them only on this environment.",
      );
    // A stopped pull is undone first so the files are this environment's, not conflict markers.
    if (yield* rebaseInProgress) yield* ok("stop the pull", ["rebase", "--abort"]);
    yield* restoreSetAside;
    yield* fs.remove(gitDir, { recursive: true }).pipe(Effect.mapError(storage("disconnect")));
    yield* Ref.set(fetched, false);
    return { connected: false } satisfies FactoryConfigRepoStatus;
  }, serialized);

  return FactoryConfigRepo.of({
    status: serialized(readStatus).pipe(Effect.withSpan("FactoryConfigRepo.status")),
    connect,
    check: check(),
    push,
    pull: pull(),
    resolve,
    discard: discard(),
    disconnect,
  });
});

/** The repo of the config under `<T3 home>/factory/`, backing up into `<T3 home>/factory-backups/`. */
export const layer = Layer.effect(
  FactoryConfigRepo,
  Effect.gen(function* () {
    const store = yield* FactoryConfigStore;
    return yield* make(store.directory);
  }),
);

/** Backups go beside `directory`, in `factory-backups/`. */
export const layerAt = (directory: string) => Layer.effect(FactoryConfigRepo, make(directory));
