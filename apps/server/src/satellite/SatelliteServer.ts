import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { drainLegacyThreadArchives } from "./persistence/drainLegacyThreadArchives.ts";

/** Satellite's server-lifetime services, reactors and startup steps. Provided once in server.ts. */
export const layer = Layer.effectDiscard(
  drainLegacyThreadArchives().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not archive legacy Satellite threads", { cause }),
    ),
    Effect.forkScoped,
  ),
);

/** Where Satellite's MCP toolkits join `/mcp`, via `McpHttpServer.toolkitRegistration`. */
export const withMcpToolkits = <A, E, R>(mcpServer: Layer.Layer<A, E, R>) => mcpServer;
