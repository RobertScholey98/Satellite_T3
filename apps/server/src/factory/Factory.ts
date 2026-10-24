import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as FactoryConfigTransfer from "./config/exportImport.ts";
import * as FactoryConfigRepo from "./config/FactoryConfigRepo.ts";
import * as FactoryConfigStore from "./config/FactoryConfigStore.ts";
import { prepareFactoryConfig } from "./config/prepareFactoryConfig.ts";
import * as FactoryReactor from "./FactoryReactor.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryMcp from "./mcp/handlers.ts";
import { FactoryToolkit } from "./mcp/tools.ts";
import * as FactoryTicketHost from "./tickets/FactoryTicketHost.ts";

/** The engineering factory for the server's lifetime: the service and its reactor. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* prepareFactoryConfig();
    // Managers created before definitions get their own copy of the first manager definition.
    const factory = yield* FactoryService.FactoryService;
    yield* factory.adoptManagerDefinitions.pipe(
      Effect.tap((adopted) =>
        adopted === 0
          ? Effect.void
          : Effect.logInfo("factory managers adopted a manager definition", { adopted }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("factory managers could not adopt a manager definition", { cause }),
      ),
    );
    const reactor = yield* FactoryReactor.FactoryReactor;
    yield* reactor.start();
  }),
).pipe(
  Layer.provideMerge(FactoryReactor.layer),
  Layer.provideMerge(
    FactoryService.layer.pipe(
      Layer.provide(IdAllocator.layer),
      Layer.provide(FactoryTicketHost.layer),
    ),
  ),
  Layer.provideMerge(FactoryConfigRepo.layer),
  Layer.provideMerge(FactoryConfigTransfer.layer),
  Layer.provideMerge(FactoryConfigStore.layer),
);

/** Handler builds only need the services to exist. */
export const testLayer = Layer.mergeAll(
  Layer.mock(FactoryService.FactoryService)({}),
  Layer.mock(FactoryConfigStore.FactoryConfigStore)({ directory: "factory" }),
  Layer.mock(FactoryConfigRepo.FactoryConfigRepo)({}),
  Layer.mock(FactoryConfigTransfer.FactoryConfigTransfer)({}),
);

// `factory_delegate` launches its child through upstream's delegation, as `delegate_task` does.
export const mcpToolkit = McpHttpServer.toolkitRegistration(FactoryToolkit, FactoryMcp.layer).pipe(
  Layer.provide(OrchestratorMcpService.layer),
);
