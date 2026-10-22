import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Layer from "effect/Layer";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryMcp from "./mcp/handlers.ts";
import { FactoryToolkit } from "./mcp/tools.ts";

/** The engineering factory for the server's lifetime. */
export const layer = FactoryService.layer.pipe(Layer.provide(IdAllocator.layer));

/** Handler builds only need the service to exist. */
export const testLayer = Layer.mock(FactoryService.FactoryService)({});

export const mcpToolkit = McpHttpServer.toolkitRegistration(FactoryToolkit, FactoryMcp.layer);
