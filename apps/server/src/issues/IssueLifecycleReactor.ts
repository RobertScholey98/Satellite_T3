import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { forkParked } from "../serverActivation.ts";
import { IssueService, type IssueServiceShape } from "./IssueService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export class IssueLifecycleReactor extends Context.Service<
  IssueLifecycleReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/issues/IssueLifecycleReactor") {}

export const recoverStartedIssueAttempts = (
  firstPromptSent: IssueServiceShape["firstPromptSent"],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Requested turns remain pending with a null turn ID. A persisted provider
    // turn proves acceptance even when the post-send issue hook was interrupted.
    const rows = yield* sql<{
      thread_id: string;
    }>`SELECT DISTINCT attempts.thread_id FROM issue_attempts attempts
    WHERE attempts.status='attached' AND attempts.started_at IS NULL AND attempts.worktree_path IS NOT NULL
      AND EXISTS (SELECT 1 FROM projection_turns turns WHERE turns.thread_id=attempts.thread_id
        AND turns.turn_id IS NOT NULL AND turns.started_at IS NOT NULL)`;
    for (const row of rows)
      yield* firstPromptSent({
        threadId: ThreadId.make(row.thread_id),
        eventKey: `recovered-send:${row.thread_id}`,
      });
  });

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const issues = yield* IssueService;
  const projection = yield* ProjectionSnapshotQuery;
  const worker = yield* makeDrainableWorker((event: OrchestrationEvent | null) =>
    Effect.gen(function* () {
      if (event?.type === "thread.pull-request-linked") {
        const link = event.payload.link;
        if (link.source !== "stack")
          yield* issues.observePullRequest({
            threadId: event.payload.threadId,
            eventKey: event.eventId,
            key: link,
            state: link.snapshot?.state ?? "open",
            source: link.source,
          });
      } else if (event?.type === "thread.pull-request-synced") {
        yield* issues.observePullRequest({
          threadId: event.payload.threadId,
          eventKey: event.eventId,
          key: event.payload,
          state: event.payload.snapshot.state,
        });
      } else if (
        event?.type === "thread.session-set" &&
        event.payload.session.status === "running" &&
        event.payload.session.activeTurnId !== null
      ) {
        yield* issues.firstPromptSent({
          threadId: event.payload.threadId,
          eventKey: `accepted:${event.eventId}`,
        });
      }
      if (event === null) {
        yield* recoverStartedIssueAttempts(issues.firstPromptSent);
        const threads = yield* projection.listThreadsWithPullRequests();
        for (const thread of threads)
          for (const link of thread.pullRequests) {
            if (
              link.snapshot === null ||
              link.source === "stack-dismissed" ||
              link.source === "stack"
            )
              continue;
            yield* issues.observePullRequest({
              threadId: thread.id,
              key: link,
              state: link.snapshot.state,
              eventKey: `recovered:${thread.id}:${link.host}:${link.repository}:${link.number}:${link.snapshot.updatedAt}:${link.snapshot.state}`,
            });
          }
      }
      yield* issues.drain;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("issue lifecycle synchronization failed", { cause }),
      ),
    ),
  );
  return {
    start: Effect.fn("IssueLifecycleReactor.start")(function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* forkParked(
        Stream.runForEach(events, (event) =>
          event.type === "thread.pull-request-linked" ||
          event.type === "thread.pull-request-synced" ||
          event.type === "thread.meta-updated" ||
          event.type === "thread.session-set"
            ? worker.enqueue(event)
            : Effect.void,
        ),
      );
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue(null);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
    }),
    drain: worker.drain,
  } satisfies IssueLifecycleReactor["Service"];
});
export const layer = Layer.effect(IssueLifecycleReactor, make);
