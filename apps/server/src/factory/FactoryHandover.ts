import {
  CommandId,
  FactoryError,
  type ProjectId,
  type ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export class FactoryHandover extends Context.Service<
  FactoryHandover,
  {
    readonly stop: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly commandId: CommandId;
    }) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryHandover") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providers = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const stop = Effect.fn("FactoryHandover.stop")(function* (
    input: Parameters<FactoryHandover["Service"]["stop"]>[0],
  ) {
    const root = yield* projections
      .getThread(input.threadId)
      .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
    if (
      root.projectId !== input.projectId ||
      root.deletedAt !== null ||
      root.archivedAt !== null ||
      root.lineage.relationshipToParent === "subagent"
    ) {
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "Only an active independent thread in this project can be handed over.",
      });
    }
    const visited = new Set<ThreadId>();
    const remaining = [input.threadId];
    const detachments: Array<{ threadId: ThreadId; providerSessionId: ProviderSessionId }> = [];
    while (remaining.length > 0) {
      const threadId = remaining.shift()!;
      if (visited.has(threadId)) continue;
      visited.add(threadId);
      yield* orchestrator
        .dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`${input.commandId}:factory-stop:${threadId}`),
          threadId,
          reason: "Handing over this conversation to its engineering manager.",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new FactoryError({
                code: "execution-unavailable",
                cause,
                detail:
                  "The existing team could not be stopped. Its work has not been captured or relaunched.",
              }),
          ),
        );
      const state = yield* projections
        .getThreadRecords(threadId, ["providerThreads", "subagents"])
        .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
      for (const task of state.subagents) {
        if (task.origin === "app_owned" && task.childThreadId !== null)
          remaining.push(task.childThreadId);
      }
      const sessionIds = new Set(
        state.providerThreads.flatMap((thread) =>
          thread.providerSessionId === null ? [] : [thread.providerSessionId],
        ),
      );
      for (const providerSessionId of sessionIds) {
        detachments.push({ threadId, providerSessionId });
      }
    }
    yield* Effect.forEach(
      detachments,
      ({ threadId, providerSessionId }) =>
        providers
          .detach({ providerSessionId, threadId, revokeMcpCredential: true, awaitQuiescence: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new FactoryError({
                  code: "execution-unavailable",
                  cause,
                  detail:
                    "The previous provider runtime has not confirmed that it stopped. Retry handover after it has stopped; the original work remains in place.",
                }),
            ),
          ),
      { concurrency: "unbounded", discard: true },
    );
    yield* Effect.forEach(
      visited,
      (threadId) =>
        Effect.gen(function* () {
          const current = yield* projections
            .getThreadRecords(threadId, ["runs"])
            .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
          for (const run of current.runs.filter(ThreadManagement.isActiveRun)) {
            const settled = yield* threads
              .waitForThread({
                threadId,
                projectId: current.thread.projectId,
                runId: run.id,
                timeoutMs: 30_000,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new FactoryError({
                      code: "execution-unavailable",
                      cause,
                      detail:
                        "The previous team's stop could not be confirmed. Its original work is preserved; retry after the turn settles.",
                    }),
                ),
              );
            if (settled.timedOut)
              return yield* new FactoryError({
                code: "execution-unavailable",
                detail:
                  "The previous runtime stopped, but its turn has not finished settling. Retry handover after its checkpoint or pending work settles.",
              });
          }
        }),
      { concurrency: "unbounded", discard: true },
    );
  });
  return FactoryHandover.of({ stop });
});

export const layer = Layer.effect(FactoryHandover, make);
