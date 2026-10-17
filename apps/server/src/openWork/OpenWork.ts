import {
  OPEN_WORK_MAX_COMMITS,
  OPEN_WORK_MAX_FILES_PER_COMMIT,
  OPEN_WORK_MAX_WIP_FILES,
  OpenWorkGitError,
  OpenWorkWorktreeNotFoundError,
  type GitCommandError,
  type OpenWorkCommitFilesInput,
  type OpenWorkCommitFilesResult,
  type OpenWorkDiffInput,
  type OpenWorkDiffResult,
  type OpenWorkListInput,
  type OpenWorkListResult,
  type OpenWorkTimelineInput,
  type OpenWorkTimelineResult,
  type OpenWorktreeSummary,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { PATCH_RENDER_PREFIX_ARGS } from "../vcs/GitVcsDriverCore.ts";
import {
  BASE_REF_CANDIDATES,
  BASE_REF_FORMAT,
  type BaseRef,
  completeFields,
  type WorktreeRecord,
  groupWip,
  LOG_FORMAT,
  parseDiffRecords,
  parseLogRecords,
  parseWorktreeList,
  pathKey,
  selectBaseRef,
} from "./openWorkGit.ts";

const READ_CONCURRENCY = 4;
// Output past these limits is cut, never an error; results built from it say they are truncated.
const LOG_MAX_OUTPUT_BYTES = 1024 * 1024;
const DIFF_RECORDS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const UNTRACKED_MAX_OUTPUT_BYTES = OPEN_WORK_MAX_WIP_FILES * 1024;
const PATCH_MAX_OUTPUT_BYTES = 1024 * 1024;
const DIFF_ARGS = [
  "diff",
  "--find-renames",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  ...PATCH_RENDER_PREFIX_ARGS,
];

/** Lists every worktree of the registered projects' repositories and reads their history. */
export class OpenWork extends Context.Service<
  OpenWork,
  {
    readonly list: (
      input: OpenWorkListInput,
    ) => Effect.Effect<OpenWorkListResult, OpenWorkGitError>;
    readonly timeline: (
      input: OpenWorkTimelineInput,
    ) => Effect.Effect<OpenWorkTimelineResult, OpenWorkWorktreeNotFoundError | OpenWorkGitError>;
    readonly diff: (
      input: OpenWorkDiffInput,
    ) => Effect.Effect<OpenWorkDiffResult, OpenWorkWorktreeNotFoundError | OpenWorkGitError>;
    readonly commitFiles: (
      input: OpenWorkCommitFilesInput,
    ) => Effect.Effect<OpenWorkCommitFilesResult, OpenWorkWorktreeNotFoundError | OpenWorkGitError>;
  }
>()("t3/openWork/OpenWork") {}

interface Repository {
  /** Any worktree of the repository, for commands that read shared refs. */
  readonly cwd: string;
  readonly projectIds: ProjectId[];
}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const keyOf = (value: string) => pathKey(path.normalize(value), platform);

  const toGitError =
    (operation: string) =>
    (cause: GitCommandError): OpenWorkGitError =>
      new OpenWorkGitError({ operation, cause });

  const run = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options: { readonly maxOutputBytes?: number; readonly stdin?: string } = {},
  ) =>
    git.execute({ operation, cwd, args, ...options }).pipe(Effect.mapError(toGitError(operation)));

  /** Reads up to `maxOutputBytes`, then cuts the output and reports it as truncated. */
  const runCapped = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    maxOutputBytes: number,
  ) =>
    git
      .execute({ operation, cwd, args, maxOutputBytes, appendTruncationMarker: true })
      .pipe(Effect.mapError(toGitError(operation)));

  /** Exit code instead of failure, for reads that may legitimately not apply. */
  const probe = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation, cwd, args, allowNonZeroExit: true })
      .pipe(Effect.mapError(toGitError(operation)));

  const canonical = (value: string) => fileSystem.realPath(path.resolve(value)).pipe(Effect.option);

  /** The worktree root and common git directory of `cwd`, or none outside a worktree. */
  const identify = Effect.fn("OpenWork.identify")(function* (cwd: string) {
    const directory = yield* canonical(cwd);
    if (Option.isNone(directory)) return Option.none();
    const result = yield* probe("OpenWork.identify", directory.value, [
      "rev-parse",
      "--show-toplevel",
      "--git-common-dir",
    ]);
    const [topLevel, commonDir] = result.stdout.trim().split("\n");
    if (result.exitCode !== 0 || !topLevel || !commonDir) return Option.none();
    const [root, common] = yield* Effect.all([
      canonical(topLevel),
      canonical(path.resolve(directory.value, commonDir)),
    ]);
    return Option.all({ root, commonDir: common });
  });

  /** Registered projects grouped by repository. Projects outside git are left out. */
  const repositories = Effect.fn("OpenWork.repositories")(function* (
    projectIds?: ReadonlyArray<ProjectId>,
  ) {
    const shells = yield* projectStore
      .listShells(projectIds ? { projectIds } : undefined)
      .pipe(Effect.orDie);
    const identities = yield* Effect.forEach(
      shells,
      (shell) => identify(shell.workspaceRoot).pipe(Effect.map((found) => ({ shell, found }))),
      { concurrency: READ_CONCURRENCY },
    );
    const byCommonDir = new Map<string, Repository>();
    for (const { shell, found } of identities) {
      if (Option.isNone(found)) continue;
      const known = byCommonDir.get(keyOf(found.value.commonDir));
      if (known) known.projectIds.push(shell.id);
      else
        byCommonDir.set(keyOf(found.value.commonDir), {
          cwd: found.value.root,
          projectIds: [shell.id],
        });
    }
    return byCommonDir;
  });

  /** Worktrees as git lists them, primary first, with canonical paths. */
  const listWorktrees = Effect.fn("OpenWork.listWorktrees")(function* (cwd: string) {
    const listed = yield* probe("OpenWork.listWorktrees", cwd, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    // Git before 2.36 has no -z for worktree list; paths with newlines are then unreadable anyway.
    const stdout =
      listed.exitCode === 0
        ? listed.stdout
        : (yield* run("OpenWork.listWorktrees", cwd, [
            "worktree",
            "list",
            "--porcelain",
          ])).stdout.replaceAll("\n", "\0");
    const resolved = yield* Effect.forEach(
      parseWorktreeList(stdout),
      (record) =>
        canonical(path.resolve(cwd, record.path)).pipe(
          Effect.map(Option.map((canonicalPath) => ({ ...record, path: canonicalPath }))),
        ),
      { concurrency: READ_CONCURRENCY },
    );
    return resolved.flatMap((record) => (Option.isSome(record) ? [record.value] : []));
  });

  const resolveBase = Effect.fn("OpenWork.resolveBase")(function* (cwd: string) {
    const result = yield* run("OpenWork.resolveBase", cwd, [
      "for-each-ref",
      BASE_REF_FORMAT,
      ...BASE_REF_CANDIDATES,
    ]);
    return selectBaseRef(result.stdout);
  });

  const countDivergence = Effect.fn("OpenWork.countDivergence")(function* (
    cwd: string,
    base: BaseRef | null,
    head: string | null,
  ) {
    if (!base || !head) return { ahead: null, behind: null };
    const result = yield* run("OpenWork.countDivergence", cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${base.ref}`,
    ]);
    const [ahead, behind] = result.stdout.trim().split(/\s+/).map(Number);
    return { ahead: ahead ?? null, behind: behind ?? null };
  });

  const summarize = Effect.fn("OpenWork.summarize")(function* (
    worktree: WorktreeRecord & { readonly primary: boolean },
    repository: Repository,
    base: BaseRef | null,
  ) {
    const divergence = yield* countDivergence(worktree.path, base, worktree.head);
    return {
      path: worktree.path,
      projectIds: repository.projectIds,
      branch: worktree.branch,
      head: worktree.head,
      baseRef: worktree.head ? (base?.name ?? null) : null,
      ...divergence,
      primary: worktree.primary,
    } satisfies OpenWorktreeSummary;
  });

  const list: OpenWork["Service"]["list"] = Effect.fn("OpenWork.list")(function* (input) {
    // A worktree belongs to exactly one common directory, so repositories never share a path.
    const perRepository = yield* Effect.forEach(
      (yield* repositories(input.projectIds)).values(),
      (repository) =>
        Effect.gen(function* () {
          const [listed, base] = yield* Effect.all([
            listWorktrees(repository.cwd),
            resolveBase(repository.cwd),
          ]);
          // No git status here: on large checkouts it costs seconds per worktree.
          const summaries = yield* Effect.forEach(
            listed,
            (worktree) => summarize(worktree, repository, base),
            { concurrency: READ_CONCURRENCY },
          );
          return summaries.toSorted((left, right) =>
            left.primary !== right.primary
              ? Number(right.primary) - Number(left.primary)
              : left.path < right.path
                ? -1
                : 1,
          );
        }),
      { concurrency: 2 },
    );
    return { worktrees: perRepository.flat() };
  });

  /**
   * Accepts a path only when it is a listed worktree of a registered project's repository. With a
   * project hint only that project is checked; without one, every registered project is.
   */
  const resolveWorktree = Effect.fn("OpenWork.resolveWorktree")(function* (
    requested: string,
    projectId: ProjectId | undefined,
  ) {
    const notFound = new OpenWorkWorktreeNotFoundError({ path: requested });
    const found = yield* identify(requested);
    if (Option.isNone(found)) return yield* notFound;
    const known = yield* repositories(projectId === undefined ? undefined : [projectId]);
    const repository = known.get(keyOf(found.value.commonDir));
    if (!repository) return yield* notFound;
    const rootKey = keyOf(found.value.root);
    const worktree = (yield* listWorktrees(found.value.root)).find(
      (listed) => keyOf(listed.path) === rootKey,
    );
    if (!worktree) return yield* notFound;
    return { worktree, repository };
  });

  const readCommits = Effect.fn("OpenWork.readCommits")(function* (cwd: string, base: BaseRef) {
    const result = yield* runCapped(
      "OpenWork.log",
      cwd,
      [
        "log",
        `--max-count=${OPEN_WORK_MAX_COMMITS + 1}`,
        "--reverse",
        "--topo-order",
        LOG_FORMAT,
        "--diff-merges=first-parent",
        "--root",
        "--shortstat",
        "--find-renames",
        `${base.ref}..HEAD`,
        "--",
      ],
      LOG_MAX_OUTPUT_BYTES,
    );
    const parsed = parseLogRecords(result.stdout);
    // A cut log ends in a partial record. Git limits before reversing, so a full log's extra
    // commit is the oldest one.
    const records = result.stdoutTruncated ? parsed.slice(0, -1) : parsed;
    const truncated = result.stdoutTruncated || records.length > OPEN_WORK_MAX_COMMITS;
    return {
      commitsTruncated: truncated,
      commits: records.length > OPEN_WORK_MAX_COMMITS ? records.slice(1) : records,
    };
  });

  /** Files from a `--raw --numstat -z` read, cut at the output limit rather than failing. */
  const readDiffRecords = (
    operation: string,
    cwd: string,
    command: ReadonlyArray<string>,
    operands: ReadonlyArray<string>,
  ) =>
    runCapped(
      operation,
      cwd,
      [...command, "--raw", "--numstat", "-z", "--find-renames", ...operands],
      DIFF_RECORDS_MAX_OUTPUT_BYTES,
    ).pipe(
      Effect.map((result) => ({
        files: parseDiffRecords(completeFields(result.stdout, result.stdoutTruncated)),
        cut: result.stdoutTruncated,
      })),
    );

  const readUntracked = (cwd: string) =>
    runCapped(
      "OpenWork.wip.untracked",
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      UNTRACKED_MAX_OUTPUT_BYTES,
    ).pipe(
      Effect.map((result) => ({
        paths: completeFields(result.stdout, result.stdoutTruncated).filter(Boolean),
        cut: result.stdoutTruncated,
      })),
    );

  const timeline: OpenWork["Service"]["timeline"] = Effect.fn("OpenWork.timeline")(
    function* (input) {
      const { worktree, repository } = yield* resolveWorktree(input.path, input.projectId);
      const [base, staged, unstaged, untracked] = yield* Effect.all(
        [
          resolveBase(worktree.path),
          readDiffRecords("OpenWork.wip.staged", worktree.path, ["diff", "--cached"], ["--"]),
          readDiffRecords("OpenWork.wip.unstaged", worktree.path, ["diff"], ["--"]),
          readUntracked(worktree.path),
        ],
        { concurrency: READ_CONCURRENCY },
      );
      const [summary, history] = yield* Effect.all(
        [
          summarize(worktree, repository, base),
          base && worktree.head
            ? readCommits(worktree.path, base)
            : Effect.succeed({ commits: [], commitsTruncated: false }),
        ],
        { concurrency: 2 },
      );
      return {
        worktree: summary,
        ...history,
        wip: groupWip(
          {
            staged: staged.files,
            unstaged: unstaged.files,
            untracked: untracked.paths,
            cut: staged.cut || unstaged.cut || untracked.cut,
          },
          OPEN_WORK_MAX_WIP_FILES,
        ),
      };
    },
  );

  const commitFiles: OpenWork["Service"]["commitFiles"] = Effect.fn("OpenWork.commitFiles")(
    function* (input) {
      const { worktree } = yield* resolveWorktree(input.path, input.projectId);
      const { files, cut } = yield* readDiffRecords(
        "OpenWork.commitFiles",
        worktree.path,
        ["diff-tree", "-r", "--root", "--diff-merges=first-parent", "--no-commit-id"],
        [input.sha],
      );
      return {
        sha: input.sha,
        files: files.slice(0, OPEN_WORK_MAX_FILES_PER_COMMIT),
        truncated: cut || files.length > OPEN_WORK_MAX_FILES_PER_COMMIT,
      };
    },
  );

  const pathspecs = (file: OpenWorkDiffInput["file"]) =>
    [file.path, ...(file.previousPath ? [file.previousPath] : [])].map(
      (filePath) => `:(top,literal)${filePath}`,
    );

  const commitDiff = Effect.fn("OpenWork.commitDiff")(function* (
    cwd: string,
    input: OpenWorkDiffInput & { readonly step: { readonly kind: "commit" } },
  ) {
    const commit = yield* run("OpenWork.diff.commit", cwd, [
      "show",
      "--no-patch",
      "--format=%H%x00%P%x00%s",
      `${input.step.sha}^{commit}`,
    ]);
    const [sha = "", parents = "", subject = ""] = commit.stdout.trimEnd().split("\0");
    const parent =
      parents.split(" ").find(Boolean) ??
      (yield* run("OpenWork.diff.emptyTree", cwd, ["hash-object", "-t", "tree", "--stdin"], {
        stdin: "",
      })).stdout.trim();
    const options = [...DIFF_ARGS, ...(input.ignoreWhitespace ? ["--ignore-all-space"] : [])];
    const range = [parent, sha, "--", ...pathspecs(input.file)];
    const [stats, patch] = yield* Effect.all(
      [
        run("OpenWork.diff.stat", cwd, [...options, "--raw", "--numstat", "-z", ...range]),
        git
          .execute({
            operation: "OpenWork.diff.patch",
            cwd,
            args: [...options, "--patch", ...range],
            maxOutputBytes: PATCH_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          })
          .pipe(Effect.mapError(toGitError("OpenWork.diff.patch"))),
      ],
      { concurrency: 2 },
    );
    return {
      title: `${sha.slice(0, 7)} · ${subject}`,
      baseRef: parent,
      headRef: sha,
      diff: patch.stdout,
      truncated: patch.stdoutTruncated,
      files: parseDiffRecords(stats.stdout.split("\0")).map((file) => ({
        path: file.path,
        previousPath: file.previousPath,
        additions: file.insertions,
        deletions: file.deletions,
      })),
    } satisfies OpenWorkDiffResult;
  });

  const wipDiff = Effect.fn("OpenWork.wipDiff")(function* (cwd: string, input: OpenWorkDiffInput) {
    // Calls the driver, not ReviewService: resolveWorktree already authorized the path, and
    // ReviewService rejects worktrees outside upstream's managed folders.
    const preview = yield* git
      .getReviewDiffPreview({
        cwd,
        file: { ...input.file, sourceKind: "working-tree" },
        ...(input.ignoreWhitespace === undefined
          ? {}
          : { ignoreWhitespace: input.ignoreWhitespace }),
      })
      .pipe(Effect.mapError(toGitError("OpenWork.diff.wip")));
    const source = preview.sources.find((candidate) => candidate.kind === "working-tree");
    return {
      title: source?.title ?? "Uncommitted",
      baseRef: source?.baseRef ?? "HEAD",
      headRef: source?.headRef ?? null,
      diff: source?.diff ?? "",
      truncated: source?.truncated ?? false,
      files: source?.files ?? [],
    } satisfies OpenWorkDiffResult;
  });

  const diff: OpenWork["Service"]["diff"] = Effect.fn("OpenWork.diff")(function* (input) {
    const { worktree } = yield* resolveWorktree(input.path, input.projectId);
    return input.step.kind === "commit"
      ? yield* commitDiff(worktree.path, { ...input, step: input.step })
      : yield* wipDiff(worktree.path, input);
  });

  return OpenWork.of({ list, timeline, diff, commitFiles });
});

export const layer = Layer.effect(OpenWork, make);

/** Open work on an environment with no registered projects: nothing listed, every path refused. */
export const testLayer = Layer.succeed(
  OpenWork,
  OpenWork.of({
    list: () => Effect.succeed({ worktrees: [] }),
    timeline: ({ path }) => Effect.fail(new OpenWorkWorktreeNotFoundError({ path })),
    diff: ({ path }) => Effect.fail(new OpenWorkWorktreeNotFoundError({ path })),
    commitFiles: ({ path }) => Effect.fail(new OpenWorkWorktreeNotFoundError({ path })),
  }),
);
