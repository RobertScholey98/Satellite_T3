import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { drainLegacyThreadArchivesAfterStartup } from "./persistence/drainLegacyThreadArchives.ts";

/**
 * Satellite's server-lifetime services, reactors and startup steps. Provided once in server.ts,
 * above upstream's runtime so it can wait for `ServerRuntimeStartup`.
 */
export const layer = Layer.effectDiscard(
  drainLegacyThreadArchivesAfterStartup().pipe(
    Effect.catchTags({
      // Upstream reports a failed or interrupted startup itself.
      ServerRuntimeStartupError: () => Effect.void,
      SqlError: (cause) =>
        Effect.logWarning("Could not archive legacy Satellite threads", { cause }),
    }),
    Effect.forkScoped,
  ),
);

/** Where Satellite's MCP toolkits join `/mcp`, via `McpHttpServer.toolkitRegistration`. */
export const withMcpToolkits = <A, E, R>(mcpServer: Layer.Layer<A, E, R>) => mcpServer;
