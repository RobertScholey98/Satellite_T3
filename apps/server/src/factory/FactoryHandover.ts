import {
  CommandId,
  FactoryError,
  type ProjectId,
  type ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

interface FactoryTeamStopInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
}

export class FactoryHandover extends Context.Service<
  FactoryHandover,
  {
    readonly stop: (input: FactoryTeamStopInput) => Effect.Effect<void, FactoryError>;
    readonly stopTeam: (input: FactoryTeamStopInput) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryHandover") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providers = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const stopTeam = Effect.fn("FactoryHandover.stopTeam")(function* (input: FactoryTeamStopInput) {
    const root = yield* projections
      .getThread(input.threadId)
      .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
    if (root.projectId !== input.projectId) {
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "This thread does not belong to the affected project.",
      });
    }
    const visited = new Set<ThreadId>();
    const affected: ThreadId[] = [];
    const remaining = [input.threadId];
    const stops: Array<Exit.Exit<unknown, FactoryError>> = [];
    const projectThreads = yield* projections.getProjectThreads(input.projectId).pipe(
      Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })),
      Effect.exit,
    );
    const children = new Map<ThreadId, ThreadId[]>();
    if (Exit.isFailure(projectThreads)) stops.push(projectThreads);
    else
      for (const thread of projectThreads.value) {
        const parent = thread.lineage.parentThreadId;
        if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), thread.id]);
      }
    const detachments: Array<{ threadId: ThreadId; providerSessionId: ProviderSessionId }> = [];
    while (remaining.length > 0) {
      const threadId = remaining.shift()!;
      if (visited.has(threadId)) continue;
      visited.add(threadId);
      const thread = yield* projections.getThread(threadId).pipe(
        Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })),
        Effect.exit,
      );
      if (Exit.isFailure(thread)) {
        stops.push(thread);
        continue;
      }
      if (thread.value.projectId !== input.projectId) continue;
      affected.push(threadId);
      remaining.push(...(children.get(threadId) ?? []));
      const stopped = yield* orchestrator
        .dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`${input.commandId}:factory-stop:${threadId}`),
          threadId,
          reason: "Stopping this thread and its dedicated team.",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new FactoryError({
                code: "execution-unavailable",
                cause,
                detail:
                  "The team could not be stopped. Its work is preserved; retry stopping before continuing.",
              }),
          ),
          Effect.exit,
        );
      stops.push(stopped);
      const state = yield* projections
        .getThreadRecords(threadId, ["providerThreads", "subagents"])
        .pipe(
          Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })),
          Effect.exit,
        );
      if (Exit.isFailure(state)) {
        stops.push(state);
        continue;
      }
      for (const task of state.value.subagents) {
        if (task.origin === "app_owned" && task.childThreadId !== null)
          remaining.push(task.childThreadId);
      }
      const sessionIds = new Set(
        state.value.providerThreads.flatMap((thread) =>
          thread.providerSessionId === null ? [] : [thread.providerSessionId],
        ),
      );
      for (const providerSessionId of sessionIds) {
        detachments.push({ threadId, providerSessionId });
      }
    }
    const detached = yield* Effect.forEach(
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
                    "The provider runtime has not confirmed that it stopped. Retry stopping; the original work remains in place.",
                }),
            ),
            Effect.exit,
          ),
      { concurrency: "unbounded" },
    );
    for (const outcome of [...stops, ...detached])
      if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
    yield* Effect.forEach(
      affected,
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
                        "The team's stop could not be confirmed. Its original work is preserved; retry after the turn settles.",
                    }),
                ),
              );
            if (settled.timedOut)
              return yield* new FactoryError({
                code: "execution-unavailable",
                detail:
                  "The runtime stopped, but its turn has not finished settling. Retry stopping after its checkpoint or pending work settles.",
              });
          }
        }),
      { concurrency: "unbounded", discard: true },
    );
  });
  const stop = Effect.fn("FactoryHandover.stop")(function* (input: FactoryTeamStopInput) {
    const root = yield* projections
      .getThread(input.threadId)
      .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
    if (
      root.projectId !== input.projectId ||
      root.deletedAt !== null ||
      root.archivedAt !== null ||
      root.lineage.relationshipToParent === "subagent"
    )
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "Only an active independent thread in this project can be handed over.",
      });
    yield* stopTeam(input);
  });
  return FactoryHandover.of({ stop, stopTeam });
});

export const layer = Layer.effect(FactoryHandover, make);
