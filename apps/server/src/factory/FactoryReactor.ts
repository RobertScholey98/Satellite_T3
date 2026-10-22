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
import { type FactoryObservedThread, FactoryService } from "./FactoryService.ts";

/**
 * Drives assignments from upstream's thread events. The live event stream starts at the latest
 * event, so a sweep at startup and every minute recovers what happened while nothing listened and
 * wakes managers for Ready tickets.
 */
export class FactoryReactor extends Context.Service<
  FactoryReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/factory/FactoryReactor") {}

type Job =
  | { readonly _tag: "thread"; readonly threadId: ThreadId }
  | { readonly _tag: "observe"; readonly thread: FactoryObservedThread }
  | { readonly _tag: "sweep" };

/** The work an event gives the factory, if any. */
const jobOf = (event: OrchestrationV2DomainEvent): Job | null => {
  switch (event.type) {
    case "thread.created":
      // A user's fork of a member thread is theirs, not a team member.
      if (event.payload.lineage.relationshipToParent !== "subagent") return null;
      return {
        _tag: "observe",
        thread: {
          threadId: event.payload.id,
          parentThreadId: event.payload.lineage.parentThreadId,
          modelSelection: event.payload.modelSelection,
        },
      };
    case "run.created":
    case "run.updated":
    case "runtime-request.updated":
    case "thread.pull-request-link-updated":
    case "thread.pull-request-synced":
    case "thread.deleted":
      return { _tag: "thread", threadId: event.threadId };
    default:
      return null;
  }
};

const run = (factory: FactoryService["Service"], job: Job) => {
  switch (job._tag) {
    case "sweep":
      return factory.sweep;
    case "observe":
      return factory.observeThread(job.thread);
    case "thread":
      return factory.reconcileThread(job.threadId);
  }
};

const logFailure = (message: string) => (cause: Cause.Cause<unknown>) =>
  Effect.logWarning(message, { cause: Cause.pretty(cause) });

export const make = Effect.gen(function* () {
  const factory = yield* FactoryService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const worker = yield* makeDrainableWorker((job: Job) =>
    run(factory, job).pipe(Effect.catchCause(logFailure("factory reconcile failed"))),
  );
  const start = Effect.fn("FactoryReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        const job = jobOf(event);
        return job === null ? Effect.void : worker.enqueue(job);
      }).pipe(Effect.catchCause(logFailure("factory event stream failed"))),
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
  });
  return { start, drain: worker.drain } satisfies FactoryReactor["Service"];
});

export const layer = Layer.effect(FactoryReactor, make);
