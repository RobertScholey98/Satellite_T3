import * as Effect from "effect/Effect";
import * as CommitRecommendationService from "../../../git/CommitRecommendationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CommitsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const commits = yield* CommitRecommendationService.CommitRecommendationService;
  return CommitsToolkit.of({
    set_commit_recommendation: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("commits");
        return { recommendation: yield* commits.set(scope.threadId, input) };
      }),
  });
});

export const CommitsToolkitHandlersLive = CommitsToolkit.toLayer(make);
