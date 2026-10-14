import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { DocumentService } from "../documents/DocumentService.ts";
import { WorktreeRegistry } from "../documents/WorktreeRegistry.ts";
import * as CommitRecommendationService from "../git/CommitRecommendationService.ts";
import { IdeaDeletionReactor } from "../ideas/IdeaDeletionReactor.ts";
import { IdeaNotebookStore } from "../ideas/IdeaNotebookStore.ts";
import { IdeaPromotion } from "../ideas/IdeaPromotion.ts";
import { IdeaRuntime } from "../ideas/IdeaRuntime.ts";
import { IdeaUpdateReactor } from "../ideas/IdeaUpdateReactor.ts";
import * as IssueHost from "../issues/IssueHost.ts";
import * as IssueLifecycleReactor from "../issues/IssueLifecycleReactor.ts";
import * as IssueService from "../issues/IssueService.ts";
import {
  imageToolRegistration,
  registerImageTool,
  toolkitRegistration,
} from "../mcp/McpHttpServer.ts";
import { CommitsToolkitHandlersLive } from "../mcp/toolkits/commits/handlers.ts";
import { CommitsToolkit } from "../mcp/toolkits/commits/tools.ts";
import { DocumentsToolkitHandlersLive } from "../mcp/toolkits/documents/handlers.ts";
import { DocumentsToolkit } from "../mcp/toolkits/documents/tools.ts";
import {
  IdeasImageToolkitHandlersLive,
  IdeasToolkitHandlersLive,
} from "../mcp/toolkits/ideas/handlers.ts";
import { IdeaImageTool, IdeasImageToolkit, IdeasToolkit } from "../mcp/toolkits/ideas/tools.ts";
import { RevdocToolkit, RevdocToolkitHandlersLive } from "../mcp/toolkits/revdoc/tools.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as EventStoreV2 from "../orchestration-v2/EventStore.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SatelliteOrchestration from "../orchestration-v2/SatelliteOrchestration.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { OpenWorkService } from "../openWork/OpenWorkService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RevdocService from "../revdoc/RevdocService.ts";
import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as ForgejoCli from "../sourceControl/ForgejoCli.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";

const layerIssueService = IssueService.layer.pipe(
  Layer.provide(ProjectStore.layer),
  Layer.provideMerge(IssueHost.layer),
  Layer.provide(
    Layer.mergeAll(
      GitHubCli.layer,
      GitLabCli.layer,
      AzureDevOpsCli.layer,
      ForgejoCli.layer,
      BitbucketApi.layer,
    ),
  ),
);

/** What upstream's review service needs from Satellite to accept a registered worktree. */
export const layerReviewDependencies = WorktreeRegistry.layer.pipe(
  Layer.provide(ProjectStore.layer),
);

/**
 * Satellite's server-lifetime services and reactors. `server.ts` provides it once; what it needs
 * from upstream, such as the source control provider registry, it takes from that environment.
 */
export const layer = Layer.mergeAll(
  RevdocService.layer,
  OpenWorkService.layer,
  CommitRecommendationService.layer,
  Layer.effectDiscard(Effect.flatMap(IdeaUpdateReactor, (worker) => worker.start())),
  Layer.effectDiscard(Effect.flatMap(IdeaDeletionReactor, (worker) => worker.start())).pipe(
    Layer.provide(IdeaDeletionReactor.layer),
  ),
  Layer.effectDiscard(
    Effect.flatMap(IssueLifecycleReactor.IssueLifecycleReactor, (worker) => worker.start()),
  ).pipe(Layer.provide(IssueLifecycleReactor.layer)),
  Layer.effectDiscard(Effect.flatMap(IdeaPromotion, (worker) => worker.start())),
).pipe(
  Layer.provideMerge(IdeaUpdateReactor.layer),
  Layer.provideMerge(IdeaPromotion.layer),
  Layer.provideMerge(IdeaRuntime.layer),
  Layer.provideMerge(DocumentService.layer),
  Layer.provideMerge(WorktreeRegistry.layer),
  Layer.provideMerge(IdeaNotebookStore.layer),
  Layer.provideMerge(layerIssueService),
  Layer.provideMerge(SatelliteOrchestration.layer),
  Layer.provideMerge(RuntimeLayer.layerEventSink),
  Layer.provideMerge(EventStoreV2.layerFromOrchestrationEventStore),
  Layer.provideMerge(ProjectionStoreV2.layer),
  Layer.provide(Layer.merge(PreviewAutomationBroker.layer, ProcessRunner.layer)),
);

const registerIdeaImage = Effect.gen(function* () {
  const documents = yield* DocumentService;
  const built = yield* IdeasImageToolkit;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  yield* registerImageTool(
    IdeaImageTool,
    (payload) =>
      built
        .handle("idea_read_image", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) =>
      effect.pipe(
        Effect.provideService(DocumentService, documents),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      ),
    "idea-image",
    "Could not read the idea image.",
  );
});
const IdeasToolkitRegistrationLive = Layer.mergeAll(
  toolkitRegistration(IdeasToolkit, IdeasToolkitHandlersLive),
  imageToolRegistration(registerIdeaImage, IdeasImageToolkitHandlersLive),
);
export const DocumentsToolkitRegistrationLive = toolkitRegistration(
  DocumentsToolkit,
  DocumentsToolkitHandlersLive,
);
export const CommitsToolkitRegistrationLive = toolkitRegistration(
  CommitsToolkit,
  CommitsToolkitHandlersLive,
);
export const RevdocToolkitRegistrationLive = toolkitRegistration(
  RevdocToolkit,
  RevdocToolkitHandlersLive,
);

/** Registers Satellite's MCP toolkits on the `/mcp` server that `mcpServer` provides. */
export const withMcpToolkits = <A, E, R>(mcpServer: Layer.Layer<A, E, R>) =>
  Layer.mergeAll(
    IdeasToolkitRegistrationLive,
    DocumentsToolkitRegistrationLive,
    CommitsToolkitRegistrationLive,
    RevdocToolkitRegistrationLive,
  ).pipe(Layer.provideMerge(mcpServer));
