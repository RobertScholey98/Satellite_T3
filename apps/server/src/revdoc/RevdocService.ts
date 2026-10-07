import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  ThreadId,
  PreviewAutomationSnapshot,
  RevdocError,
  RevdocReview,
  type RevdocDetail,
  type RevdocAttempt,
  type RevdocBatchActivity,
  type RevdocCaptureInput,
  type RevdocRecordTestInput,
  type RevdocStartInput,
  type RevdocTest,
  type RevdocTestStartInput,
  type RevdocTestingRun,
  type RevdocInput,
  type RevdocRunState,
  type RevdocSaveInput,
  type RevdocWorktrees,
  type RevdocWorktreesInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import {
  reviewTests,
  selectTests,
  staleTestIds,
  testDefinitionRevision,
  testingPrompt,
  withTestAttempt,
} from "./RevdocTesting.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  reconcileRevdoc,
  RevdocGenerationCheckpoint,
  type RevdocGenerationActivity,
  type RevdocGenerationResult,
} from "./RevdocGeneration.ts";
import {
  MAX_REVDOC_PROMPT_BYTES,
  mergeRevdocBatch,
  mergeRevdocConsolidation,
  planRevdocBatches,
  revdocConsolidationGroups,
  revdocConsolidationPrompt,
} from "./RevdocBatching.ts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 180_000;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
// Streamed model progress is published at most this often; the batch's finish publishes the rest.
const ACTIVITY_PUBLISH_INTERVAL_MS = 1_000;
const ACTIVITY_THINKING_CHARS = 600;
const idle: RevdocRunState = { running: false, error: null, result: null, version: 0 };
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const fail = (message: string) => new RevdocError({ message });
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(fromJsonStringPretty(Schema.Unknown));
const decodeSnapshot = Schema.decodeUnknownEffect(PreviewAutomationSnapshot);
const decodeCheckpoint = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RevdocGenerationCheckpoint),
);
const isReview = Schema.is(RevdocReview);
const isRevdocError = Schema.is(RevdocError);

export class RevdocService extends Context.Service<
  RevdocService,
  {
    readonly get: (input: RevdocInput) => Effect.Effect<RevdocDetail, RevdocError>;
    readonly start: (input: RevdocStartInput) => Effect.Effect<void, RevdocError>;
    readonly startTesting: (input: RevdocTestStartInput) => Effect.Effect<void, RevdocError>;
    readonly beginTest: (
      scope: McpInvocationScope,
      input: { runId: string; testId: string },
    ) => Effect.Effect<void, RevdocError>;
    readonly captureEvidence: (
      scope: McpInvocationScope,
      input: RevdocCaptureInput,
    ) => Effect.Effect<void, RevdocError>;
    readonly recordTest: (
      scope: McpInvocationScope,
      input: RevdocRecordTestInput,
    ) => Effect.Effect<void, RevdocError>;
    readonly cancel: (input: RevdocInput) => Effect.Effect<void, RevdocError>;
    readonly save: (input: RevdocSaveInput) => Effect.Effect<RevdocDetail, RevdocError>;
    readonly changes: (input: RevdocInput) => Stream.Stream<RevdocRunState, RevdocError>;
    readonly worktrees: (
      input: RevdocWorktreesInput,
    ) => Effect.Effect<RevdocWorktrees, RevdocError>;
  }
