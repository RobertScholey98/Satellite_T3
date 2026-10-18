import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Issues from "../issues/Issues.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as RevdocHandlers from "../mcp/toolkits/revdoc/handlers.ts";
import { RevdocToolkit } from "../mcp/toolkits/revdoc/tools.ts";
import * as OpenWork from "../openWork/OpenWork.ts";
import * as RevdocLifecycleReactor from "../revdoc/RevdocLifecycleReactor.ts";
import * as RevdocService from "../revdoc/RevdocService.ts";
import * as RevdocWorktreeRemoval from "../revdoc/RevdocWorktreeRemoval.ts";
import { drainLegacyThreadArchivesAfterStartup } from "./persistence/drainLegacyThreadArchives.ts";

/**
 * Satellite's server-lifetime services, reactors and startup steps. Provided once in server.ts,
 * above upstream's runtime so it can wait for `ServerRuntimeStartup`. Its outputs reach upstream's
 * transports first, which is how Revdoc's worktree removal decorator applies without an upstream
 * edit.
 */
export const layer = Layer.mergeAll(
  Layer.effectDiscard(
    drainLegacyThreadArchivesAfterStartup().pipe(
      Effect.catchTags({
        // Upstream reports a failed or interrupted startup itself.
        ServerRuntimeStartupError: () => Effect.void,
        SqlError: (cause) =>
          Effect.logWarning("Could not archive legacy Satellite threads", { cause }),
      }),
      Effect.forkScoped,
    ),
  ),
  OpenWork.layer,
  RevdocWorktreeRemoval.layer,
  RevdocLifecycleReactor.layer,
  Issues.layer,
).pipe(Layer.provideMerge(RevdocService.layer));

/**
 * Satellite's services with test stand-ins for their dependencies, for tests that build Satellite
 * handlers.
 */
export const testLayer = Layer.mergeAll(
  OpenWork.testLayer,
  RevdocService.testLayer,
  Issues.testLayer,
  // One feature per line, as in `layer`, so features append without touching each other's lines.
);

/** Where Satellite's MCP toolkits join `/mcp`, via `McpHttpServer.toolkitRegistration`. */
export const withMcpToolkits = <A, E, R>(mcpServer: Layer.Layer<A, E, R>) =>
  Layer.mergeAll(
    mcpServer,
    McpHttpServer.toolkitRegistration(RevdocToolkit, RevdocHandlers.layer),
    Issues.mcpToolkit,
  );
