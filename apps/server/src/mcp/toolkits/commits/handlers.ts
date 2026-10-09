import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Effect from "effect/Effect";
import * as CommitRecommendationService from "../../../git/CommitRecommendationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CommitsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const commits = yield* CommitRecommendationService.CommitRecommendationService;
  return {
    set_commit_recommendation: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireThreadMcpCapability("commits");
        return { recommendation: yield* commits.set(scope.thread.threadId, input) };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof CommitsToolkit.tools>;
});

export const CommitsToolkitHandlersLive = McpToolAccess.toLayer(CommitsToolkit, make);