>()("t3/revdoc/RevdocService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const browser = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const scope = yield* Effect.scope;
  const changes = yield* SubscriptionRef.make<ReadonlyMap<string, RevdocRunState>>(new Map());
  const writes = yield* Semaphore.make(1);
  const cancellations = new Set<string>();
  const jobs = new Map<string, Fiber.Fiber<void, never>>();
  const notify = (cwd: string, state: Omit<RevdocRunState, "version">) =>
    SubscriptionRef.update(changes, (current) =>
      new Map(current).set(cwd, {
        ...state,
        version: (current.get(cwd)?.version ?? 0) + 1,
      }),
    );

  const threadRoot = Effect.fn("RevdocService.threadRoot")(function* (threadId: ThreadId) {
    const thread = yield* snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.mapError(() => fail("Could not read the thread.")));
    if (Option.isNone(thread)) return yield* fail("The thread no longer exists.");
    const project = yield* snapshots
      .getProjectShellById(thread.value.projectId)
      .pipe(Effect.mapError(() => fail("Could not read the project.")));
    if (Option.isNone(project)) return yield* fail("The project no longer exists.");
    const root = yield* fs
      .realPath(thread.value.worktreePath ?? project.value.workspaceRoot)
      .pipe(Effect.mapError(() => fail("The thread's worktree is unavailable.")));
    return { root, thread: thread.value };
  });

  // Every checked-out worktree of the repository containing `cwd`. Bare and
  // missing entries are skipped, so a bare-repo container yields only its
  // worktrees. Paths are real paths, comparable with `path.relative`.
  const listWorktrees = Effect.fn("RevdocService.listWorktrees")(function* (cwd: string) {
    const result = yield* git
      .execute({
        cwd,
        args: ["worktree", "list", "--porcelain", "-z"],
        operation: "Revdoc.worktrees",
        allowNonZeroExit: true,
        timeoutMs: 15_000,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (!result || result.exitCode !== 0) return [];
    const entries: Array<{ path: string; branch: string | null }> = [];
    let entry: { path: string; branch: string | null; skip: boolean } | null = null;
    for (const field of [...result.stdout.split("\0"), ""]) {
      if (field === "") {
        if (entry && !entry.skip) {
          const resolved = yield* fs.realPath(entry.path).pipe(Effect.option);
          if (Option.isSome(resolved)) entries.push({ path: resolved.value, branch: entry.branch });
        }
        entry = null;
      } else if (field.startsWith("worktree ")) {
        entry = { path: field.slice("worktree ".length), branch: null, skip: false };
      } else if (entry && field.startsWith("branch ")) {
        entry.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
      } else if (entry && (field === "bare" || field.startsWith("prunable"))) {
        entry.skip = true;
      }
    }
    return entries;
  });

  // Revdoc targets the thread's worktree unless the caller picks another
  // worktree of the same repository.
  const resolve = Effect.fn("RevdocService.resolve")(function* (input: RevdocInput) {
    const { root, thread } = yield* threadRoot(input.threadId);
    const own = {
      cwd: root,
      thread,
      checkout: { branch: thread.branch, worktreePath: thread.worktreePath },
    };
    if (input.worktreePath === undefined) return own;
    const unavailable = "The selected worktree is unavailable. Pick another worktree for Revdoc.";
    const requested = yield* fs
      .realPath(input.worktreePath)
      .pipe(Effect.mapError(() => fail(unavailable)));
    if (path.relative(root, requested) === "") return own;
    const match = (yield* listWorktrees(root)).find(
      (worktree) => path.relative(worktree.path, requested) === "",
    );
    if (!match) return yield* fail(unavailable);
    return {
      cwd: match.path,
      thread,
      checkout: { branch: match.branch, worktreePath: match.path },
    };
  });

  const worktrees = Effect.fn("RevdocService.worktrees")(function* (input: RevdocWorktreesInput) {
    const { root } = yield* threadRoot(input.threadId);
    return { defaultPath: root, worktrees: yield* listWorktrees(root) };
  });

  const checkedPath = Effect.fn("RevdocService.checkedPath")(
    function* (cwd: string, filename = "review.json") {
      const currentRoot = yield* fs.realPath(cwd);
      if (path.relative(cwd, currentRoot) !== "") {
        return yield* fail("The worktree moved while this pass was running. Reopen its review.");
      }
      const directory = path.join(cwd, ".revdoc");
      const file = path.join(directory, filename);
      for (const candidate of [directory, file]) {
        if (!(yield* fs.exists(candidate))) continue;
        const resolved = yield* fs.realPath(candidate);
        if (path.relative(candidate, resolved) !== "") {
          return yield* fail("The review must stay inside this worktree's .revdoc directory.");
        }
      }
      return file;
    },
    Effect.mapError((error) => (isRevdocError(error) ? error : fail("Could not access .revdoc."))),
  );

  const read = Effect.fn("RevdocService.read")(function* (
    cwd: string,
  ): Effect.fn.Return<RevdocDetail, RevdocError> {
    const file = yield* checkedPath(cwd);
    if (!(yield* fs.exists(file).pipe(Effect.mapError(() => fail("Could not read the review."))))) {
      return { cwd, revision: null, review: null };
    }
    const size = yield* fs
      .stat(file)
      .pipe(Effect.mapError(() => fail("Could not read the review.")));
    if (size.size > BigInt(MAX_REVIEW_BYTES))
      return yield* fail("The review exceeds the 2 MB limit.");
    const content = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError(() => fail("Could not read the review.")));
    const review = yield* decodeJson(content).pipe(
      Effect.mapError(() =>
        fail("Invalid .revdoc/review.json. Expected Revdoc's sections → items → tests format."),
      ),
    );
    if (!isReview(review))
      return yield* fail(
        "Invalid .revdoc/review.json. Expected Revdoc's sections → items → tests format.",
      );
    yield* validate(review);
    return { cwd, revision: hash(content), review };
  });
  const validate = Effect.fnUntraced(function* (review: RevdocReview) {
    const sections = review.sections;
    const items = sections.flatMap((s) => s.items);
    const tests = items.flatMap((i) => i.tests);
    for (const entries of [sections, items, tests]) {
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
        return yield* fail("Review sections, items, and tests must have unique stable IDs.");
      }
    }
  });
  const prepare = Effect.fn("RevdocService.prepare")(function* (cwd: string) {
    const file = yield* checkedPath(cwd);
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.mapError(() => fail("Could not create .revdoc.")));
    const ignore = path.join(path.dirname(file), ".gitignore");
    if (
      !(yield* fs.exists(ignore).pipe(Effect.mapError(() => fail("Could not inspect .revdoc."))))
    ) {
      yield* fs
        .writeFileString(ignore, "*\n", { flag: "wx" })
        .pipe(Effect.mapError(() => fail("Could not keep the review out of commits.")));
    }
    yield* fs
      .makeDirectory(path.join(path.dirname(file), "evidence"), { recursive: true })
      .pipe(Effect.mapError(() => fail("Could not create .revdoc/evidence.")));
  });
  const write = Effect.fn("RevdocService.write")(function* (
    cwd: string,
    review: RevdocReview,
    expectedRevision: string | null,
  ) {
    yield* validate(review);
    const current = yield* read(cwd);
    if (current.revision !== expectedRevision) {
      return yield* fail(
        "The review changed since this pass began. Refresh it and try again; your saved review was preserved.",
      );
    }
    const file = yield* checkedPath(cwd);
    const content = encodeJson(review) + "\n";
    if (Buffer.byteLength(content) > MAX_REVIEW_BYTES)
      return yield* fail("The review exceeds the 2 MB limit.");
    yield* prepare(cwd);
    yield* writeFileStringAtomically({ filePath: file, contents: content }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => fail("Could not save the review.")),
    );
    return { cwd, review, revision: hash(content) } satisfies RevdocDetail;
  });
  const readCheckpoint = Effect.fn("RevdocService.readCheckpoint")(function* (cwd: string) {
    const file = yield* checkedPath(cwd, "generation.json");
    if (!(yield* fs.exists(file))) return null;
    if ((yield* fs.stat(file)).size > BigInt(MAX_SOURCE_BYTES)) return null;
    const content = yield* fs.readFileString(file);
    // An incompatible or damaged checkpoint only loses reuse, never the saved review.
    return yield* decodeCheckpoint(content).pipe(Effect.orElseSucceed(() => null));
  });
  const writeCheckpoint = Effect.fn("RevdocService.writeCheckpoint")(function* (
    cwd: string,
    checkpoint: RevdocGenerationCheckpoint,
  ) {
    const contents = encodeJson(checkpoint) + "\n";
    if (Buffer.byteLength(contents) > MAX_SOURCE_BYTES)
      return yield* fail(
        "Saved generation progress exceeds 64 MB. The partial review was preserved.",
      );
    const filePath = yield* checkedPath(cwd, "generation.json");
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => fail("Could not save Revdoc generation progress.")),
    );
  });
  const execute = (cwd: string, args: readonly string[], allowNonZeroExit = false) =>
    git
      .execute({
        cwd,
        args,
        operation: "Revdoc.context",
        allowNonZeroExit: true,
        env: { LC_ALL: "C" },
        maxOutputBytes: MAX_CONTEXT_BYTES,
        timeoutMs: 15_000,
      })
      .pipe(
        Effect.mapError((error) => fail(`Could not run Git for Revdoc: ${error.detail}`)),
        Effect.flatMap((result) => {
          if (result.exitCode === 0) return Effect.succeed(result);
          if (result.stderr.includes("detected dubious ownership")) {
            return Effect.fail(
              fail(
                `Git refuses to read "${cwd}" because it is owned by another account. If you trust this folder, add it to Git's safe.directory list, then retry Revdoc.`,
              ),
            );
          }
          if (result.stderr.includes("not a git repository")) {
            return Effect.fail(
              fail("This folder is not a Git repository. Initialize Git before running Revdoc."),
            );
          }
          if (allowNonZeroExit) return Effect.succeed(result);
          const detail = result.stderr.trim().split("\n")[0]?.slice(0, 1000);
          return Effect.fail(
            fail(
              detail
                ? `Could not read this worktree's Git changes: ${detail}`
                : "Could not read this worktree's Git changes.",
            ),
          );
        }),
      );

  const context = Effect.fn("RevdocService.context")(function* (cwd: string) {
    const head = (yield* execute(cwd, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
    const remoteName = yield* git
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    const defaultBranch = remoteName
      ? yield* git.resolveDefaultBranchName(cwd, remoteName).pipe(Effect.orElseSucceed(() => null))
      : null;
    let base = head;
    const candidates = [
      ...(remoteName && defaultBranch ? [`refs/remotes/${remoteName}/${defaultBranch}`] : []),
      "refs/heads/main",
      "refs/heads/master",
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const result = yield* execute(cwd, ["merge-base", "HEAD", candidate], true);
      if (result.exitCode === 0) {
        base = result.stdout.trim();
        break;
      }
    }
    // Git writes the complete patch directly to a scoped file, bypassing the stdout cap.
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-revdoc-source-" });
    const patch = path.join(directory, "changes.patch");
    yield* execute(cwd, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=4",
      `--output=${patch}`,
      base,
      "--",
      ".",
      ":(exclude).revdoc",
    ]);
    const patchSize = (yield* fs.stat(patch)).size;
    if (patchSize > BigInt(MAX_SOURCE_BYTES))
      return yield* fail(
        "The review source exceeds 64 MB. Narrow the comparison before generating a review; the saved review was preserved.",
      );
    const diff = yield* fs.readFileString(patch);
    const untracked = yield* execute(cwd, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
      ":(exclude).revdoc",
    ]);
    if (untracked.stdoutTruncated)
      return yield* fail("Too many untracked files for a single Revdoc pass.");
    const parts = [diff];
    const digest = NodeCrypto.createHash("sha256").update(base).update("\0").update(diff);
    let contextBytes = Buffer.byteLength(diff);
    const files = [...(diff.match(/^diff --git .+$/gm) ?? [])];
    for (const relative of untracked.stdout.split("\0").filter(Boolean)) {
      const file = path.join(cwd, relative);
      const resolved = yield* fs
        .realPath(file)
        .pipe(Effect.mapError(() => fail("Could not read an untracked file.")));
      const resolvedRelative = path.relative(cwd, resolved);
      if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) continue;
      const stat = yield* fs
        .stat(file)
        .pipe(Effect.mapError(() => fail("Could not read an untracked file.")));
      digest.update(relative).update("\0");
      files.push(`Untracked file: ${relative}`);
      if (stat.type !== "File" || stat.size > BigInt(MAX_SOURCE_BYTES)) {
        parts.push(`Untracked file: ${relative} (content omitted: binary or large file)`);
        digest.update(String(stat.size)).update(String(stat.mtime));
      } else {
        const content = yield* fs
          .readFileString(file)
          .pipe(Effect.mapError(() => fail("Could not read an untracked file.")));
        digest.update(content);
        parts.push(
          content.includes("\0")
            ? `Binary file: ${relative}`
            : `Untracked file: ${relative}\n${content}`,
        );
      }
      contextBytes += Buffer.byteLength(parts.at(-1)!) + 1;
      if (contextBytes > MAX_SOURCE_BYTES) {
        return yield* fail(
          "The review source exceeds 64 MB. Narrow the comparison before generating a review; the saved review was preserved.",
        );
      }
    }
    return {
      changes: parts.join("\n"),
      sourceRevision: `${head}:${digest.digest("hex")}`,
      overview: `Comparison base: ${base}\nHEAD: ${head}\n${files.length} changed files\n${files.slice(0, 200).join("\n").slice(0, 16_000)}\n${files.length > 200 ? "Additional filenames omitted from this overview; their patches are included in the batches." : ""}`,
    };
  });

  const sourceRevision = Effect.fn("RevdocService.sourceRevision")(
    function* (cwd: string) {
      const head = (yield* execute(cwd, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
      const raw = yield* execute(cwd, [
        "diff",
        "--raw",
        "--no-ext-diff",
        "HEAD",
        "--",
        ".",
        ":(exclude).revdoc",
      ]);
      const changed = yield* execute(cwd, [
        "diff",
        "--name-only",
        "--no-ext-diff",
        "-z",
        "HEAD",
        "--",
        ".",
        ":(exclude).revdoc",
      ]);
      const untracked = yield* execute(cwd, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
        ":(exclude).revdoc",
      ]);
      if ([raw, changed, untracked].some((result) => result.stdoutTruncated)) {
        return yield* fail("Too many changes to identify the code being tested.");
      }
      const digest = NodeCrypto.createHash("sha256").update(head).update(raw.stdout);
      const files = [
        ...new Set(
          [...changed.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean),
        ),
      ].sort();
      for (const relative of files) {
        const file = path.join(cwd, relative);
        digest.update(relative).update("\0");
        if (!(yield* fs.exists(file))) {
          digest.update("deleted\0");
          continue;
        }
        const resolved = yield* fs.realPath(file);
        const location = path.relative(cwd, resolved);
        if (location.startsWith("..") || path.isAbsolute(location)) {
          return yield* fail(
            "A changed file points outside this worktree; its test revision cannot be verified.",
          );
        }
        const stat = yield* fs.stat(file);
        if (stat.type !== "File")
          return yield* fail(
            "A changed directory or submodule needs its own review before testing.",
          );
        yield* fs.stream(file).pipe(
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              digest.update(chunk);
            }),
          ),
        );
        digest.update("\0");
      }
      return `${head}:${digest.digest("hex")}`;
    },
    Effect.mapError((error) =>
      isRevdocError(error) ? error : fail("Could not identify the code being tested."),
    ),
  );

  const mapTests = (
    review: RevdocReview,
    update: (test: RevdocTest) => RevdocTest,
  ): RevdocReview => ({
    ...review,
    sections: review.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item, tests: item.tests.map(update) })),
    })),
  });
  const progress = (review: RevdocReview) => {
    const run = review.testing!;
    const attempts = reviewTests(review).flatMap((test) => {
      const attempt = test.attempts?.at(-1);
      return attempt?.runId === run.id ? [{ test, attempt }] : [];
    });
    const active = attempts.find(({ attempt }) => attempt.state === "running");
    return {
      running: run.status === "running",
      phase: "testing" as const,
      testingThreadId: run.threadId,
      total: run.testIds.length,
      completed: attempts.filter(({ attempt }) => !["running", "queued"].includes(attempt.state))
        .length,
      ...(active ? { activeTestId: active.test.id } : {}),
      error: run.error ?? null,
      result: null,
    };
  };
  const finishTesting = Effect.fn("RevdocService.finishTesting")(function* (
    cwd: string,
    runId: string,
    status: RevdocTestingRun["status"],
    message?: string,
  ) {
    const detail = yield* read(cwd);
    if (!detail.review?.testing || detail.review.testing.id !== runId) return;
    const finishedAt = DateTime.formatIso(yield* DateTime.now);
    const review = mapTests(
      {
        ...detail.review,
        testing: {
          ...detail.review.testing,
          status,
          finishedAt,
          ...(message ? { error: message } : {}),
        },
      },
      (test) => {
        const attempt = test.attempts?.at(-1);
        if (!attempt || attempt.runId !== runId || !["queued", "running"].includes(attempt.state))
          return test;
        return withTestAttempt(test, {
          ...attempt,
          state: "blocked",
          finishedAt,
          observed: message ?? "The testing agent finished without recording this check.",
        });
      },
    );
    yield* write(cwd, review, detail.revision);
    yield* notify(cwd, { ...progress(review), running: jobs.has(cwd) });
  });
  const get = Effect.fn("RevdocService.get")(function* (input: RevdocInput) {
    const { cwd } = yield* resolve(input);
    const detail = yield* writes.withPermit(
      Effect.gen(function* () {
        const current = yield* read(cwd);
        if (current.review?.testing?.status === "running" && !jobs.has(cwd)) {
          yield* finishTesting(
            cwd,
            current.review.testing.id,
            "interrupted",
            "The server restarted before this testing pass finished. Saved results are preserved; retry the remaining checks.",
          );
          return yield* read(cwd);
        }
        return current;
      }),
    );
    if (!detail.review || !reviewTests(detail.review).some((test) => test.attempts?.length))
      return detail;
    const revision = yield* sourceRevision(cwd).pipe(Effect.orElseSucceed(() => null));
    return {
      ...detail,
      currentSourceRevision: revision,
      staleTestIds: staleTestIds(detail.review, revision),
    };
  });

  const testWorktree = Effect.fn("RevdocService.testWorktree")(function* (
    input: RevdocTestStartInput,
  ) {
    const { cwd, thread, checkout } = yield* resolve(input);
    const config = yield* settings.getSettings;
    const modelSelection =
      config.revdocTestingModelSelection ?? config.revdocModelSelection ?? thread.modelSelection;
    const instance = yield* providers.getInstance(modelSelection.instanceId);
    if (!instance?.enabled)
      return yield* fail(
        "Choose an available testing model in Settings → Text generation → Revdoc.",
      );
    const revision = yield* sourceRevision(cwd);
    const runId = NodeCrypto.randomUUID();
    const testingThreadId = ThreadId.make(NodeCrypto.randomUUID());
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const prepared = yield* writes.withPermit(
          Effect.gen(function* () {
            const detail = yield* read(cwd);
            if (!detail.review) return yield* fail("Generate a review before testing it.");
            const tests = selectTests(detail.review, input, revision);
            if (input.testIds?.some((id) => !tests.some((test) => test.id === id)))
              return yield* fail("A selected check no longer exists. Refresh the review.");
            if (!tests.length) return null;
            const selected = new Set(tests.map((test) => test.id));
            const testing: RevdocTestingRun = {
              id: runId,
              threadId: testingThreadId,
              audience: "revdoc",
              sourceRevision: revision,
              status: "running",
              startedAt,
              testIds: [...selected],
            };
            const review = mapTests({ ...detail.review, testing }, (test) =>
              selected.has(test.id)
                ? withTestAttempt(test, {
                    runId,
                    state: "queued",
                    by: `${modelSelection.instanceId} / ${modelSelection.model}`,
                    sourceRevision: revision,
                    definitionRevision: testDefinitionRevision(test),
                    startedAt,
                    evidence: [],
                  })
                : test,
            );

            yield* write(cwd, review, detail.revision);
            yield* notify(cwd, progress(review));
            return { tests, title: review.title };
          }),
        );
        if (!prepared) return;
        let created = false;
        yield* restore(
          Effect.gen(function* () {
            const events = yield* engine.subscribeDomainEvents;
            yield* engine.dispatch({
              type: "thread.create",
              purpose: "revdoc",
              commandId: CommandId.make(NodeCrypto.randomUUID()),
              threadId: testingThreadId,
              projectId: thread.projectId,
              title: `Revdoc: ${prepared.title}`.slice(0, 200),
              modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: "default",
              // The testing thread works in the reviewed worktree, which is
              // also how its MCP calls find this review again.
              ...checkout,
              createdAt: startedAt,
            });
            created = true;
            yield* engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make(NodeCrypto.randomUUID()),
              threadId: testingThreadId,
              modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: "default",
              createdAt: startedAt,
              message: {
                messageId: MessageId.make(NodeCrypto.randomUUID()),
                role: "user",
                text: testingPrompt({ runId, cwd, title: prepared.title, tests: prepared.tests }),
                attachments: [],
              },
            });
            const terminal = yield* events.pipe(
              Stream.filter(
                (event) =>
                  (event.type === "thread.deleted" && event.payload.threadId === testingThreadId) ||
                  (event.type === "thread.session-set" &&
                    event.payload.threadId === testingThreadId &&
                    (event.payload.turnSettled === true ||
                      ["error", "stopped", "interrupted"].includes(event.payload.session.status))),
              ),
              Stream.runHead,
            );
            if (Option.isNone(terminal) || terminal.value.type !== "thread.session-set")
              return yield* fail("The testing agent stopped before finishing.");
            const session = terminal.value.payload.session;
            if (["error", "stopped", "interrupted"].includes(session.status))
              return yield* fail(
                session.lastError ??
                  "The testing agent was interrupted. Saved results are preserved.",
              );
          }),
        ).pipe(
          Effect.mapError((error) =>
            isRevdocError(error) ? error : fail("Could not run the testing agent."),
          ),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const interrupted =
                cancellations.has(cwd) ||
                (exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause));
              const message =
                exit._tag === "Failure"
                  ? interrupted
                    ? "Testing cancelled. Saved results are preserved."
                    : String(Cause.squash(exit.cause))
                  : undefined;
              if (created && exit._tag === "Failure") {
                yield* engine
                  .dispatch({
                    type: "thread.turn.interrupt",
                    commandId: CommandId.make(NodeCrypto.randomUUID()),
                    threadId: testingThreadId,
                    createdAt: DateTime.formatIso(yield* DateTime.now),
                  })
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Could not interrupt Revdoc testing thread", cause),
                    ),
                  );
              }
              yield* writes
                .withPermit(
                  finishTesting(
                    cwd,
                    runId,
                    interrupted ? "cancelled" : exit._tag === "Failure" ? "failed" : "completed",
                    message,
                  ),
                )
                .pipe(
                  Effect.tapError((error) =>
                    Effect.logError("Could not finalize Revdoc testing results", error),
                  ),
                );
            }),
          ),
        );
      }),
    );
  });

  const startTesting = Effect.fn("RevdocService.startTesting")(function* (
    input: RevdocTestStartInput,
  ) {
    const { cwd } = yield* resolve(input);
    yield* writes.withPermit(
      Effect.gen(function* () {
        if (jobs.has(cwd)) return;
        cancellations.delete(cwd);
        if (!(yield* read(cwd)).review) return yield* fail("Generate a review before testing it.");
        yield* notify(cwd, { running: true, phase: "testing", error: null, result: null });
        const job = yield* testWorktree(input).pipe(
          Effect.scoped,
          Effect.onExit((exit) =>
            writes.withPermit(
              Effect.gen(function* () {
                jobs.delete(cwd);
                const state = (yield* SubscriptionRef.get(changes)).get(cwd) ?? idle;
                yield* notify(cwd, {
                  ...state,
                  running: false,
                  result:
                    exit._tag === "Success"
                      ? "completed"
                      : cancellations.has(cwd) || Cause.hasInterruptsOnly(exit.cause)
                        ? "cancelled"
                        : null,
                  error:
                    exit._tag === "Failure" &&
                    !cancellations.has(cwd) &&
                    !Cause.hasInterruptsOnly(exit.cause)
                      ? String(Cause.squash(exit.cause))
                      : null,
                });
              }),
            ),
          ),
          Effect.ignore,
          Effect.forkIn(scope, { startImmediately: false }),
        );
        jobs.set(cwd, job);
      }),
    );
  });

  const activeTest = Effect.fn("RevdocService.activeTest")(function* (
    invocation: McpInvocationScope,
    input: { runId: string; testId: string },
  ) {
    const { cwd } = yield* resolve({ threadId: invocation.threadId });
    const detail = yield* read(cwd);
    const run = detail.review?.testing;
    if (
      !invocation.capabilities.has("documents") ||
      !run ||
      run.status !== "running" ||
      !jobs.has(cwd) ||
      run.id !== input.runId ||
      run.threadId !== invocation.threadId
    )
      return yield* fail("Only the active testing thread can report this run's results.");
    const test = reviewTests(detail.review!).find((test) => test.id === input.testId);
    const attempt = test?.attempts?.at(-1);
    if (!test || !attempt || attempt.runId !== run.id)
      return yield* fail("This check was not selected for the active run.");
    if (!["queued", "running"].includes(attempt.state))
      return yield* fail("This check already has a result. Start a retry to replace it.");
    if (
      attempt.definitionRevision !== testDefinitionRevision(test) ||
      attempt.sourceRevision !== (yield* sourceRevision(cwd))
    )
      return yield* fail(
        "The code or check changed during testing. Cancel this pass and retry against the current worktree.",
      );
    return { cwd, detail, test, attempt };
  });
  const updateAttempt = Effect.fnUntraced(function* (
    current: Effect.Success<ReturnType<typeof activeTest>>,
    attempt: RevdocAttempt,
  ) {
    const review = mapTests(current.detail.review!, (test) =>
      test.id === current.test.id ? withTestAttempt(test, attempt) : test,
    );
    yield* write(current.cwd, review, current.detail.revision);
    yield* notify(current.cwd, progress(review));
  });
  const beginTest = Effect.fn("RevdocService.beginTest")(function* (
    invocation: McpInvocationScope,
    input: { runId: string; testId: string },
  ) {
    yield* writes.withPermit(
      Effect.gen(function* () {
        const current = yield* activeTest(invocation, input);
        yield* updateAttempt(current, {
          ...current.attempt,
          state: "running",
          startedAt: DateTime.formatIso(yield* DateTime.now),
        });
      }),
    );
  });
  const captureEvidence = Effect.fn("RevdocService.captureEvidence")(function* (
    invocation: McpInvocationScope,
    input: RevdocCaptureInput,
  ) {
    if (!invocation.capabilities.has("preview"))
      return yield* fail("Browser access is disabled for this testing agent.");
    const initial = yield* writes.withPermit(activeTest(invocation, input));
    if (initial.attempt.state !== "running")
      return yield* fail("Begin this check before capturing evidence.");
    const snapshot = yield* browser
      .invoke({
        scope: invocation,
        operation: "snapshot",
        input: {},
        ...(input.tabId ? { tabId: input.tabId } : {}),
      })
      .pipe(
        Effect.flatMap(decodeSnapshot),
        Effect.mapError(() =>
          fail(
            "Could not capture the Browser tab. Open agent activity in the Revdoc sidebar to check Browser access or connection issues.",
          ),
        ),
      );
    const encoded = snapshot.screenshot.data;
    if (encoded.length > 14_000_000) return yield* fail("The screenshot exceeds the 10 MB limit.");
    const data = Buffer.from(encoded, "base64");
    if (
      data.length > 10_000_000 ||
      !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return yield* fail("The Browser returned an invalid PNG screenshot.");
    yield* writes
      .withPermit(
        Effect.gen(function* () {
          const current = yield* activeTest(invocation, input);
          if (current.attempt.evidence.length >= 10)
            return yield* fail("This check already has ten screenshots for this run.");
          yield* checkedPath(current.cwd);
          const directory = path.join(current.cwd, ".revdoc", "evidence");
          if (path.relative(directory, yield* fs.realPath(directory)) !== "")
            return yield* fail("Evidence must stay inside this worktree's .revdoc directory.");
          const id = NodeCrypto.randomUUID();
          const filename = `${id}.png`;
          yield* fs.writeFile(path.join(directory, filename), data, { flag: "wx" });
          const evidence = {
            id,
            path: `evidence/${filename}`,
            caption: input.caption,
            capturedAt: DateTime.formatIso(yield* DateTime.now),
            sourceRevision: current.attempt.sourceRevision,
          };
          yield* updateAttempt(current, {
            ...current.attempt,
            evidence: [...current.attempt.evidence, evidence],
          });
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isRevdocError(error) ? error : fail("Could not save screenshot evidence."),
        ),
      );
  });
  const recordTest = Effect.fn("RevdocService.recordTest")(function* (
    invocation: McpInvocationScope,
    input: RevdocRecordTestInput,
  ) {
    yield* writes.withPermit(
      Effect.gen(function* () {
        const current = yield* activeTest(invocation, input);
        if (current.attempt.state !== "running")
          return yield* fail("Begin this check before recording its result.");
        if (!input.steps.trim() || !input.observed.trim())
          return yield* fail("Record the actual steps and observed result or blocker.");
        if (
          input.method === "browser" &&
          input.result === "passed" &&
          !current.attempt.evidence.length
        )
          return yield* fail("Capture Browser evidence before marking a browser check passed.");
        yield* updateAttempt(current, {
          ...current.attempt,
          state: input.result,
          method: input.method,
          steps: input.steps,
          observed: input.observed,
          finishedAt: DateTime.formatIso(yield* DateTime.now),
        });
      }),
    );
  });
  const start = Effect.fn("RevdocService.start")(function* (input: RevdocStartInput) {
    const { cwd, thread } = yield* resolve(input);
    yield* writes
      .withPermit(
        Effect.gen(function* () {
          if (jobs.has(cwd)) return;
          cancellations.delete(cwd);
          const config = yield* settings.getSettings;
          const initial = yield* read(cwd);
          yield* notify(cwd, {
            running: true,
            phase: "generating",
            reviewRevision: initial.revision,
            error: null,
            result: null,
          });
          const job = yield* Effect.gen(function* () {
            const source = yield* context(cwd).pipe(Effect.scoped);
            yield* writes.withPermit(prepare(cwd));
            const detail = yield* snapshots
              .getThreadDetailSnapshot(input.threadId, { turnLimit: 30 })
              .pipe(Effect.mapError(() => fail("Could not read the thread's review context.")));
            const conversation = Option.isSome(detail)
              ? {
                  title: thread.title,
                  messages: detail.value.thread.messages.map((m) => ({
                    role: m.role,
                    text: m.text,
                  })),
                  plans: detail.value.thread.proposedPlans.map((p) => p.planMarkdown),
                  earlierTurnsOmitted: detail.value.page?.hasMore ?? false,
                }
              : { title: thread.title };
            const contextRevision = hash(encodeJson(conversation));
            const saved = yield* readCheckpoint(cwd);
            let recovered =
              saved?.sourceRevision === source.sourceRevision &&
              saved.contextRevision === contextRevision
                ? saved
                : null;
            const plan = (existing: RevdocReview | null) =>
              planRevdocBatches({
                thread: conversation,
                changes: source.changes,
                existing,
                overview: source.overview,
              });
            let prompts = plan(recovered ? recovered.previous : initial.review);
            if (recovered && recovered.batches.length !== prompts.length) {
              recovered = null;
              prompts = plan(initial.review);
            }
            let checkpoint: RevdocGenerationCheckpoint = recovered ?? {
              format: 1,
              sourceRevision: source.sourceRevision,
              contextRevision,
              previous: initial.review,
              batches: prompts.map(() => null),
              organized: [],
            };
            const large = prompts.length > 1;
            const modelSelection =
              (large ? config.revdocLargeModelSelection : null) ??
              config.revdocModelSelection ??
              thread.modelSelection;
            const instance = yield* providers.getInstance(modelSelection.instanceId);
            if (!instance?.enabled || !instance.textGeneration.generateRevdoc) {
              return yield* fail(
                `Choose an available provider and model in Settings → Text generation → ${large ? "Large Revdoc" : "Revdoc"}.`,
              );
            }
            const generate = instance.textGeneration.generateRevdoc;
            let completed = checkpoint.batches.filter((part) => part !== null).length;
            let reviewRevision = initial.revision;
            let stage: "reviewing" | "combining" = "reviewing";
            let total = prompts.length;
            // In-flight model calls, keyed by batch number within the current stage.
            const active = new Map<
              number,
              Omit<RevdocBatchActivity, "elapsedMs"> & { startedAt: number }
            >();
            let activityPublishedAt = -Infinity;
            const generationProgress = Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* notify(cwd, {
                running: true,
                phase: "generating",
                generationStage: stage,
                reviewRevision,
                completed,
                total,
                activity: [...active.values()]
                  .sort((a, b) => a.batch - b.batch)
                  .map(({ startedAt, ...entry }) => ({ ...entry, elapsedMs: now - startedAt })),
                error: null,
                result: null,
              });
            });
            const generatePart = Effect.fnUntraced(function* (prompt: string, batch: number) {
              if (Buffer.byteLength(prompt) > MAX_REVDOC_PROMPT_BYTES)
                return yield* fail(
                  "A review batch exceeds the prompt limit. The saved review was preserved.",
                );
              active.set(batch, {
                batch,
                startedAt: yield* Clock.currentTimeMillis,
                outputBytes: 0,
              });
              yield* generationProgress;
              const onActivity = (event: RevdocGenerationActivity) =>
                Effect.gen(function* () {
                  const current = active.get(batch);
                  if (!current) return;
                  active.set(
                    batch,
                    event.kind === "output"
                      ? {
                          ...current,
                          outputBytes: current.outputBytes + Buffer.byteLength(event.text),
                        }
                      : {
                          ...current,
                          ...(event.text
                            ? {
                                thinking: `${current.thinking ?? ""}${event.text}`.slice(
                                  -ACTIVITY_THINKING_CHARS,
                                ),
                              }
                            : {}),
                          ...(event.tokens !== undefined ? { thinkingTokens: event.tokens } : {}),
                        },
                  );
                  const now = yield* Clock.currentTimeMillis;
                  if (now - activityPublishedAt < ACTIVITY_PUBLISH_INTERVAL_MS) return;
                  activityPublishedAt = now;
                  yield* generationProgress;
                });
              const part = yield* generate({ cwd, modelSelection, prompt, onActivity }).pipe(
                Effect.mapError((error) => fail(error.message)),
                Effect.ensuring(
                  Effect.sync(() => {
                    active.delete(batch);
                  }),
                ),
              );
              if (!isReview(part))
                return yield* fail(
                  "The model returned an invalid review batch. The saved review was preserved.",
                );
              yield* validate(part);
              return part;
            }, Effect.scoped);
            const assembleBatches = () =>
              checkpoint.batches.reduce<RevdocReview | null>(
                (current, part) =>
                  part
                    ? large
                      ? mergeRevdocBatch(current, part, checkpoint.previous)
                      : part
                    : current,
                null,
              );
            const assemble = () => {
              const definitions = assembleBatches();
              if (!definitions) return null;
              const combined = checkpoint.organized.reduce(
                (current, part) =>
                  part ? mergeRevdocConsolidation(current, part, definitions) : current,
                definitions,
              );
              return large
                ? {
                    ...combined,
                    title: checkpoint.previous?.title ?? `${thread.title} review`,
                    summary: `Review changes to ${combined.sections.map((section) => section.area).join(", ")}.`,
                    context: source.overview,
                  }
                : combined;
            };
            const publishPartial = Effect.gen(function* () {
              const generated = assemble();
              if (!generated) return;
              const review = {
                ...reconcileRevdoc(initial.review, generated),
                sourceRevision: source.sourceRevision,
                generation: { stage, completed, total },
              };
              if (!isReview(review))
                return yield* fail(
                  "The combined review exceeds the document format limits. The saved review was preserved.",
                );
              const result = yield* write(cwd, review, reviewRevision);
              reviewRevision = result.revision;
            });
            const savePart = (part: RevdocGenerationResult, index: number) =>
              writes.withPermit(
                Effect.gen(function* () {
                  const field = stage === "reviewing" ? "batches" : "organized";
                  checkpoint = {
                    ...checkpoint,
                    [field]: checkpoint[field].map((saved, i) => (i === index ? part : saved)),
                  };
                  // Save model output first. If publishing is interrupted or conflicts, retry can reuse it.
                  yield* writeCheckpoint(cwd, checkpoint);
                  completed++;
                  if (large) yield* publishPartial;
                  yield* generationProgress;
                }).pipe(Effect.uninterruptible),
              );
            yield* generationProgress;
            yield* Effect.forEach(
              prompts,
              (prompt, index) =>
                Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    if (checkpoint.batches[index]) return;
                    const part = yield* restore(generatePart(prompt, index + 1));
                    yield* savePart(part, index);
                  }),
                ),
              { concurrency: 2 },
            );
            if (large) {
              const generated = assembleBatches()!;
              if (!isReview(generated))
                return yield* fail(
                  "The combined review exceeds the document format limits. The saved review was preserved.",
                );
              yield* validate(generated);
              const groups = revdocConsolidationGroups(generated);
              if (checkpoint.organized.length !== groups.length) {
                checkpoint = { ...checkpoint, organized: groups.map(() => null) };
              }
              completed = checkpoint.organized.filter((part) => part !== null).length;
              stage = "combining";
              total = groups.length;
              yield* writes.withPermit(publishPartial);
              yield* generationProgress;
              yield* Effect.forEach(
                groups,
                (group, index) =>
                  Effect.uninterruptibleMask((restore) =>
                    Effect.gen(function* () {
                      if (checkpoint.organized[index]) return;
                      const part = yield* restore(
                        generatePart(revdocConsolidationPrompt(group, source.overview), index + 1),
                      );
                      yield* savePart(part, index);
                    }),
                  ),
                { concurrency: 2 },
              );
            }
            const currentSource = yield* context(cwd).pipe(Effect.scoped);
            if (currentSource.sourceRevision !== source.sourceRevision)
              return yield* fail(
                "The worktree changed during generation. Run Revdoc again for the current changes; the saved review was preserved.",
              );
            const { generation: _generation, ...reconciled } = reconcileRevdoc(
              initial.review,
              assemble()!,
            );
            const review = {
              ...reconciled,
              sourceRevision: source.sourceRevision,
              generatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            if (!isReview(review))
              return yield* fail(
                "The model returned an invalid review. Your existing review was preserved.",
              );
            yield* writes.withPermit(
              Effect.gen(function* () {
                yield* write(cwd, review, reviewRevision);
                const file = yield* checkedPath(cwd, "generation.json");
                yield* fs.remove(file, { force: true });
              }).pipe(Effect.uninterruptible),
            );
            if ((input.action ?? config.revdocDefaultAction) === "generate-and-test") {
              yield* testWorktree({ ...input, selection: "remaining" });
            }
          }).pipe(
            // Provider files and processes must outlive the request that starts this pass.
            Effect.scoped,
            Effect.onExit((exit) =>
              writes.withPermit(
                Effect.gen(function* () {
                  jobs.delete(cwd);
                  if (exit._tag === "Success") {
                    return yield* notify(cwd, { running: false, error: null, result: "completed" });
                  }
                  if (cancellations.has(cwd) || Cause.hasInterruptsOnly(exit.cause)) {
                    return yield* notify(cwd, { running: false, error: null, result: "cancelled" });
                  }
                  const error = Cause.squash(exit.cause);
                  if (!isRevdocError(error))
                    yield* Effect.logError("Revdoc pass failed", exit.cause);
                  yield* notify(cwd, {
                    running: false,
                    result: null,
                    error: isRevdocError(error)
                      ? error.message
                      : "The Revdoc pass stopped unexpectedly. Try again.",
                  });
                }),
              ),
            ),
            Effect.ignore,
            Effect.forkIn(scope, { startImmediately: false }),
          );
          jobs.set(cwd, job);
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isRevdocError(error) ? error : fail("Could not start the Revdoc pass."),
        ),
      );
  });
  const cancel = Effect.fn("RevdocService.cancel")(function* (input: RevdocInput) {
    const { cwd } = yield* resolve(input);
    const job = jobs.get(cwd);
    if (job) {
      cancellations.add(cwd);
      yield* Fiber.interrupt(job);
    }
  });
  const save = Effect.fn("RevdocService.save")(function* (input: RevdocSaveInput) {
    const { cwd } = yield* resolve(input);
    return yield* writes.withPermit(
      Effect.gen(function* () {
        const current = yield* read(cwd);
        if (!current.review) return yield* fail("Create a review before saving feedback.");
        const change = input.change;
        let found = change.kind === "document";
        const review = {
          ...current.review,
          ...(change.kind === "document" ? { notes: change.note } : {}),
          sections: current.review.sections.map((section) => {
            const sectionChange = change.kind === "section" && change.id === section.id;
            if (sectionChange) found = true;
            return {
              ...section,
              ...(sectionChange ? { note: change.note } : {}),
              items: section.items.map((item) => {
                const itemChange = change.kind === "item" && change.id === item.id;
                if (itemChange) found = true;
                return {
                  ...item,
                  ...(itemChange ? { note: change.note } : {}),
                  tests: item.tests.map((test) => {
                    if (change.kind !== "test" || change.id !== test.id) return test;
                    found = true;
                    return { ...test, outcome: change.outcome, feedback: change.feedback };
                  }),
                };
              }),
            };
          }),
        };
        if (!found) return yield* fail("That review item no longer exists. Refresh the review.");
        const result = yield* write(cwd, review, input.expectedRevision);
        const state = (yield* SubscriptionRef.get(changes)).get(cwd) ?? idle;
        yield* notify(cwd, { ...state, reviewRevision: result.revision });
        return result;
      }),
    );
  });
  return RevdocService.of({
    get,
    start,
    startTesting,
    beginTest,
    captureEvidence,
    recordTest,
    cancel,
    save,
    worktrees,
    changes: (input) =>
      Stream.unwrap(
        resolve(input).pipe(
          Effect.map(({ cwd }) =>
            SubscriptionRef.changes(changes).pipe(
              Stream.map((states) => states.get(cwd) ?? idle),
              Stream.changes,
            ),
          ),
        ),
      ),
  });
});
export const layer = Layer.effect(RevdocService, make);
