import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FactoryError, PreviewAutomationSnapshot } from "@t3tools/contracts";
import { FactoryPreviewService } from "../../../factory/FactoryPreviewService.ts";

import * as FactoryMcpGuard from "../../../factory/FactoryMcpGuard.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FactoryToolkit, FactoryPreviewSnapshotToolkit } from "./tools.ts";

const decodePreviewSnapshot = Schema.decodeUnknownEffect(PreviewAutomationSnapshot);

export const layer = McpToolAccess.toLayer(FactoryToolkit, {
  factory_merge_group_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* FactoryMcpGuard.FactoryMcpGuard).dispatch(
        yield* McpInvocationContext.McpInvocationContext,
        { type: "merge.group.start", ...input },
      );
    }),
  ),
  factory_merge_operation_action: McpToolAccess.actsAsCaller(
    ({ action, commandId, operationId, reason, recommendation }) =>
      Effect.gen(function* () {
        const guard = yield* FactoryMcpGuard.FactoryMcpGuard;
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        if (action !== "escalate")
          return yield* guard.dispatch(invocation, {
            type: action === "retry" ? "merge.operation.retry" : "merge.operation.reconcile",
            commandId,
            operationId,
          });
        if (reason === undefined || recommendation === undefined)
          return yield* new FactoryError({
            code: "invalid-state",
            detail: "Escalation needs a reason and a recommendation for the human.",
          });
        return yield* guard.dispatch(invocation, {
          type: "merge.operation.escalate",
          commandId,
          operationId,
          reason,
          recommendation,
        });
      }),
  ),
  factory_merge_group_get: McpToolAccess.readsAsCaller(({ groupId }) =>
    Effect.gen(function* () {
      return yield* (yield* FactoryMcpGuard.FactoryMcpGuard).mergeGroupRead(
        yield* McpInvocationContext.McpInvocationContext,
        groupId,
      );
    }),
  ),
  factory_merge_group_review: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* FactoryMcpGuard.FactoryMcpGuard).dispatch(
        yield* McpInvocationContext.McpInvocationContext,
        { type: "merge.group.review", ...input },
      );
    }),
  ),
  factory_integration_get: McpToolAccess.readsAsCaller(({ integrationId }) =>
    Effect.gen(function* () {
      return yield* (yield* FactoryMcpGuard.FactoryMcpGuard).integrationRead(
        yield* McpInvocationContext.McpInvocationContext,
        integrationId,
      );
    }),
  ),
  factory_integration_read_patch: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* FactoryMcpGuard.FactoryMcpGuard).integrationPatch(
        yield* McpInvocationContext.McpInvocationContext,
        input,
      );
    }),
  ),
  factory_integration_command: McpToolAccess.actsAsCaller(({ command }) =>
    Effect.gen(function* () {
      return yield* (yield* FactoryMcpGuard.FactoryMcpGuard).dispatch(
        yield* McpInvocationContext.McpInvocationContext,
        command,
      );
    }),
  ),
  factory_collaboration_directory: McpToolAccess.readsAsCaller(({ cursor }) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      return yield* (yield* FactoryMcpGuard.FactoryMcpGuard).collaborationDirectory(
        invocation,
        cursor,
      );
    }),
  ),
  factory_improvement_record: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      return yield* (yield* FactoryMcpGuard.FactoryMcpGuard).improvementRecord(invocation, input);
    }),
  ),
  factory_improvement_snapshot: McpToolAccess.readsAsCaller(({ cursor }) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      return yield* (yield* FactoryMcpGuard.FactoryMcpGuard).improvementSnapshot(
        invocation,
        cursor,
      );
    }),
  ),
  factory_investigation_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      return yield* (yield* FactoryMcpGuard.FactoryMcpGuard).readInvestigation(invocation, input);
    }),
  ),
  factory_ticket_read: McpToolAccess.readsAsCaller(({ candidateId }) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      return yield* (yield* FactoryMcpGuard.FactoryMcpGuard).readTicket(invocation, candidateId);
    }),
  ),
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
      const snapshot = yield* decodePreviewSnapshot(result.result).pipe(
        Effect.mapError((cause) => new FactoryError({ code: "execution-unavailable", cause })),
      );
      return { ...snapshot, sequence: result.sequence, receiptDigest: result.receiptDigest };
    }),
  ),
});
