import {
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type PreviewAutomationSnapshot,
  type ProjectId,
  REVDOC_LIMITS,
  type RevdocCaptureEvidenceInput,
  type RevdocDeleteInput,
  type RevdocEditItemInput,
  RevdocError,
  type RevdocEvent,
  type RevdocEvidence,
  type RevdocGenerateInput,
  type RevdocGetItemsInput,
  type RevdocItemDetail,
  type RevdocItemSummary,
  type RevdocPass,
  type RevdocPassReport,
  type RevdocRecordResultInput,
  type RevdocReviewHeader,
  type RevdocSnapshot,
  type RevdocTarget,
  type RevdocTestInput,
  type RevdocWorktrees,
  type RevdocWorktreesInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  applyCombined,
  checkKey,
  combineGroups,
  mergeUpserts,
  planBatches,
} from "./RevdocBatching.ts";
import * as RevdocExport from "./RevdocExport.ts";
import {
  codeFingerprint,
  deriveRetest,
  jsonBytes,
  jsonText,
  readContentHashes,
  sha256,
} from "./RevdocFingerprint.ts";
import {
  combinePrompt,
  compactItems,
  conversationExcerpt,
  gatherWorktreeChanges,
  GenerationOutput,
  listWorktrees,
  toUpsert,
  worktreeStamp,
} from "./RevdocGeneration.ts";
import { type ItemState, normaliseCoveredPaths, reconcile } from "./RevdocReconcile.ts";
import * as RevdocStore from "./RevdocStore.ts";
import {
  type Checkpoint,
  type Committed,
  newRevdocId,
  type PassData,
  type PassRecord,
  type ReviewKey,
  type ReviewRecord,
  revdocNow,
  type Upsert,
} from "./RevdocStore.ts";
import {
  delegateTesting,
  disposeCompletionDelivery,
  ensureParentRun,
  isTerminalRun,
  planSections,
  sectionPrompt,
  selectItems,
  sendSection,
  stopChild,
  UNRECORDED_IN_SECTION,
} from "./RevdocTesting.ts";

