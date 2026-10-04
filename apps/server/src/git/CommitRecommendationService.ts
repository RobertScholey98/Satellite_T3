import {
  CommandId,
  type CommitRecommendation,
  type SetCommitRecommendationInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
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

    let recommendation: CommitRecommendation | null = null;
    if (input.level !== "none") {
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
      if (status.hasWorkingTreeChanges) {
        recommendation = {
          level: input.level,
          reason: input.reason,
          cwd,
          branch: status.branch,
          headCommit: status.headCommit,
          assessedAt: DateTime.formatIso(yield* DateTime.now),
        };
      }
    }

    const commandId = yield* crypto.randomUUIDv4.pipe(
      Effect.map(CommandId.make),
      Effect.mapError((cause) => new CommitRecommendationError({ reason: "save-failed", cause })),
    );
    yield* engine
      .dispatch({
        type: "thread.meta.update",
        commandId,
        threadId,
        commitRecommendation: recommendation,
      })
      .pipe(
        Effect.mapError((cause) => new CommitRecommendationError({ reason: "save-failed", cause })),
      );
    return recommendation;
  });

  return CommitRecommendationService.of({ set });
});

export const layer = Layer.effect(CommitRecommendationService, make);
