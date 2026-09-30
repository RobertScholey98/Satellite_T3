import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { OpenWorkOperationError, type OpenWorkCommit } from "@t3tools/contracts";
import { VcsProcess } from "../vcs/VcsProcess.ts";

export const makeGitReader = Effect.gen(function* () {
  const processes = yield* VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = (cwd: string, args: readonly string[]) =>
    processes
      .run({
        operation: "OpenWork.git",
        command: "git",
        cwd,
        args,
        allowNonZeroExit: true,
        maxOutputBytes: 8 * 1024 * 1024,
        timeoutMs: 30_000,
      })
      .pipe(
        Effect.mapError(
          () =>
            new OpenWorkOperationError({
              reason: "git",
              message: "Could not read worktree history.",
            }),
        ),
        Effect.flatMap((result) =>
          result.stdoutTruncated
            ? Effect.fail(
                new OpenWorkOperationError({
                  reason: "git",
                  message: "Worktree history exceeded the read limit.",
                }),
              )
            : Effect.succeed(result),
        ),
      );
  const text = (cwd: string, args: readonly string[]) =>
    run(cwd, args).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
    );
  const canonical = (value: string) =>
    fs.realPath(value).pipe(
      Effect.mapError(
        () =>
          new OpenWorkOperationError({
            reason: "not-found",
            message: "Worktree path is unavailable.",
          }),
      ),
    );
  const identity = Effect.fn("OpenWork.gitIdentity")(function* (cwd: string) {
    const topLevel = yield* text(cwd, ["rev-parse", "--show-toplevel"]);
    if (!topLevel)
      return yield* new OpenWorkOperationError({
        reason: "git",
        message: "The selected path is not a Git worktree.",
      });
    const directory = yield* canonical(topLevel);
    const common = yield* text(directory, ["rev-parse", "--git-common-dir"]);
    if (!common)
      return yield* new OpenWorkOperationError({
        reason: "git",
        message: "The selected path is not a Git worktree.",
      });
    return {
      id: directory,
      path: directory,
      commonDir: yield* canonical(path.resolve(directory, common)),
    };
  });
  const inventory = Effect.fn("OpenWork.gitInventory")(function* (cwd: string) {
    const result = yield* run(cwd, ["worktree", "list", "--porcelain", "-z"]);
    if (result.exitCode !== 0)
      return yield* new OpenWorkOperationError({
        reason: "git",
        message: "Could not list worktrees.",
      });
    const entries: string[] = [];
    let current: string | null = null;
    let prunable = false;
    const flush = () => {
      if (current && !prunable) entries.push(current);
      current = null;
      prunable = false;
    };
    for (const field of result.stdout.split("\0")) {
      if (field === "") flush();
      else if (field.startsWith("worktree ")) current = field.slice(9);
      else if (field === "prunable" || field.startsWith("prunable ")) prunable = true;
    }
    flush();
    return yield* Effect.forEach(
      entries,
      (entry) => canonical(entry).pipe(Effect.orElseSucceed(() => null)),
      { concurrency: 4 },
    );
  });
  const base = Effect.fn("OpenWork.gitBase")(function* (cwd: string) {
    const remoteHead = yield* text(cwd, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    for (const candidate of [
      "refs/remotes/origin/main",
      "refs/heads/main",
      remoteHead ? `refs/remotes/${remoteHead}` : null,
      "refs/remotes/origin/master",
      "refs/heads/master",
    ]) {
      if (candidate && (yield* text(cwd, ["rev-parse", "--verify", `${candidate}^{commit}`])))
        return candidate;
    }
    return null;
  });
  const commits = Effect.fn("OpenWork.gitCommits")(function* (cwd: string, range: string) {
    const result = yield* run(cwd, [
      "log",
      "--reverse",
      "--topo-order",
      "--format=%H%x00%P%x00%s%x00%cI%x00",
      range,
      "--",
    ]);
    if (result.exitCode !== 0)
      return yield* new OpenWorkOperationError({
        reason: "git",
        message: "Could not read commits.",
      });
    const fields = result.stdout.split("\0");
    const values: OpenWorkCommit[] = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const sha = fields[index]?.trim();
      if (sha)
        values.push({
          sha,
          parents: fields[index + 1]?.split(" ").filter(Boolean) ?? [],
          subject: fields[index + 2] ?? "",
          committedAt: fields[index + 3] ?? "",
        });
    }
    return values;
  });
  const state = Effect.fn("OpenWork.gitState")(function* (cwd: string) {
    const head = yield* text(cwd, ["rev-parse", "--verify", "HEAD"]);
    const branch = yield* text(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const baseRef = yield* base(cwd);
    const count =
      baseRef && head
        ? yield* text(cwd, ["rev-list", "--left-right", "--count", `HEAD...${baseRef}`])
        : null;
    const counts = count?.split(/\s+/).map(Number);
    const status = yield* run(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status.exitCode !== 0)
      return yield* new OpenWorkOperationError({
        reason: "git",
        message: "Could not read uncommitted changes.",
      });
    const changed = new Set<string>();
    const statusFields = status.stdout.split("\0");
    for (let index = 0; index < statusFields.length; index++) {
      const field = statusFields[index];
      if (!field) continue;
      changed.add(field.slice(3));
      if (field.slice(0, 2).includes("R") || field.slice(0, 2).includes("C")) index++;
    }
    const stats = yield* text(cwd, ["diff", "--numstat", "-z", head ? "HEAD" : "--cached", "--"]);
    const byPath = new Map<string, { insertions: number; deletions: number }>();
    const statFields = stats?.split("\0") ?? [];
    for (let index = 0; index < statFields.length; index++) {
      const parts = statFields[index]?.split("\t") ?? [];
      if (parts.length < 3) continue;
      let filePath = parts.slice(2).join("\t");
      if (!filePath) {
        index++;
        index++;
        filePath = statFields[index] ?? "";
      }
      if (filePath)
        byPath.set(filePath, {
          insertions: Number.parseInt(parts[0] ?? "", 10) || 0,
          deletions: Number.parseInt(parts[1] ?? "", 10) || 0,
        });
    }
    const files = [...changed].sort().map((filePath) => ({
      path: filePath,
      ...(byPath.get(filePath) ?? { insertions: 0, deletions: 0 }),
    }));
    return {
      branch,
      head,
      baseRef,
      ahead: counts?.[0] ?? null,
      behind: counts?.[1] ?? null,
      hasChanges: files.length > 0,
      wip: {
        files,
        insertions: files.reduce((sum, file) => sum + file.insertions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      },
    };
  });
  const firstNewCommit = Effect.fn("OpenWork.firstNewCommit")(function* (
    cwd: string,
    anchor: string | null,
    head: string | null,
  ) {
    if (!head || anchor === head) return { sha: null, diverged: false };
    const progression = yield* text(cwd, ["rev-list", "--first-parent", head]);
    const shas = progression?.split("\n") ?? [];
    if (!anchor) return { sha: shas.at(-1) ?? null, diverged: false };
    const index = shas.indexOf(anchor);
    return index < 0
      ? { sha: null, diverged: true }
      : { sha: shas[index - 1] ?? null, diverged: false };
  });
  const validateCommit = Effect.fn("OpenWork.validateCommit")(function* (cwd: string, sha: string) {
    if (!/^[a-f0-9]{7,64}$/i.test(sha))
      return yield* new OpenWorkOperationError({
        reason: "invalid",
        message: "Select a valid commit.",
      });
    const resolved = yield* text(cwd, ["rev-parse", "--verify", `${sha}^{commit}`]);
    if (!resolved)
      return yield* new OpenWorkOperationError({
        reason: "invalid",
        message: "The selected commit is unavailable in this repository.",
      });
    return resolved;
  });
  return { identity, inventory, state, commits, firstNewCommit, validateCommit };
});
export type GitReader = Effect.Success<typeof makeGitReader>;