const MAX_READ_BYTES = 60_000;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const MAX_EVIDENCE_PER_ITEM = 10;
const BATCH_CONCURRENCY = 2;
const TASK_ENDED = new Set(["completed", "failed", "cancelled", "interrupted"]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A pass started by an agent through MCP rather than by a person. */
export interface AgentCaller {
  readonly threadId: ThreadId;
}

export interface RevdocReadResult {
  readonly review: RevdocReviewHeader | null;
  readonly activePass: RevdocPass | null;
  readonly items: ReadonlyArray<RevdocItemDetail>;
  readonly truncated: boolean;
}

const fail = (code: RevdocError["code"], message: string) => new RevdocError({ code, message });
const keyString = (key: ReviewKey) => `${key.projectId}\0${key.worktreePath}`;
const modelLabel = (selection: ModelSelection) => `${selection.instanceId}/${selection.model}`;
const emptyReport: RevdocPassReport = {
  added: 0,
  updated: 0,
  staled: 0,
  unstaled: 0,
  unknownIds: 0,
  dropped: 0,
  notReached: 0,
};

const itemSummary = (item: ItemState): RevdocItemSummary => ({
  id: item.id,
  revision: item.revision,
  position: item.position,
  area: item.area,
  check: item.check,
  outcome: item.outcome,
  note: item.note.slice(0, REVDOC_LIMITS.notePreview),
  noteTruncated: item.note.length > REVDOC_LIMITS.notePreview,
  retest: deriveRetest(item),
  stale: item.stalePassId !== null,
  dismissed: item.dismissed,
  result: item.result
    ? { state: item.result.state, evidenceCount: item.result.evidence.length }
    : null,
});

const itemDetail = (item: ItemState): RevdocItemDetail => {
  const { basis: _basis, ...result } = item.result ?? { basis: null };
  return {
    ...itemSummary(item),
    note: item.note,
    noteTruncated: false,
    expected: item.expected,
    coveredPaths: item.coveredPaths,
    result: item.result ? (result as RevdocItemDetail["result"]) : null,
  };
};

const reviewHeader = (review: ReviewRecord): RevdocReviewHeader => ({
  id: review.id,
  projectId: review.projectId,
  worktreePath: review.worktreePath,
  revision: review.revision,
  title: review.title,
  summary: review.summary,
  context: review.context,
  partial: review.partial,
  createdAt: review.createdAt,
  updatedAt: review.updatedAt,
  generatedAt: review.generatedAt,
  refreshedAt: review.refreshedAt,
  exportError: review.exportError,
});

const needsAttention = (item: RevdocItemDetail) =>
  !item.dismissed &&
  (item.outcome === "broken" ||
    item.outcome === "change_requested" ||
    item.retest !== null ||
    item.result?.state === "failed" ||
    item.result?.state === "blocked");

interface GenerationProgress {
  stage: "reviewing" | "combining";
  completed: number;
  total: number;
  readonly running: Map<number, number>;
}

interface ResolvedTarget {
  readonly key: ReviewKey;
  readonly thread: OrchestrationV2ThreadShell;
  /** The thread's own worktree, or the project root for a thread on the main checkout. */
  readonly defaultPath: string;
}

export class RevdocService extends Context.Service<
  RevdocService,
  {
    readonly worktrees: (
      input: RevdocWorktreesInput,
    ) => Effect.Effect<RevdocWorktrees, RevdocError>;
    readonly subscribe: (target: RevdocTarget) => Stream.Stream<RevdocEvent, RevdocError>;
    readonly getItems: (
      input: RevdocGetItemsInput,
    ) => Effect.Effect<{ readonly items: ReadonlyArray<RevdocItemDetail> }, RevdocError>;
    readonly read: (
      target: RevdocTarget,
      options: { readonly attentionOnly: boolean },
    ) => Effect.Effect<RevdocReadResult, RevdocError>;
    readonly generate: (
      input: RevdocGenerateInput,
      agent?: AgentCaller,
    ) => Effect.Effect<{ readonly passId: string }, RevdocError>;
    readonly test: (
      input: RevdocTestInput,
      agent?: AgentCaller,
    ) => Effect.Effect<{ readonly passId: string }, RevdocError>;
    readonly cancel: (
      target: RevdocTarget,
      agent?: AgentCaller,
    ) => Effect.Effect<void, RevdocError>;
    readonly refresh: (target: RevdocTarget) => Effect.Effect<void, RevdocError>;
    readonly editItem: (
      input: RevdocEditItemInput,
    ) => Effect.Effect<RevdocItemSummary, RevdocError>;
    readonly deleteReview: (input: RevdocDeleteInput) => Effect.Effect<void, RevdocError>;
    readonly recordResult: (
      input: RevdocRecordResultInput,
      callerThreadId: ThreadId,
    ) => Effect.Effect<RevdocItemSummary, RevdocError>;
    readonly captureEvidence: (
      input: RevdocCaptureEvidenceInput,
      scope: McpInvocationContext.McpThreadInvocationScope,
    ) => Effect.Effect<
      RevdocEvidence,
      RevdocError,
      PreviewAutomationBroker.PreviewAutomationBroker
    >;
    /** Cancels the worktree's pass and deletes its Review, rows and export. */
    readonly forgetWorktree: (worktreePath: string) => Effect.Effect<void>;
    readonly forgetProject: (projectId: ProjectId) => Effect.Effect<void>;
    /** Startup: forgets Reviews whose worktree is gone and recovers passes left running. */
    readonly recover: Effect.Effect<void>;
    /** The lifecycle reactor feeds orchestration events here; a section's end advances its pass. */
    readonly onOrchestrationEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/revdoc/RevdocService") {}

const make = Effect.gen(function* () {
  const store = yield* RevdocStore.RevdocStore;
  const exporter = yield* RevdocExport.RevdocExport;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const previews = yield* PreviewManager.PreviewManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const runtime = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | GitVcsDriver.GitVcsDriver
    | ThreadManagement.ThreadManagementService
  >();
  const provideRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideContext(effect, runtime);

  const events = yield* PubSub.unbounded<{ readonly key: string; readonly event: RevdocEvent }>();
  const generationFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
  const progress = new Map<string, GenerationProgress>();
  const children = new Map<string, string>();
  const runLock = Semaphore.makeUnsafe(1);

  const publish = (key: ReviewKey, event: RevdocEvent) =>
    PubSub.publish(events, { key: keyString(key), event }).pipe(Effect.asVoid);

  const passDto = (pass: PassRecord, now: number): RevdocPass => {
    const generation = progress.get(pass.id);
    return {
      id: pass.id,
      kind: pass.kind,
      status: pass.status,
      startedAt: pass.startedAt,
      finishedAt: pass.finishedAt,
      model: pass.data.model,
      error: pass.data.error,
      report: pass.data.report,
      generation:
        pass.status === "running" && generation
          ? {
              stage: generation.stage,
              completed: generation.completed,
              total: generation.total,
              running: [...generation.running].map(([batch, startedAt]) => ({
                batch,
                elapsedMs: Math.max(0, now - startedAt),
              })),
            }
          : null,
      testing:
        pass.kind === "test" && pass.data.parentThreadId
          ? {
              parentThreadId: pass.data.parentThreadId,
              childThreadId: pass.childThreadId,
              recorded: pass.data.recordedIds?.length ?? 0,
              total: Object.keys(pass.data.selection ?? {}).length,
              section: (pass.data.sectionIndex ?? 0) + 1,
              sections: pass.data.sections?.length ?? 0,
            }
          : null,
    };
  };

  const currentRevision = (key: ReviewKey) =>
    store
      .getReview(key)
      .pipe(Effect.map(Option.match({ onNone: () => 0, onSome: (r) => r.revision })));

  const publishPass = (pass: PassRecord) =>
    Effect.gen(function* () {
      const revision = yield* currentRevision(pass);
      const now = yield* Clock.currentTimeMillis;
      yield* publish(pass, {
        _tag: "delta",
        revision,
        ...(pass.status === "running"
          ? { activePass: passDto(pass, now) }
          : { activePass: null, latestPass: passDto(pass, now) }),
      });
    });

  const exportReview = (key: ReviewKey) =>
    Effect.gen(function* () {
      const review = yield* store.getReview(key);
      if (Option.isNone(review)) return;
      const items = yield* store.listItems(review.value.id);
      const active = (yield* store.listPasses(key)).find((pass) => pass.status === "running");
      const exported = yield* exporter
        .write({
          review: reviewHeader(review.value),
          items: items.map(itemDetail),
          activePass: active ? passDto(active, yield* Clock.currentTimeMillis) : null,
        })
        .pipe(
          Effect.as(null),
          Effect.catch((message) => Effect.succeed(message)),
        );
      if (exported !== review.value.exportError) {
        yield* store.setExportError(review.value.id, exported);
        yield* publish(key, {
          _tag: "delta",
          revision: review.value.revision,
          review: reviewHeader({ ...review.value, exportError: exported }),
        });
      }
    }).pipe(Effect.ignore);

  const publishCommit = (key: ReviewKey, committed: Committed) =>
    publish(key, {
      _tag: "delta",
      revision: committed.review.revision,
      review: reviewHeader(committed.review),
      items: committed.items.map(itemSummary),
      ...(committed.removed.length > 0 ? { removed: committed.removed } : {}),
    }).pipe(Effect.andThen(exportReview(key)));

  const resolveThread = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(() => fail("storage", "Revdoc could not read the thread.")),
      Effect.flatMap((thread) =>
        thread === null
          ? Effect.fail(fail("not_found", "The thread no longer exists."))
          : Effect.succeed(thread),
      ),
    );

  const threadRoot = Effect.fn("RevdocService.threadRoot")(function* (
    thread: OrchestrationV2ThreadShell,
  ) {
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(Effect.mapError(() => fail("storage", "Revdoc could not read the project.")));
    if (Option.isNone(project)) return yield* fail("not_found", "The project no longer exists.");
    const raw = thread.worktreePath ?? project.value.workspaceRoot;
    const real = yield* fs.realPath(raw).pipe(Effect.option);
    if (Option.isNone(real)) {
      yield* forgetWorktree(raw);
      return yield* fail("not_found", "This worktree no longer exists.");
    }
    return real.value;
  });

  const resolveTarget = Effect.fn("RevdocService.resolveTarget")(function* (target: RevdocTarget) {
    const thread = yield* resolveThread(target.threadId);
    const defaultPath = yield* threadRoot(thread);
    const resolved = (worktreePath: string): ResolvedTarget => ({
      key: { projectId: thread.projectId, worktreePath },
      thread,
      defaultPath,
    });
    if (target.worktreePath === undefined) return resolved(defaultPath);
    const unavailable = fail(
      "invalid_request",
      "The selected worktree is unavailable. Pick another worktree for Revdoc.",
    );
    const requested = yield* fs
      .realPath(target.worktreePath)
      .pipe(Effect.mapError(() => unavailable));
    if (requested === defaultPath) return resolved(defaultPath);
    const match = (yield* provideRuntime(listWorktrees(defaultPath))).find(
      (worktree) => worktree.path === requested,
    );
    if (!match) return yield* unavailable;
    return resolved(match.path);
  });

  const isTestingChild = store.isTestingThread;

  const guardRecursion = (threadId: ThreadId) =>
    Effect.flatMap(isTestingChild(threadId), (child) =>
      child
        ? Effect.fail(fail("not_allowed", "A Revdoc testing agent cannot start Revdoc passes."))
        : Effect.void,
    );

  /** The most recently active top-level thread in the worktree; a delegated child inherits its checkout. */
  const testParentFor = Effect.fn("RevdocService.testParentFor")(function* (
    resolved: ResolvedTarget,
  ) {
    if (
      resolved.key.worktreePath === resolved.defaultPath &&
      !(yield* isTestingChild(resolved.thread.id))
    ) {
      return resolved.thread.id;
    }
    const candidates = yield* threads
      .listProjectThreads({ projectId: resolved.key.projectId, includeSubagents: false })
      .pipe(Effect.orElseSucceed(() => []));
    const project = yield* projects
      .getById(resolved.key.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const workspaceRoot = Option.match(project, {
      onNone: () => null,
      onSome: (p) => p.workspaceRoot,
    });
    const inWorktree: OrchestrationV2ThreadShell[] = [];
    for (const candidate of candidates) {
      const raw = candidate.worktreePath ?? workspaceRoot;
      if (raw === null) continue;
      const real = yield* fs.realPath(raw).pipe(Effect.orElseSucceed(() => raw));
      if (real === resolved.key.worktreePath) inWorktree.push(candidate);
    }
    const activity = (thread: OrchestrationV2ThreadShell) =>
      Math.max(
        thread.latestUserMessageAt?.epochMilliseconds ?? 0,
        thread.latestRunStartedAt?.epochMilliseconds ?? 0,
      );
    return inWorktree.toSorted((a, b) => activity(b) - activity(a))[0]?.id ?? null;
  });

  const snapshotFor = Effect.fn("RevdocService.snapshotFor")(function* (resolved: ResolvedTarget) {
    const review = Option.getOrNull(yield* store.getReview(resolved.key));
    const items = review ? yield* store.listItems(review.id) : [];
    const passes = yield* store.listPasses(resolved.key);
    const now = yield* Clock.currentTimeMillis;
    const active = passes.find((pass) => pass.status === "running") ?? null;
    const latest = (["generate", "test"] as const).flatMap((kind) => {
      const pass = passes.find(
        (candidate) => candidate.kind === kind && candidate.status !== "running",
      );
      return pass ? [passDto(pass, now)] : [];
    });
    return {
      worktreePath: resolved.key.worktreePath,
      review: review ? reviewHeader(review) : null,
      items: items.map(itemSummary),
      activePass: active ? passDto(active, now) : null,
      latestPasses: latest,
      testParentThreadId: yield* testParentFor(resolved),
    } satisfies RevdocSnapshot;
  });

  const activePassFor = (key: ReviewKey) =>
    store
      .listPasses(key)
      .pipe(Effect.map((passes) => passes.find((pass) => pass.status === "running") ?? null));

  /** Keeps the active pass, the latest finished pass of each kind, and the latest resumable generation. */
  const prunePasses = (key: ReviewKey) =>
    Effect.gen(function* () {
      const passes = yield* store.listPasses(key);
      const keep = new Set<string>();
      for (const kind of ["generate", "test"] as const) {
        const latest = passes.find((pass) => pass.kind === kind && pass.status !== "running");
        if (latest) keep.add(latest.id);
      }
      const resumable = passes.find(
        (pass) =>
          pass.kind === "generate" &&
          pass.status !== "running" &&
          pass.status !== "completed" &&
          pass.data.checkpoint,
      );
      if (resumable) keep.add(resumable.id);
      yield* store.deletePasses(
        passes
          .filter((pass) => pass.status !== "running" && !keep.has(pass.id))
          .map((pass) => pass.id),
      );
    });

  const finishPass = (
    pass: PassRecord,
    status: Exclude<PassRecord["status"], "running">,
    patch: Partial<PassData> = {},
  ) =>
    Effect.gen(function* () {
      const finished: PassRecord = {
        ...pass,
        status,
        finishedAt: yield* revdocNow,
        data: { ...pass.data, ...patch },
      };
      yield* store.putPass(finished);
      progress.delete(pass.id);
      if (pass.childThreadId) children.delete(pass.childThreadId);
      yield* prunePasses(pass);
      yield* exportReview(pass);
      yield* publishPass(finished);
      return finished;
    });

  const startPass = (pass: PassRecord) =>
    Effect.gen(function* () {
      const running = yield* store.startPass(pass);
      if (Option.isSome(running)) {
        return yield* new RevdocError({
          code: "busy",
          message: `A Revdoc ${running.value.kind === "generate" ? "generation" : "test"} pass is already running.`,
          passId: running.value.id,
        });
      }
      yield* exportReview(pass);
      yield* publishPass(pass);
    });

  const generationModel = (
    configured: Array<ModelSelection | null>,
    thread: OrchestrationV2ThreadShell,
  ) =>
    configured.find((selection): selection is ModelSelection => selection !== null) ??
    thread.modelSelection;

  const callModel = (cwd: string, prompt: string, selection: ModelSelection) =>
    (textGeneration.generateStructured
      ? textGeneration.generateStructured({
          cwd,
          prompt,
          outputSchema: GenerationOutput,
          modelSelection: selection,
        })
      : Effect.fail(null)
    ).pipe(
      Effect.map(toUpsert),
      Effect.mapError(
        (cause) =>
          new RevdocError({
            code: "provider_unavailable",
            message: `Revdoc generation failed${cause?.detail ? `: ${cause.detail}` : "."} Choose another Revdoc model in Settings if this keeps happening.`,
          }),
      ),
    );

  /** Commits a proposal against the revision the pass last committed; a mismatch is a conflict. */
  const commitProposal = (
    pass: PassRecord,
    cwd: string,
    proposal: Upsert,
    mode: "full" | "partial",
  ) =>
    Effect.gen(function* () {
      const hashes = yield* provideRuntime(
        readContentHashes(
          cwd,
          proposal.items.flatMap((item) => normaliseCoveredPaths(item.coveredPaths)),
        ),
      );
      const now = yield* revdocNow;
      let assignedIds: ReadonlyArray<string | null> = [];
      let report = emptyReport;
      const committed = yield* store.commit(pass, pass.data.lastCommittedRevision, (review) =>
        Effect.gen(function* () {
          const current = review ? yield* store.listItems(review.id) : [];
          const taken = new Set(current.map((item) => item.id));
          const output = reconcile({
            current,
            proposal: proposal.items,
            mode,
            passId: pass.id,
            contentHashes: hashes,
            newId: () => {
              let id = newRevdocId("chk");
              while (taken.has(id)) id = newRevdocId("chk");
              taken.add(id);
              return id;
            },
          });
          assignedIds = output.assignedIds;
          report = { ...emptyReport, ...output.report };
          return {
            header: {
              title: proposal.title,
              summary: proposal.summary,
              context: proposal.context,
              partial: mode === "partial",
              ...(mode === "full" ? { generatedAt: now } : {}),
            },
            items: output.changed,
          };
        }),
      );
      const revision = Option.match(committed, {
        onNone: () => pass.data.lastCommittedRevision,
        onSome: (c) => c.review.revision,
      });
      if (Option.isSome(committed)) yield* publishCommit(pass, committed.value);
      return { revision, assignedIds, report };
    });

  const saveCheckpoint = (pass: PassRecord, data: Partial<PassData>) =>
    Effect.gen(function* () {
      const next = { ...pass, data: { ...pass.data, ...data } };
      yield* store.putPass(next);
      return next;
    });

  const runGeneration = Effect.fn("RevdocService.runGeneration")(function* (
    initial: PassRecord,
    resolved: ResolvedTarget,
    resume: Checkpoint | null,
  ) {
    let pass = initial;
    const cwd = resolved.key.worktreePath;
    const config = yield* settings.getSettings.pipe(
      Effect.mapError(() => fail("storage", "Revdoc could not read settings.")),
    );
    const changes = yield* provideRuntime(gatherWorktreeChanges(cwd));
    const records = yield* threads
      .getThreadRecords(resolved.thread.id, ["messages"])
      .pipe(Effect.mapError(() => fail("storage", "Revdoc could not read the conversation.")));
    const conversation = conversationExcerpt(records.messages);
    const conversationDigest = sha256(jsonText(conversation));
    const review = Option.getOrNull(yield* store.getReview(resolved.key));
    const items = review ? yield* store.listItems(review.id) : [];
    const plan = planBatches({
      conversation,
      overview: changes.overview,
      changes: changes.changes,
      items: compactItems(items),
    });
    const batched = plan.length > 1;
    const selection = generationModel(
      batched
        ? [config.revdocLargeModelSelection, config.revdocModelSelection]
        : [config.revdocModelSelection],
      resolved.thread,
    );
    const batchDigests = plan.map((batch) => batch.digest);
    const reused =
      resume !== null &&
      resume.sourceDigest === changes.sourceDigest &&
      resume.conversationDigest === conversationDigest &&
      resume.batchDigests.join() === batchDigests.join();
    let checkpoint: Checkpoint = reused
      ? resume
      : {
          sourceDigest: changes.sourceDigest,
          conversationDigest,
          batchDigests,
          batches: plan.map(() => null),
          combined: [],
        };
    pass = yield* saveCheckpoint(pass, { model: modelLabel(selection), checkpoint });
    const directory = yield* fs
      .makeTempDirectoryScoped({ prefix: "satellite-revdoc-" })
      .pipe(Effect.mapError(() => fail("storage", "Revdoc could not create a working directory.")));

    const state: GenerationProgress = {
      stage: "reviewing",
      completed: checkpoint.batches.filter((batch) => batch !== null).length,
      total: plan.length,
      running: new Map(),
    };
    progress.set(pass.id, state);
    yield* publishPass(pass);
    const tracked = <A, E, R>(index: number, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        state.running.set(index + 1, yield* Clock.currentTimeMillis);
        yield* publishPass(pass);
        return yield* effect;
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            state.running.delete(index + 1);
            return Effect.void;
          }),
        ),
      );

    if (!batched) {
      const upsert = yield* tracked(0, callModel(directory, plan[0]!.prompt, selection));
      state.completed = 1;
      const result = yield* commitProposal(pass, cwd, upsert, "full");
      return { pass, report: result.report };
    }

    let accumulated = checkpoint.batches.reduce<Upsert | null>(
      (merged, batch) => (batch ? mergeUpserts(merged, batch) : merged),
      null,
    );
    const commitLock = Semaphore.makeUnsafe(1);
    yield* Effect.forEach(
      plan.flatMap((batch, index) => (checkpoint.batches[index] ? [] : [{ batch, index }])),
      ({ batch, index }) =>
        tracked(index, callModel(directory, batch.prompt, selection)).pipe(
          Effect.flatMap((upsert) =>
            Semaphore.withPermit(
              commitLock,
              Effect.gen(function* () {
                const merged = mergeUpserts(accumulated, upsert);
                const partial = yield* commitProposal(pass, cwd, merged, "partial");
                // Server ids for new checks go back into the saved results, so a resumed pass
                // matches the items its partial commits created.
                const withIds = merged.items.map((item, position) => ({
                  ...item,
                  id: partial.assignedIds[position] ?? item.id,
                }));
                accumulated = { ...merged, items: withIds };
                const idFor = new Map(withIds.map((item) => [checkKey(item), item.id]));
                checkpoint = {
                  ...checkpoint,
                  batches: checkpoint.batches.map((saved, at) =>
                    at === index
                      ? {
                          ...upsert,
                          items: upsert.items.map((item) => ({
                            ...item,
                            id: item.id ?? idFor.get(checkKey(item)) ?? null,
                          })),
                        }
                      : saved,
                  ),
                };
                pass = yield* saveCheckpoint(pass, {
                  checkpoint,
                  lastCommittedRevision: partial.revision,
                });
                state.completed++;
                yield* publishPass(pass);
              }),
            ),
          ),
        ),
      { concurrency: BATCH_CONCURRENCY, discard: true },
    );

    const merged = accumulated ?? { title: "Review", summary: "", context: "", items: [] };
    const groups = combineGroups(merged);
    const combined =
      checkpoint.combined.length === groups.length
        ? [...checkpoint.combined]
        : groups.map(() => null);
    state.stage = "combining";
    state.completed = combined.filter((group) => group !== null).length;
    state.total = groups.length;
    yield* publishPass(pass);
    yield* Effect.forEach(
      groups.flatMap((group, index) => (combined[index] ? [] : [{ group, index }])),
      ({ group, index }) =>
        tracked(
          index,
          callModel(directory, combinePrompt(group, changes.overview), selection),
        ).pipe(
          Effect.flatMap((result) =>
            Semaphore.withPermit(
              commitLock,
              Effect.gen(function* () {
                combined[index] = result;
                checkpoint = { ...checkpoint, combined };
                pass = yield* saveCheckpoint(pass, { checkpoint });
                state.completed++;
                yield* publishPass(pass);
              }),
            ),
          ),
        ),
      { concurrency: BATCH_CONCURRENCY, discard: true },
    );
    const final = applyCombined(
      merged,
      groups,
      combined.map((group) => group ?? { title: "", summary: "", context: "", items: [] }),
    );
    const result = yield* commitProposal(pass, cwd, final, "full");
    return { pass, report: result.report };
  });

  const generate = Effect.fn("RevdocService.generate")(function* (
    input: RevdocGenerateInput,
    agent?: AgentCaller,
  ) {
    const resolved = yield* resolveTarget(input);
    yield* guardRecursion(agent?.threadId ?? resolved.thread.id);
    const config = yield* settings.getSettings.pipe(
      Effect.mapError(() => fail("storage", "Revdoc could not read settings.")),
    );
    const previous = (yield* store.listPasses(resolved.key)).find(
      (pass) => pass.kind === "generate" && pass.status !== "completed" && pass.data.checkpoint,
    );
    const starting: PassRecord = {
      ...resolved.key,
      id: newRevdocId("pass"),
      kind: "generate",
      status: "running",
      childThreadId: null,
      startedAt: yield* revdocNow,
      finishedAt: null,
      data: {
        requestedByThreadId: agent?.threadId ?? resolved.thread.id,
        baseRevision: 0,
        lastCommittedRevision: 0,
        model: null,
        error: null,
        report: null,
        action: input.action ?? config.revdocDefaultAction,
        origin: agent ? "agent" : "ui",
      },
    };
    yield* startPass(starting);
    // Refresh stops committing once a generation pass is running, so the base read here holds.
    const revision = yield* currentRevision(resolved.key);
    const pass = {
      ...starting,
      data: { ...starting.data, baseRevision: revision, lastCommittedRevision: revision },
    };
    yield* store.putPass(pass);
    const fiber = yield* runGeneration(pass, resolved, previous?.data.checkpoint ?? null).pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          generationFibers.delete(pass.id);
          const latest = Option.getOrElse(
            yield* store.getPass(pass.id).pipe(Effect.orElseSucceed(() => Option.none())),
            () => pass,
          );
          if (latest.status !== "running") return;
          if (Exit.isSuccess(exit)) {
            yield* finishPass(latest, "completed", { report: exit.value.report });
            if (latest.data.action === "generate-and-test") {
              yield* test({
                threadId: resolved.thread.id,
                ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
                selection: "remaining",
              }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Revdoc could not start testing after generating", { error }),
                ),
              );
            }
            return;
          }
          if (Cause.hasInterrupts(exit.cause)) {
            yield* finishPass(latest, "cancelled");
            return;
          }
          const revdocError = Option.getOrNull(Cause.findErrorOption(exit.cause));
          yield* finishPass(latest, revdocError?.code === "conflict" ? "conflicted" : "failed", {
            error: revdocError?.message ?? "Revdoc generation failed unexpectedly.",
          });
        }).pipe(Effect.ignore),
      ),
      Effect.forkIn(scope),
    );
    generationFibers.set(pass.id, fiber);
    return { passId: pass.id };
  });

  const closeTabs = (threadId: ThreadId) => previews.close({ threadId }).pipe(Effect.ignore);

  /** Blocks the section's checks the agent finished without recording. */
  const blockUnrecorded = (pass: PassRecord, itemIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const recorded = new Set(pass.data.recordedIds ?? []);
      const missing = itemIds.filter((id) => !recorded.has(id));
      if (missing.length === 0) return;
      const now = yield* revdocNow;
      const committed = yield* store.commit(pass, null, (review) =>
        Effect.gen(function* () {
          if (!review) return null;
          const items = (yield* store.getItems(review.id, missing)).filter(
            (item) => !item.dismissed,
          );
          if (items.length === 0) return null;
          return {
            items: items.map((item) => ({
              ...item,
              revision: item.revision + 1,
              result: {
                passId: pass.id,
                state: "blocked" as const,
                method: "command" as const,
                steps: "",
                observed: UNRECORDED_IN_SECTION,
                model: pass.data.model ?? "",
                recordedAt: now,
                evidence: pass.data.evidence?.[item.id] ?? [],
                basis: { check: item.checkFingerprint, code: item.codeFingerprint },
              },
            })),
          };
        }),
      );
      if (Option.isSome(committed)) yield* publishCommit(pass, committed.value);
    });

  const testPrompt = (pass: PassRecord, items: ReadonlyArray<ItemState>, index: number) => {
    const section = pass.data.sections![index]!;
    const byId = new Map(items.map((item) => [item.id, item]));
    return sectionPrompt({
      passId: pass.id,
      section: index + 1,
      sections: pass.data.sections!.length,
      area: section.area,
      items: section.itemIds.flatMap((id) => byId.get(id) ?? []),
    });
  };

  const itemsOf = (key: ReviewKey) =>
    Effect.flatMap(store.getReview(key), (review) =>
      Option.isNone(review)
        ? Effect.succeed([] as ReadonlyArray<ItemState>)
        : store.listItems(review.value.id),
    );

  const dispatchTesting = Effect.fn("RevdocService.dispatchTesting")(function* (
    initial: PassRecord,
    parent: OrchestrationV2ThreadShell,
    selection: ModelSelection,
    agent: AgentCaller | undefined,
  ) {
    const items = yield* itemsOf(initial);
    const parentRun = yield* provideRuntime(
      ensureParentRun({
        passId: initial.id,
        projectId: initial.projectId,
        parentThreadId: parent.id,
        checks: Object.keys(initial.data.selection ?? {}).length,
        allowKickoff: agent === undefined,
      }),
    );
    const started = yield* provideRuntime(
      delegateTesting({
        passId: initial.id,
        parentThreadId: parent.id,
        parent: parentRun,
        prompt: testPrompt(initial, items, 0),
        modelSelection: selection,
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        wakeParent: agent !== undefined,
      }),
    );
    const pass: PassRecord = {
      ...initial,
      childThreadId: started.childThreadId,
      data: { ...initial.data, currentRunId: started.childRunId, currentTaskId: started.taskId },
    };
    children.set(started.childThreadId, pass.id);
    yield* store.addTestingThread(initial, started.childThreadId);
    yield* store.putPass(pass);
    if (agent === undefined) {
      yield* provideRuntime(
        disposeCompletionDelivery({
          passId: pass.id,
          parentThreadId: parent.id,
          taskId: started.taskId,
        }),
      );
    }
    yield* publishPass(pass);
  });

  const test = Effect.fn("RevdocService.test")(function* (
    input: RevdocTestInput,
    agent?: AgentCaller,
  ) {
    const resolved = yield* resolveTarget(input);
    yield* guardRecursion(agent?.threadId ?? resolved.thread.id);
    const review = Option.getOrNull(yield* store.getReview(resolved.key));
    if (!review) return yield* fail("not_found", "Generate a review before testing it.");
    const items = yield* store.listItems(review.id);
    const selected = selectItems(items, input.selection, input.itemIds);
    if (selected.length === 0)
      return yield* fail("invalid_request", "No checks match this selection.");
    const parentId = agent?.threadId ?? (yield* testParentFor(resolved));
    if (parentId === null)
      return yield* fail("invalid_request", "Start a thread in this worktree to test it.");
    const parent = yield* resolveThread(parentId);
    const config = yield* settings.getSettings.pipe(
      Effect.mapError(() => fail("storage", "Revdoc could not read settings.")),
    );
    const selection = generationModel(
      [config.revdocTestingModelSelection, config.revdocModelSelection],
      parent,
    );
    const id = newRevdocId("pass");
    const pass: PassRecord = {
      ...resolved.key,
      id,
      kind: "test",
      status: "running",
      childThreadId: null,
      startedAt: yield* revdocNow,
      finishedAt: null,
      data: {
        requestedByThreadId: agent?.threadId ?? resolved.thread.id,
        baseRevision: review.revision,
        lastCommittedRevision: review.revision,
        model: modelLabel(selection),
        error: null,
        report: null,
        origin: agent ? "agent" : "ui",
        parentThreadId: parent.id,
        selection: Object.fromEntries(selected.map((item) => [item.id, item.checkFingerprint])),
        sections: planSections(id, selected),
        sectionIndex: 0,
        recordedIds: [],
      },
    };
    yield* startPass(pass);
    const dispatch = dispatchTesting(pass, parent, selection, agent).pipe(
      Effect.tapError((error) =>
        finishPass(pass, "failed", { error: error.message }).pipe(Effect.ignore),
      ),
    );
    if (agent) {
      yield* dispatch;
    } else {
      yield* dispatch.pipe(Effect.ignore, Effect.forkIn(scope));
    }
    return { passId: id };
  });

  /**
   * A section ends when its delegated task row settles. Upstream records the task's result on the
   * row, and a follow-up only becomes a new row once that result exists, so the row is the signal.
   * A section without a row (upstream declined to record one) ends with its run instead.
   */
  const endSection = (
    pass: PassRecord,
    childThreadId: ThreadId,
    outcome: "completed" | "failed" | "stopped",
  ) =>
    Effect.gen(function* () {
      yield* closeTabs(childThreadId);
      const sections = pass.data.sections ?? [];
      const index = pass.data.sectionIndex ?? 0;
      if (outcome !== "completed") {
        yield* finishPass(pass, outcome === "failed" ? "failed" : "cancelled", {
          ...(outcome === "failed" ? { error: "The testing agent's turn failed." } : {}),
          report: { ...emptyReport, notReached: notReached(pass) },
        });
        return;
      }
      yield* blockUnrecorded(pass, sections[index]?.itemIds ?? []);
      const latest = Option.getOrElse(yield* store.getPass(pass.id), () => pass);
      if (index + 1 >= sections.length) {
        yield* finishPass(latest, "completed", { report: emptyReport });
        return;
      }
      const items = yield* itemsOf(pass);
      const next = { ...latest, data: { ...latest.data, sectionIndex: index + 1 } };
      const sent = yield* provideRuntime(
        sendSection({
          passId: pass.id,
          section: index + 2,
          projectId: pass.projectId,
          parentThreadId: pass.data.parentThreadId!,
          childThreadId,
          prompt: testPrompt(next, items, index + 1),
        }),
      );
      const { currentTaskId: _previous, ...data } = next.data;
      const advanced: PassRecord = {
        ...next,
        data: {
          ...data,
          currentRunId: sent.childRunId,
          ...(sent.taskId ? { currentTaskId: sent.taskId } : {}),
        },
      };
      yield* store.putPass(advanced);
      if (pass.data.origin === "ui" && sent.taskId) {
        yield* provideRuntime(
          disposeCompletionDelivery({
            passId: pass.id,
            parentThreadId: pass.data.parentThreadId!,
            taskId: sent.taskId,
          }),
        );
      }
      yield* publishPass(advanced);
    });

  const endedAs = (status: string) =>
    status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped";

  /** How the current section's task or run ended while the server was down, if it did. */
  const sectionEndedWhileDown = (pass: PassRecord, childThreadId: ThreadId) =>
    Effect.gen(function* () {
      if (pass.data.currentTaskId !== undefined && pass.data.parentThreadId !== undefined) {
        const parent = yield* threads
          .getThreadRecords(pass.data.parentThreadId, ["subagents"])
          .pipe(Effect.option);
        const task = Option.getOrNull(parent)?.subagents.find(
          (candidate) => candidate.id === pass.data.currentTaskId,
        );
        if (!task) return "lost" as const;
        return TASK_ENDED.has(task.status) ? endedAs(task.status) : null;
      }
      const records = yield* threads.getThreadRecords(childThreadId, ["runs"]).pipe(Effect.option);
      const run = Option.getOrNull(records)?.runs.find(
        (candidate) => candidate.id === pass.data.currentRunId,
      );
      if (!run) return "lost" as const;
      return isTerminalRun(run) ? endedAs(run.status) : null;
    });

  const runningPassOf = (childThreadId: ThreadId) =>
    Effect.gen(function* () {
      const passId = children.get(childThreadId);
      if (passId === undefined) return null;
      const pass = Option.getOrNull(yield* store.getPass(passId));
      return pass?.status === "running" ? pass : null;
    });

  const onOrchestrationEvent = (event: OrchestrationV2DomainEvent) =>
    Effect.gen(function* () {
      if (event.type === "subagent.updated") {
        const task = event.payload;
        if (task.childThreadId === null || !TASK_ENDED.has(task.status)) return;
        const pass = yield* runningPassOf(task.childThreadId);
        if (!pass || pass.data.currentTaskId !== task.id) return;
        yield* endSection(pass, task.childThreadId, endedAs(task.status));
        return;
      }
      if (event.type !== "run.updated" || !isTerminalRun(event.payload)) return;
      const run = event.payload;
      const pass = yield* runningPassOf(run.threadId);
      if (!pass || pass.data.currentTaskId !== undefined || pass.data.currentRunId !== run.id)
        return;
      yield* endSection(pass, run.threadId, endedAs(run.status));
    }).pipe(
      Semaphore.withPermit(runLock),
      Effect.catch((error) =>
        Effect.logWarning("Revdoc could not advance a testing pass", { error }),
      ),
    );

  const notReached = (pass: PassRecord) => {
    const recorded = new Set(pass.data.recordedIds ?? []);
    return Object.keys(pass.data.selection ?? {}).filter((id) => !recorded.has(id)).length;
  };

  const testingPassFor = (passId: string, callerThreadId: ThreadId, itemId: string) =>
    Effect.gen(function* () {
      const pass = Option.getOrNull(yield* store.getPass(passId));
      if (!pass || pass.kind !== "test" || pass.status !== "running") {
        return yield* fail("not_allowed", "This testing pass is no longer running.");
      }
      if (pass.childThreadId !== callerThreadId) {
        return yield* fail("not_allowed", "Only the pass's testing agent can record its results.");
      }
      if (!(itemId in (pass.data.selection ?? {}))) {
        return yield* fail("not_allowed", "This check is not part of the testing pass.");
      }
      return pass;
    });

  const recordResult = Effect.fn("RevdocService.recordResult")(function* (
    input: RevdocRecordResultInput,
    callerThreadId: ThreadId,
  ) {
    const pass = yield* testingPassFor(input.passId, callerThreadId, input.itemId);
    const evidence = pass.data.evidence?.[input.itemId] ?? [];
    if (input.method === "browser" && input.state === "passed" && evidence.length === 0) {
      return yield* fail(
        "invalid_request",
        "A browser pass needs captured evidence. Call revdoc_capture_evidence first.",
      );
    }
    const review = Option.getOrNull(yield* store.getReview(pass));
    const [current] = review ? yield* store.getItems(review.id, [input.itemId]) : [];
    if (!current || current.dismissed)
      return yield* fail("not_found", "This check no longer exists.");
    const hashes = yield* provideRuntime(
      readContentHashes(pass.worktreePath, current.coveredPaths),
    );
    const now = yield* revdocNow;
    let summary: RevdocItemSummary | null = null;
    const committed = yield* store.commit(pass, null, (reviewNow) =>
      Effect.gen(function* () {
        const [item] = reviewNow ? yield* store.getItems(reviewNow.id, [input.itemId]) : [];
        if (!item || item.dismissed)
          return yield* fail("not_found", "This check no longer exists.");
        const next: ItemState = {
          ...item,
          revision: item.revision + 1,
          result: {
            passId: pass.id,
            state: input.state,
            method: input.method,
            steps: input.steps,
            observed: input.observed,
            model: pass.data.model ?? "",
            recordedAt: now,
            evidence,
            basis: {
              check: item.checkFingerprint,
              code: codeFingerprint(item.coveredPaths, hashes),
            },
          },
        };
        summary = itemSummary(next);
        return { items: [next] };
      }),
    );
    const recordedIds = [...new Set([...(pass.data.recordedIds ?? []), input.itemId])];
    const updated = { ...pass, data: { ...pass.data, recordedIds } };
    yield* store.putPass(updated);
    if (Option.isSome(committed)) yield* publishCommit(pass, committed.value);
    yield* publishPass(updated);
    return summary!;
  });

  const captureEvidence = Effect.fn("RevdocService.captureEvidence")(function* (
    input: RevdocCaptureEvidenceInput,
    scope: McpInvocationContext.McpThreadInvocationScope,
  ) {
    const pass = yield* testingPassFor(input.passId, scope.thread.threadId, input.itemId);
    const existing = pass.data.evidence?.[input.itemId] ?? [];
    if (existing.length >= MAX_EVIDENCE_PER_ITEM) {
      return yield* fail(
        "invalid_request",
        `At most ${MAX_EVIDENCE_PER_ITEM} screenshots per check.`,
      );
    }
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const snapshot = yield* broker
      .invoke<PreviewAutomationSnapshot>({
        scope,
        operation: "snapshot",
        input: {},
        ...(input.tabId ? { tabId: input.tabId } : {}),
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "PreviewAutomationNoAvailableHostError"
            ? fail("no_browser_host", "No browser host is available. Record this check as blocked.")
            : error._tag === "PreviewAutomationUnavailableError"
              ? fail(
                  "browser_access_off",
                  "Agent browser access is off. Record this check as blocked.",
                )
              : fail("invalid_request", "The browser could not capture a screenshot."),
        ),
      );
    const png = Buffer.from(snapshot.screenshot?.data ?? "", "base64");
    if (
      png.length === 0 ||
      png.length > MAX_EVIDENCE_BYTES ||
      PNG_SIGNATURE.some((byte, index) => png[index] !== byte)
    ) {
      return yield* fail("invalid_request", "The screenshot was not a PNG under 10 MB.");
    }
    const id = newRevdocId("ev");
    const relative = `.revdoc/evidence/${id}.png`;
    yield* fs
      .makeDirectory(path.join(pass.worktreePath, ".revdoc/evidence"), { recursive: true })
      .pipe(
        Effect.andThen(fs.writeFile(path.join(pass.worktreePath, relative), png)),
        Effect.mapError(() => fail("storage", "Revdoc could not save the screenshot.")),
      );
    const evidence: RevdocEvidence = {
      id,
      caption: input.caption,
      capturedAt: yield* revdocNow,
      path: relative,
    };
    yield* store.putPass({
      ...pass,
      data: {
        ...pass.data,
        evidence: { ...pass.data.evidence, [input.itemId]: [...existing, evidence] },
      },
    });
    return evidence;
  });

  const subscribe = (target: RevdocTarget) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const resolved = yield* resolveTarget(target);
        const key = keyString(resolved.key);
        const subscription = yield* PubSub.subscribe(events);
        const snapshot = yield* snapshotFor(resolved);
        yield* refreshIfStale(resolved.key).pipe(Effect.ignore, Effect.forkIn(scope));
        return Stream.succeed<RevdocEvent>({ _tag: "snapshot", snapshot }).pipe(
          Stream.concat(
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((entry) => entry.key === key),
              Stream.map((entry) => entry.event),
            ),
          ),
        );
      }),
    );

  const refreshNow = Effect.fn("RevdocService.refreshNow")(function* (
    key: ReviewKey,
    stamp: string | null,
  ) {
    const review = Option.getOrNull(yield* store.getReview(key));
    if (!review) return;
    const active = yield* activePassFor(key);
    if (active?.kind === "generate") return;
    const items = yield* store.listItems(review.id);
    const hashes = yield* provideRuntime(
      readContentHashes(
        key.worktreePath,
        items.flatMap((item) => item.coveredPaths),
      ),
    );
    const seen = new Set(items.map((item) => item.id));
    const now = yield* revdocNow;
    const committed = yield* store.commit(key, null, (current) =>
      Effect.gen(function* () {
        if (!current || (yield* activePassFor(key))?.kind === "generate") return null;
        const changed = (yield* store.listItems(current.id)).flatMap((item) => {
          // An item that appeared since the hashes were read is left for the next refresh.
          if (!seen.has(item.id)) return [];
          const code = codeFingerprint(item.coveredPaths, hashes);
          return code === item.codeFingerprint
            ? []
            : [{ ...item, codeFingerprint: code, revision: item.revision + 1 }];
        });
        if (changed.length === 0) return null;
        return { header: { refreshedAt: now, worktreeStamp: stamp }, items: changed };
      }),
    );
    if (Option.isSome(committed)) {
      yield* publishCommit(key, committed.value);
    } else if (stamp !== null) {
      yield* store.setWorktreeStamp(review.id, stamp, now);
    }
  });

  const refreshIfStale = (key: ReviewKey) =>
    Effect.gen(function* () {
      const review = Option.getOrNull(yield* store.getReview(key));
      if (!review) return;
      const stamp = yield* provideRuntime(worktreeStamp(key.worktreePath));
      if (stamp !== review.worktreeStamp) yield* refreshNow(key, stamp);
    });

  const editItem = Effect.fn("RevdocService.editItem")(function* (input: RevdocEditItemInput) {
    const resolved = yield* resolveTarget(input);
    const review = Option.getOrNull(yield* store.getReview(resolved.key));
    const [before] = review ? yield* store.getItems(review.id, [input.itemId]) : [];
    if (!before) return yield* fail("not_found", "This check no longer exists.");
    const hashes =
      input.change._tag === "set_outcome"
        ? yield* provideRuntime(readContentHashes(resolved.key.worktreePath, before.coveredPaths))
        : new Map<string, string>();
    let summary: RevdocItemSummary | null = null;
    const committed = yield* store.commit(resolved.key, null, (current) =>
      Effect.gen(function* () {
        const [item] = current ? yield* store.getItems(current.id, [input.itemId]) : [];
        if (!item) return yield* fail("not_found", "This check no longer exists.");
        if (item.revision !== input.expectedRevision) {
          return yield* new RevdocError({
            code: "conflict",
            message: "Another device changed this check first.",
            currentItem: itemDetail(item),
          });
        }
        const change = input.change;
        const next: ItemState = { ...item, revision: item.revision + 1 };
        let edited: ItemState;
        switch (change._tag) {
          case "set_outcome":
            edited = {
              ...next,
              outcome: change.outcome,
              outcomeBasis:
                change.outcome === "not_checked"
                  ? null
                  : {
                      check: item.checkFingerprint,
                      code: codeFingerprint(item.coveredPaths, hashes),
                    },
            };
            break;
          case "set_note":
            edited = { ...next, note: change.note };
            break;
          case "dismiss":
            if (item.stalePassId === null) {
              return yield* fail("invalid_request", "Only stale checks can be dismissed.");
            }
            edited = { ...next, dismissed: true };
            break;
          case "restore":
            edited = { ...next, dismissed: false };
            break;
        }
        summary = itemSummary(edited);
        return { items: [edited] };
      }),
    );
    if (Option.isSome(committed)) yield* publishCommit(resolved.key, committed.value);
    return summary!;
  });

  const deleteReview = Effect.fn("RevdocService.deleteReview")(function* (
    input: RevdocDeleteInput,
  ) {
    const resolved = yield* resolveTarget(input);
    const active = yield* activePassFor(resolved.key);
    if (active) {
      return yield* new RevdocError({
        code: "busy",
        message: "Stop the running pass before deleting the review.",
        passId: active.id,
      });
    }
    yield* store.transaction(
      Effect.gen(function* () {
        const revision = yield* currentRevision(resolved.key);
        if (revision === 0) return yield* fail("not_found", "There is no review to delete.");
        if (revision !== input.expectedRevision) {
          return yield* new RevdocError({
            code: "conflict",
            message: "The review changed. Check it before deleting.",
            currentRevision: revision,
          });
        }
        yield* store.deleteReview(resolved.key);
      }),
    );
    yield* exporter.remove(resolved.key.worktreePath);
    yield* publish(resolved.key, { _tag: "deleted", revision: 0 });
  });

  const cancelPass = (pass: PassRecord) =>
    Effect.gen(function* () {
      if (pass.kind === "generate") {
        const fiber = generationFibers.get(pass.id);
        if (fiber) {
          yield* Fiber.interrupt(fiber);
          return;
        }
        yield* finishPass(pass, "cancelled");
        return;
      }
      yield* finishPass(pass, "cancelled", {
        report: { ...emptyReport, notReached: notReached(pass) },
      });
      if (pass.childThreadId) {
        yield* provideRuntime(stopChild(pass.id, pass.childThreadId));
        yield* closeTabs(pass.childThreadId);
      }
    });

  const cancel = Effect.fn("RevdocService.cancel")(function* (target: RevdocTarget) {
    const resolved = yield* resolveTarget(target);
    const active = yield* activePassFor(resolved.key);
    if (!active) return yield* fail("not_found", "No Revdoc pass is running.");
    yield* cancelPass(active);
  });

  const forgetKey = (key: ReviewKey) =>
    Effect.gen(function* () {
      const active = yield* activePassFor(key);
      if (active) yield* cancelPass(active);
      yield* store.deleteReview(key);
      yield* store.forgetTestingThreads(key);
      yield* exporter.remove(key.worktreePath);
      yield* publish(key, { _tag: "deleted", revision: 0 });
    }).pipe(
      Effect.catch((error) => Effect.logWarning("Revdoc could not forget a worktree", { error })),
    );

  const keysWhere = (predicate: (key: ReviewKey) => boolean) =>
    Effect.gen(function* () {
      const reviews = yield* store.listReviews();
      const running = yield* store.runningPasses;
      const keys = new Map<string, ReviewKey>();
      for (const key of [...reviews, ...running]) {
        if (predicate(key))
          keys.set(keyString(key), { projectId: key.projectId, worktreePath: key.worktreePath });
      }
      return [...keys.values()];
    });

  /** Reviews are keyed by real path; a removed worktree resolves through its parent folder. */
  const realPathOf = (worktreePath: string) =>
    fs.realPath(worktreePath).pipe(
      Effect.catch(() =>
        fs
          .realPath(path.dirname(worktreePath))
          .pipe(Effect.map((parent) => path.join(parent, path.basename(worktreePath)))),
      ),
      Effect.orElseSucceed(() => worktreePath),
    );

  const forgetWorktree = (worktreePath: string) =>
    Effect.gen(function* () {
      const paths = new Set([worktreePath, yield* realPathOf(worktreePath)]);
      const keys = yield* keysWhere((key) => paths.has(key.worktreePath));
      yield* Effect.forEach(keys, forgetKey, { discard: true });
    }).pipe(Effect.ignore);

  const recover = Effect.gen(function* () {
    const reviews = yield* store.listReviews();
    for (const review of reviews) {
      if (!(yield* fs.exists(review.worktreePath).pipe(Effect.orElseSucceed(() => true)))) {
        yield* forgetKey(review);
      }
    }
    for (const pass of yield* store.runningPasses) {
      if (pass.kind === "generate") {
        if (!generationFibers.has(pass.id)) yield* finishPass(pass, "interrupted");
        continue;
      }
      if (!pass.childThreadId) {
        yield* finishPass(pass, "interrupted", {
          error: "The server restarted before testing started.",
        });
        continue;
      }
      children.set(pass.childThreadId, pass.id);
      const ended = yield* sectionEndedWhileDown(pass, pass.childThreadId);
      if (ended === "lost") yield* finishPass(pass, "interrupted");
      else if (ended !== null) {
        yield* endSection(pass, pass.childThreadId, ended).pipe(Semaphore.withPermit(runLock));
      }
    }
  }).pipe(Effect.catch((error) => Effect.logWarning("Revdoc recovery failed", { error })));

  return RevdocService.of({
    worktrees: (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.threadId);
        const defaultPath = yield* threadRoot(thread);
        return { defaultPath, worktrees: yield* provideRuntime(listWorktrees(defaultPath)) };
      }),
    subscribe,
    getItems: (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveTarget(input);
        const review = Option.getOrNull(yield* store.getReview(resolved.key));
        const items = review ? yield* store.getItems(review.id, input.ids) : [];
        return { items: items.map(itemDetail) };
      }),
    read: (target, options) =>
      Effect.gen(function* () {
        const resolved = yield* resolveTarget(target);
        const review = Option.getOrNull(yield* store.getReview(resolved.key));
        const details = (review ? yield* store.listItems(review.id) : [])
          .map(itemDetail)
          .filter((item) => !item.dismissed && (!options.attentionOnly || needsAttention(item)));
        const active = yield* activePassFor(resolved.key);
        const items: RevdocItemDetail[] = [];
        let bytes = 0;
        for (const item of details) {
          bytes += jsonBytes(item);
          if (bytes > MAX_READ_BYTES) break;
          items.push(item);
        }
        return {
          review: review ? reviewHeader(review) : null,
          activePass: active ? passDto(active, yield* Clock.currentTimeMillis) : null,
          items,
          truncated: items.length < details.length,
        };
      }),
    generate,
    test,
    cancel,
    refresh: (target) =>
      Effect.gen(function* () {
        const resolved = yield* resolveTarget(target);
        const stamp = yield* provideRuntime(worktreeStamp(resolved.key.worktreePath));
        yield* refreshNow(resolved.key, stamp);
      }),
    editItem,
    deleteReview,
    recordResult,
    captureEvidence,
    forgetWorktree,
    forgetProject: (projectId) =>
      keysWhere((key) => key.projectId === projectId).pipe(
        Effect.flatMap((keys) => Effect.forEach(keys, forgetKey, { discard: true })),
        Effect.ignore,
      ),
    recover,
    onOrchestrationEvent,
  });
});

export const layer = Layer.effect(RevdocService, make).pipe(
  Layer.provide(Layer.mergeAll(RevdocExport.layer, RevdocStore.layer)),
);

/** A stand-in for tests that only build Satellite handlers; calling it fails the test. */
export const testLayer = Layer.mock(RevdocService)({});
