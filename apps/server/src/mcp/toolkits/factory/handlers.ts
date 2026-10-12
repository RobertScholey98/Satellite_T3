import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FactoryError,
  FactoryIntegrationRead,
  FactoryMergeGroupRead,
  FactorySnapshot,
  PreviewAutomationSnapshot,
} from "@t3tools/contracts";

import * as FactoryImprovementEvidence from "../../../factory/FactoryImprovementEvidence.ts";
import * as FactoryIntegrationExecution from "../../../factory/FactoryIntegrationExecution.ts";
import * as FactoryPreviewService from "../../../factory/FactoryPreviewService.ts";
import * as FactorySchedulingEffects from "../../../factory/FactorySchedulingEffects.ts";
import * as FactoryService from "../../../factory/FactoryService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FactoryToolkit, FactoryPreviewSnapshotToolkit } from "./tools.ts";

const decodePreviewSnapshot = Schema.decodeUnknownEffect(PreviewAutomationSnapshot);

/** Encodes a read model for a tool whose output schema is `EncodedRead`. */
const encoded =
  <A, I extends { readonly [key: string]: unknown }>(schema: Schema.Codec<A, I>) =>
  (value: A) =>
    Schema.encodeEffect(schema)(value).pipe(
      Effect.mapError((cause) => new FactoryError({ code: "execution-unavailable", cause })),
    );

/** The calling thread. Factory scope derives from it, never from parameters. */
const callerThread = (operation: string) =>
  McpInvocationContext.McpInvocationContext.pipe(
    Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, operation)),
    Effect.map((scope) => scope.thread.threadId),
  );
const callerThreadId = callerThread("This factory tool");
const previewThreadId = callerThread("Candidate preview");

export const layer = McpToolAccess.toLayer(
  FactoryToolkit,
  Effect.gen(function* () {
    const factory = yield* FactoryService.FactoryService;
    const scheduling = yield* FactorySchedulingEffects.FactorySchedulingEffects;
    const integrations = yield* FactoryIntegrationExecution.FactoryIntegrationExecution;
    const evidence = yield* FactoryImprovementEvidence.FactoryImprovementEvidence;
    const dispatch = (command: Parameters<typeof factory.threadDispatch>[1]) =>
      Effect.flatMap(callerThreadId, (threadId) => factory.threadDispatch(threadId, command));
    return {
      factory_merge_group_start: McpToolAccess.actsAsCaller((input) =>
        dispatch({ type: "merge.group.start", ...input }),
      ),
      factory_merge_operation_action: McpToolAccess.actsAsCaller(({ command }) =>
        dispatch(command),
      ),
      factory_merge_group_get: McpToolAccess.readsAsCaller(({ groupId }) =>
        Effect.flatMap(callerThreadId, (threadId) =>
          factory.threadMergeGroup(threadId, groupId),
        ).pipe(Effect.flatMap(encoded(FactoryMergeGroupRead))),
      ),
      factory_merge_group_review: McpToolAccess.actsAsCaller((input) =>
        dispatch({ type: "merge.group.review", ...input }),
      ),
      factory_integration_get: McpToolAccess.readsAsCaller(({ integrationId }) =>
        Effect.flatMap(callerThreadId, (threadId) =>
          factory.threadIntegration(threadId, integrationId),
        ).pipe(Effect.flatMap(encoded(FactoryIntegrationRead))),
      ),
      factory_integration_read_patch: McpToolAccess.readsAsCaller((input) =>
        Effect.gen(function* () {
          const threadId = yield* callerThreadId;
          const projectId = yield* factory.threadPatchProject(threadId, input.patchArtifactId);
          const page = yield* integrations.readPatch(input);
          if (page.projectId !== projectId || page.patchArtifactId !== input.patchArtifactId)
            return yield* new FactoryError({
              code: "execution-unavailable",
              detail: "The managed execution boundary could not be verified. No host tool was run.",
            });
          return page;
        }),
      ),
      factory_integration_command: McpToolAccess.actsAsCaller(({ command }) => dispatch(command)),
      factory_collaboration_directory: McpToolAccess.readsAsCaller(({ cursor }) =>
        Effect.flatMap(callerThreadId, (threadId) => factory.threadDirectory(threadId, cursor)),
      ),
      factory_improvement_record: McpToolAccess.readsAsCaller((input) =>
        Effect.flatMap(callerThreadId, (threadId) =>
          factory.threadImprovementRecord(threadId, input),
        ),
      ),
      factory_improvement_snapshot: McpToolAccess.readsAsCaller(({ cursor }) =>
        Effect.flatMap(callerThreadId, (threadId) => factory.threadImprovements(threadId, cursor)),
      ),
      // Only the system manager's own thread can read: its id is its thread id.
      factory_investigation_read: McpToolAccess.readsAsCaller((input) =>
        Effect.flatMap(callerThreadId, (threadId) => evidence.read(threadId, input)),
      ),
      factory_ticket_read: McpToolAccess.readsAsCaller(({ candidateId }) =>
        Effect.gen(function* () {
          yield* factory.threadTicketAccess(yield* callerThreadId, candidateId);
          return yield* scheduling.read(candidateId);
        }),
      ),
      factory_preview_action: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const previews = yield* FactoryPreviewService.FactoryPreviewService;
          return yield* previews.invoke(yield* previewThreadId, input);
        }),
      ),
      factory_preview_finish: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const previews = yield* FactoryPreviewService.FactoryPreviewService;
          return yield* previews.finish(yield* previewThreadId, input);
        }),
      ),
      factory_snapshot: McpToolAccess.readsAsCaller(() =>
        Effect.flatMap(callerThreadId, factory.threadSnapshot).pipe(
          Effect.flatMap(encoded(FactorySnapshot)),
        ),
      ),
      factory_dispatch: McpToolAccess.actsAsCaller(({ command }) => dispatch(command)),
    };
  }),
);

export const layerSnapshot = McpToolAccess.toLayer(FactoryPreviewSnapshotToolkit, {
  factory_preview_snapshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const previews = yield* FactoryPreviewService.FactoryPreviewService;
      const result = yield* previews.invoke(yield* previewThreadId, {
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
