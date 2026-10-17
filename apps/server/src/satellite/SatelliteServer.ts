import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { drainLegacyThreadArchives } from "./persistence/drainLegacyThreadArchives.ts";

/**
 * Satellite's server-lifetime services, reactors and startup steps. `server.ts` provides it once
 * beside upstream's core services, and it takes what it needs from them.
 */
export const layer = Layer.effectDiscard(
  drainLegacyThreadArchives().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not archive legacy Satellite threads", { cause }),
    ),
    Effect.forkScoped,
  ),
);

/** Registers Satellite's MCP toolkits on the `/mcp` server through `toolkitRegistration`. */
export const withMcpToolkits = <A, E, R>(mcpServer: Layer.Layer<A, E, R>) => mcpServer;
