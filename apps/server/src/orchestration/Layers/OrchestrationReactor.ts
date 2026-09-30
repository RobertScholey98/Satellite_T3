import { IdeaPromotion } from "../../ideas/IdeaPromotion.ts";
import { IdeaUpdateReactor } from "../../ideas/IdeaUpdateReactor.ts";
import { IdeaDeletionReactor } from "../../ideas/IdeaDeletionReactor.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as PullRequestSyncReactor from "../PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "../ThreadPullRequestReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import * as StorageCleanup from "../../storageCleanup.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const threadSettlementReactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
  const pullRequestSyncReactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  const threadPullRequestReactor = yield* ThreadPullRequestReactor.ThreadPullRequestReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const storageCleanup = yield* StorageCleanup.StorageCleanup;
  const ideaUpdates = yield* IdeaUpdateReactor;
  const ideaDeletion = yield* IdeaDeletionReactor;
  const ideaPromotion = yield* IdeaPromotion;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* threadDeletionReactor.start();
    yield* threadPullRequestReactor.start();
    yield* threadSettlementReactor.start();
    yield* pullRequestSyncReactor.start();
    yield* agentAwarenessRelay.start();
    yield* storageCleanup.start();
    yield* ideaUpdates.start();
    yield* ideaDeletion.start();
    yield* ideaPromotion.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
