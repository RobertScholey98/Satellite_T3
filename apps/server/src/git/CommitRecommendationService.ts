import {
  CommandId,
  type CommitRecommendation,
  type GitCommandError,
  type SetCommitRecommendationInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "../orchestration-v2/SatelliteOrchestration.ts";
import * as ProjectionSnapshotQuery from "../orchestration-v2/SatelliteOrchestration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export class CommitRecommendationError extends Schema.TaggedError<CommitRecommendationError>()(
  "CommitRecommendationError",
  {
    reason: Schema.Literals([
      "thread-unavailable",
      "git-unavailable",
      "save-failed",
      "missing-reason",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "thread-unavailable":
        return "The thread or its project is no longer available.";
      case "git-unavailable":
        return "Could not read the thread's Git checkout.";
      case "save-failed":
        return "Could not save the commit recommendation.";
      case "missing-reason":
        return "A recommendation requires a reason.";
    }
  }
}

export class CommitRecommendationService extends Context.Service<
  CommitRecommendationService,
  {
    readonly readLocalStatus: (
      cwd: string,
    ) => Effect.Effect<GitVcsDriver.GitStatusDetails, GitCommandError | CommitRecommendationError>;
    readonly expireForStatus: (
      cwd: string,
      status: GitVcsDriver.GitStatusDetails,
    ) => Effect.Effect<void, CommitRecommendationError>;
    readonly set: (
      threadId: ThreadId,
      input: SetCommitRecommendationInput,
    ) => Effect.Effect<CommitRecommendation | null, CommitRecommendationError>;
  }
>()("t3/git/CommitRecommendationService") {}

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const crypto = yield* Crypto.Crypto;

  const fs = yield* FileSystem.FileSystem;
  const locks = new Map<string, Semaphore.Semaphore>();
  const canonicalize = (cwd: string) => fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
  const withCheckoutLock = Effect.fnUntraced(function* <A, E>(
    cwd: string,
    effect: Effect.Effect<A, E>,
  ) {
    const key = yield* canonicalize(cwd);
    let lock = locks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(key, lock);
    }
    return yield* lock.withPermits(1)(effect);
  });

  const save = Effect.fn("CommitRecommendationService.save")(
    function* (threadId: ThreadId, recommendation: CommitRecommendation | null) {
      const commandId = CommandId.make(yield* crypto.randomUUIDv4);
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId,
        threadId,
        commitRecommendation: recommendation,
      });
      return recommendation;
    },
    Effect.mapError((cause) => new CommitRecommendationError({ reason: "save-failed", cause })),
  );

  const expireUnlocked = Effect.fnUntraced(function* (
    cwd: string,
    status: GitVcsDriver.GitStatusDetails,
  ) {
    if (!status.isRepo || status.hasWorkingTreeChanges) return;
    const threads = yield* snapshots
      .listThreadsWithCommitRecommendations()
      .pipe(
        Effect.mapError((cause) => new CommitRecommendationError({ reason: "save-failed", cause })),
      );
    const checkout = yield* canonicalize(cwd);
    for (const thread of threads)
      if ((yield* canonicalize(thread.commitRecommendation.cwd)) === checkout)
        yield* save(thread.id, null);
  });
  const expireForStatus = Effect.fn("CommitRecommendationService.expireForStatus")(
    (cwd: string, status: GitVcsDriver.GitStatusDetails) =>
      withCheckoutLock(cwd, expireUnlocked(cwd, status)),
  );

  // Keep the fresh observation and its durable expiry ordered with new assessments.
  const readLocalStatus = Effect.fn("CommitRecommendationService.readLocalStatus")((cwd: string) =>
    withCheckoutLock(
      cwd,
      Effect.gen(function* () {
        const status = yield* git.statusDetailsLocal(cwd);
        yield* expireUnlocked(cwd, status);
        return status;
      }),
    ),
  );

  const set = Effect.fn("CommitRecommendationService.set")(function* (
    threadId: ThreadId,
    input: SetCommitRecommendationInput,
  ) {
    const thread = yield* snapshots
      .getThreadShellById(threadId)
      .pipe(
        Effect.mapError(
          (cause) => new CommitRecommendationError({ reason: "thread-unavailable", cause }),
        ),
      );
    if (Option.isNone(thread)) {
      return yield* new CommitRecommendationError({ reason: "thread-unavailable" });
    }

    if (input.level === "none") return yield* save(threadId, null);
    if (input.reason === undefined) {
      return yield* new CommitRecommendationError({ reason: "missing-reason" });
    }
    const project = yield* snapshots
      .getProjectShellById(thread.value.projectId)
      .pipe(
        Effect.mapError(
          (cause) => new CommitRecommendationError({ reason: "thread-unavailable", cause }),
        ),
      );
    if (Option.isNone(project)) {
      return yield* new CommitRecommendationError({ reason: "thread-unavailable" });
    }
    const cwd = thread.value.worktreePath ?? project.value.workspaceRoot;
    const { level, reason } = input;
    return yield* withCheckoutLock(
      cwd,
      Effect.gen(function* () {
        const status = yield* git
          .statusDetailsLocal(cwd)
          .pipe(
            Effect.mapError(
              (cause) => new CommitRecommendationError({ reason: "git-unavailable", cause }),
            ),
          );
        if (!status.isRepo || status.headCommit === undefined) {
          return yield* new CommitRecommendationError({ reason: "git-unavailable" });
        }
        return yield* save(
          threadId,
          status.hasWorkingTreeChanges
            ? {
                level,
                reason,
                cwd,
                branch: status.branch,
                headCommit: status.headCommit,
                assessedAt: DateTime.formatIso(yield* DateTime.now),
              }
            : null,
        );
      }),
    );
  });

  return CommitRecommendationService.of({ set, readLocalStatus, expireForStatus });
});

export const layer = Layer.effect(CommitRecommendationService, make);
