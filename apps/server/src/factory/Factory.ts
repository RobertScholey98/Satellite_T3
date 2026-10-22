import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as FactoryReactor from "./FactoryReactor.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryMcp from "./mcp/handlers.ts";
import { FactoryToolkit } from "./mcp/tools.ts";

/** The engineering factory for the server's lifetime: the service and its reactor. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* FactoryReactor.FactoryReactor;
    yield* reactor.start();
  }),
).pipe(
  Layer.provideMerge(FactoryReactor.layer),
  Layer.provideMerge(FactoryService.layer.pipe(Layer.provide(IdAllocator.layer))),
);

/** Handler builds only need the service to exist. */
export const testLayer = Layer.mock(FactoryService.FactoryService)({});

export const mcpToolkit = McpHttpServer.toolkitRegistration(FactoryToolkit, FactoryMcp.layer);
