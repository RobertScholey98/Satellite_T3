import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import { forkParked } from "../serverActivation.ts";
import * as IssueAttemptReactor from "./IssueAttemptReactor.ts";
import * as IssueHost from "./IssueHost.ts";
import * as IssueService from "./IssueService.ts";
import { cleanUpLegacyIssuePeers } from "./legacyPeerCleanup.ts";
import * as IssuesMcp from "./mcp/handlers.ts";
import { IssuesToolkit } from "./mcp/tools.ts";

/** Issue boards for the server's lifetime: the service, the attempt reactor, and startup cleanup. */
export const layer = Layer.mergeAll(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const reactor = yield* IssueAttemptReactor.IssueAttemptReactor;
      yield* reactor.start();
    }),
  ).pipe(Layer.provideMerge(IssueAttemptReactor.layer)),
  Layer.effectDiscard(
    forkParked(
      cleanUpLegacyIssuePeers.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not remove legacy issue peer credentials", { cause }),
        ),
      ),
    ),
  ),
).pipe(
  Layer.provideMerge(
    IssueService.layer.pipe(Layer.provide(Layer.merge(IssueHost.layer, IdAllocator.layer))),
  ),
);

/** Handler builds only need the service to exist. */
export const testLayer = Layer.mock(IssueService.IssueService)({});

export const mcpToolkit = McpHttpServer.toolkitRegistration(IssuesToolkit, IssuesMcp.layer);
