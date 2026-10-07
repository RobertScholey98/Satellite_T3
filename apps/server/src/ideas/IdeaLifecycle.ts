import { IdeaPromotion } from "./IdeaPromotion.ts";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { ProviderEventLoggers } from "../provider/ProviderEventLoggers.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { clearIdeaExecution, withIdeaLock } from "./IdeaExecution.ts";
import { IdeaRuntimeError } from "./IdeaRuntime.ts";

export const closeIdea = Effect.fn("IdeaLifecycle.closeIdea")(function* (threadId: ThreadId) {
  const projections = yield* ProjectionStoreV2;
  const provider = yield* ProviderSessionManagerV2;
  const logs = yield* ProviderEventLoggers;
  const promotions = yield* IdeaPromotion;
  yield* promotions.cancel(threadId);
  yield* (yield* McpSessionRegistry.McpSessionRegistry).revokeThread(threadId);
  yield* withIdeaLock(
    threadId,
    Effect.gen(function* () {
      const projection = yield* projections
        .getRuntimeRecoveryProjection(threadId)
        .pipe(Effect.mapError((e) => new IdeaRuntimeError({ message: e.message })));
      const sessionIds = new Set(
        projection.providerThreads.flatMap((thread) =>
          thread.providerSessionId === null ? [] : [thread.providerSessionId],
        ),
      );
      for (const providerSessionId of sessionIds)
        yield* provider
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.mapError((e) => new IdeaRuntimeError({ message: e.message })));
    }),
  );
  if (logs.retireThread)
    yield* logs
      .retireThread(threadId)
      .pipe(Effect.mapError((e) => new IdeaRuntimeError({ message: e.message })));
  clearIdeaExecution(threadId);
});
