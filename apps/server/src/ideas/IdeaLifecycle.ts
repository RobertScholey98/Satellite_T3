import { IdeaPromotion } from "./IdeaPromotion.ts";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderEventLoggers } from "../provider/Layers/ProviderEventLoggers.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { clearIdeaExecution, withIdeaLock } from "./IdeaExecution.ts";
import { IdeaRuntimeError } from "./IdeaRuntime.ts";

export const closeIdea = Effect.fn("IdeaLifecycle.closeIdea")(function* (threadId: ThreadId) {
  const provider = yield* ProviderService;
  const logs = yield* ProviderEventLoggers;
  const promotions = yield* IdeaPromotion;
  yield* promotions.cancel(threadId);
  yield* McpSessionRegistry.revokeActiveMcpThread(threadId);
  yield* withIdeaLock(
    threadId,
    Effect.gen(function* () {
      if ((yield* provider.listSessions()).some((session) => session.threadId === threadId))
        yield* provider
          .stopSession({ threadId })
          .pipe(Effect.mapError((e) => new IdeaRuntimeError({ message: e.message })));
    }),
  );
  if (logs.retireThread)
    yield* logs
      .retireThread(threadId)
      .pipe(Effect.mapError((e) => new IdeaRuntimeError({ message: e.message })));
  clearIdeaExecution(threadId);
});
