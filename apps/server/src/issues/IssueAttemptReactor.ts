import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { IssueService } from "./IssueService.ts";

/**
 * Drives attempt transitions from upstream's thread events. The live event stream starts at the
 * latest event, so a sweep at startup and every minute recovers whatever happened while the server
 * was down. A second sweep every five minutes refreshes watched or worked boards.
 */
export class IssueAttemptReactor extends Context.Service<
  IssueAttemptReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/issues/IssueAttemptReactor") {}

type Job = { readonly _tag: "thread"; readonly threadId: ThreadId } | { readonly _tag: "sweep" };

/** The thread whose attempts an event can change, if any. */
const attemptThreadOf = (event: OrchestrationV2DomainEvent): ThreadId | null => {
  switch (event.type) {
    case "run.created":
    case "run.updated":
    case "thread.pull-request-link-updated":
    case "thread.pull-request-synced":
    case "thread.deleted":
      return event.threadId;
    default:
      return null;
  }
};

const logFailure = (message: string) => (cause: Cause.Cause<unknown>) =>
  Effect.logWarning(message, { cause: Cause.pretty(cause) });

export const make = Effect.gen(function* () {
  const issues = yield* IssueService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const worker = yield* makeDrainableWorker((job: Job) =>
    (job._tag === "sweep" ? issues.sweep : issues.reconcileThread(job.threadId)).pipe(
      Effect.catchCause(logFailure("issue attempt reconcile failed")),
    ),
  );
  const start = Effect.fn("IssueAttemptReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        const threadId = attemptThreadOf(event);
        return threadId === null ? Effect.void : worker.enqueue({ _tag: "thread", threadId });
      }).pipe(Effect.catchCause(logFailure("issue attempt event stream failed"))),
    );
    yield* forkParked(
      worker
        .enqueue({ _tag: "sweep" })
        .pipe(
          Effect.andThen(worker.drain),
          Effect.repeat(Schedule.spaced("1 minute")),
          Effect.asVoid,
        ),
    );
    yield* forkParked(
      issues.refreshStaleBoards.pipe(
        Effect.catchCause(logFailure("issue board refresh sweep failed")),
        Effect.repeat(Schedule.spaced("5 minutes")),
        Effect.asVoid,
      ),
    );
  });
  return { start, drain: worker.drain } satisfies IssueAttemptReactor["Service"];
});

export const layer = Layer.effect(IssueAttemptReactor, make);
