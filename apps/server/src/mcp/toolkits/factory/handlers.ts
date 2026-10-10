import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FactoryError, PreviewAutomationSnapshot } from "@t3tools/contracts";
import { FactoryPreviewService } from "../../../factory/FactoryPreviewService.ts";

import * as FactoryMcpGuard from "../../../factory/FactoryMcpGuard.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FactoryToolkit, FactoryPreviewSnapshotToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(FactoryToolkit, {
  factory_preview_action: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadScope(
        yield* McpInvocationContext.McpInvocationContext,
        "Candidate preview",
      );
      return yield* (yield* FactoryPreviewService).invoke(scope.thread.threadId, input);
    }),
  ),
  factory_preview_finish: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadScope(
        yield* McpInvocationContext.McpInvocationContext,
        "Candidate preview",
      );
      return yield* (yield* FactoryPreviewService).finish(scope.thread.threadId, input);
    }),
  ),
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

export const layerSnapshot = McpToolAccess.toLayer(FactoryPreviewSnapshotToolkit, {
  factory_preview_snapshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadScope(
        yield* McpInvocationContext.McpInvocationContext,
        "Candidate preview",
      );
      const result = yield* (yield* FactoryPreviewService).invoke(scope.thread.threadId, {
        ...input,
        action: { type: "snapshot" },
      });
      const snapshot = yield* Schema.decodeUnknownEffect(PreviewAutomationSnapshot)(
        result.result,
      ).pipe(
        Effect.mapError((cause) => new FactoryError({ code: "execution-unavailable", cause })),
      );
      return { ...snapshot, sequence: result.sequence, receiptDigest: result.receiptDigest };
    }),
  ),
});
