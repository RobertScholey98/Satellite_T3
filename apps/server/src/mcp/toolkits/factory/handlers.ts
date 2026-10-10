import * as Effect from "effect/Effect";

import * as FactoryMcpGuard from "../../../factory/FactoryMcpGuard.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FactoryToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(FactoryToolkit, {
  factory_snapshot: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const guard = yield* FactoryMcpGuard.FactoryMcpGuard;
      return yield* guard.snapshot(invocation);
    }),
  ),
  factory_dispatch: McpToolAccess.actsAsCaller(({ command }) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const guard = yield* FactoryMcpGuard.FactoryMcpGuard;
      return yield* guard.dispatch(invocation, command);
    }),
  ),
});
