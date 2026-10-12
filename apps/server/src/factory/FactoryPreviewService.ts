import {
  CommandId,
  FactoryError,
  type FactoryAssignment,
  type FactoryDeliveryRevision,
  type FactorySnapshot,
  type FactoryPreviewActionInput,
  type FactoryPreviewActionResult,
  type FactoryPreviewFinishInput,
  type FactoryRevisionUxEvidence,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as FactoryPreviewExecution from "./FactoryPreviewExecution.ts";
import * as FactoryPreviewEvidence from "./FactoryPreviewEvidence.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { factoryIncidentBlocked } from "./FactoryCollaboration.ts";
import { factoryExecutionBlocked } from "./FactoryControls.ts";

// A preview may keep running only while it serves the live review of the current revision under
// the current grant, with no held delivery flow, incident or execution block.
const previewIsCurrent = (
  state: FactorySnapshot,
  assignment: FactoryAssignment,
  revision: FactoryDeliveryRevision,
) => {
  const preview = revision.preview;
  const review = revision.reviews.find((entry) => entry.id === preview?.reviewId);
  return (
    preview !== undefined &&
    ["starting", "ready"].includes(preview.status) &&
    assignment.outcome === undefined &&
    assignment.status !== "complete" &&
    assignment.delivery?.currentRevisionId === revision.id &&
    assignment.grant?.epoch === revision.grantEpoch &&
    review !== undefined &&
    ["pending", "running"].includes(review.status) &&
    (!assignment.delivery?.flow || assignment.delivery.flow.status === "released") &&
    !factoryIncidentBlocked(state, assignment.id, "preview") &&
    !factoryExecutionBlocked(state, {
      threadId: preview.threadId,
      assignmentId: assignment.id,
      managerId: assignment.managerId,
      projectId: assignment.projectId,
      ancestorThreadIds: [],
    })
  );
};

/**
 * Owns the lifecycle of candidate previews for delivery review. `FactoryService` hands it the
 * pending preview start and stop effects and calls `reconcile` on each delivery drain and after
 * controls and preview stops; the delivery reviewer's MCP tools call `invoke` and `finish`.
 */
export class FactoryPreviewService extends Context.Service<
  FactoryPreviewService,
  {
    /**
     * Stops every preview that is no longer current, including failed ones that may have left
     * containers behind, and records each as stopped. Keeps going past a failed stop and fails
     * with the first error at the end, so callers can retry.
     */
    readonly reconcile: Effect.Effect<void, FactoryError>;
    /**
     * Runs a pending `delivery.preview.start` or `delivery.preview.stop` effect and ignores other
     * intents. Obsolete or superseded work is stopped and retired; a start that is blocked by an
     * incident or execution hold is left pending to try again later.
     */
    readonly handle: (
      pending: FactoryStore.PendingFactoryEffect,
    ) => Effect.Effect<void, FactoryError>;
    readonly invoke: (
      threadId: ThreadId,
      input: FactoryPreviewActionInput,
    ) => Effect.Effect<FactoryPreviewActionResult, FactoryError>;
    /**
     * Seals the reviewer's evidence and records it on the revision that owns the preview. Fails
     * if that preview is no longer on the current revision.
     */
    readonly finish: (
      threadId: ThreadId,
      input: FactoryPreviewFinishInput,
    ) => Effect.Effect<FactoryRevisionUxEvidence, FactoryError>;
  }
>()("t3/factory/FactoryPreviewService") {}

export const layer = Layer.effect(
  FactoryPreviewService,
  Effect.gen(function* () {
    const store = yield* FactoryStore.FactoryStore;
    const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
    const evidence = yield* FactoryPreviewEvidence.FactoryPreviewEvidence;
    const stop = (instanceId: string) =>
      Effect.gen(function* () {
        const closed = yield* evidence.close(instanceId).pipe(Effect.result);
        const stopped = yield* runtime.stop(instanceId).pipe(Effect.result);
        if (Result.isFailure(closed)) return yield* closed.failure;
        if (Result.isFailure(stopped)) return yield* stopped.failure;
        return stopped.success;
      });
    const reconcile = Effect.gen(function* () {
      const state = yield* store.snapshot;
      let firstFailure: FactoryError | undefined;
      for (const assignment of state.assignments) {
        for (const revision of assignment.delivery?.revisions ?? []) {
          const preview = revision.preview;
          // A failed start may have left containers behind when its own cleanup failed too.
          if (!preview || !["starting", "ready", "stopping", "failed"].includes(preview.status))
            continue;
          if (previewIsCurrent(state, assignment, revision)) continue;
          const stopped = yield* stop(preview.instanceId).pipe(Effect.result);
          if (Result.isFailure(stopped)) {
            firstFailure ??= stopped.failure;
            continue;
          }
          yield* store.commit({
            actor: { kind: "system" },
            now: DateTime.formatIso(yield* DateTime.now),
            command: {
              type: "delivery.preview.recorded",
              commandId: CommandId.make(`preview-stopped:${preview.instanceId}`),
              assignmentId: assignment.id,
              revisionId: revision.id,
              instanceId: preview.instanceId,
              status: "stopped",
            },
          });
        }
      }
      if (firstFailure) return yield* firstFailure;
    });
    return FactoryPreviewService.of({
      reconcile,
      invoke: (threadId, input) => evidence.invoke({ ...input, threadId }),
      finish: Effect.fn("FactoryPreviewService.finish")(function* (threadId, input) {
        const sealed = yield* evidence.finish({ ...input, threadId });
        const state = yield* store.snapshot;
        const assignment = state.assignments.find((entry) =>
          entry.delivery?.revisions.some(
            (revision) =>
              revision.preview?.instanceId === input.instanceId &&
              revision.preview.threadId === threadId,
          ),
        );
        const revision = assignment?.delivery?.revisions.find(
          (entry) => entry.id === assignment.delivery?.currentRevisionId,
        );
        if (!assignment || !revision || revision.preview?.instanceId !== input.instanceId)
          return yield* new FactoryError({
            code: "permission-denied",
            detail: "This candidate preview is no longer current.",
          });
        yield* store.commit({
          actor: { kind: "system" },
          now: DateTime.formatIso(yield* DateTime.now),
          command: {
            type: "delivery.ux.recorded",
            commandId: CommandId.make(`factory-ux:${input.commandId}`),
            assignmentId: assignment.id,
            revisionId: revision.id,
            evidence: sealed,
          },
        });
        return sealed;
      }),
      handle: Effect.fn("FactoryPreviewService.handle")(function* (pending) {
        const intent = pending.intent;
        if (intent.type !== "delivery.preview.start" && intent.type !== "delivery.preview.stop")
          return;
        const state = yield* store.snapshot;
        const assignment = state.assignments.find((entry) => entry.id === intent.assignmentId);
        const revision = assignment?.delivery?.revisions.find(
          (entry) => entry.id === intent.revisionId,
        );
        const preview = revision?.preview;
        if (!assignment || !revision || !preview || preview.instanceId !== intent.instanceId) {
          if (pending.attempts > 0) yield* stop(intent.instanceId);
          yield* store.retireEffect(pending.id);
          return;
        }
        if (
          intent.type === "delivery.preview.start" &&
          ["stopping", "stopped"].includes(preview.status)
        ) {
          yield* stop(intent.instanceId);
          yield* store.retireEffect(pending.id);
          return;
        }
        const obsolete =
          assignment.outcome !== undefined ||
          assignment.status === "complete" ||
          assignment.delivery?.currentRevisionId !== revision.id;
        // Only a live start waits out a block; stopping and retiring obsolete work always proceed.
        if (
          intent.type === "delivery.preview.start" &&
          !obsolete &&
          (factoryIncidentBlocked(state, assignment.id, "preview") ??
            factoryExecutionBlocked(state, {
              threadId: preview.threadId,
              assignmentId: assignment.id,
              managerId: assignment.managerId,
              projectId: assignment.projectId,
              ancestorThreadIds: [],
            }))
        )
          return;
        yield* store.beginEffect(pending.id);
        const result = yield* (
          intent.type === "delivery.preview.stop" || obsolete
            ? stop(intent.instanceId)
            : revision.candidateId && assignment.grant
              ? runtime.start({
                  instanceId: intent.instanceId,
                  assignmentId: assignment.id,
                  candidateId: revision.candidateId,
                  reviewThreadId: preview.threadId,
                  configurationId: preview.configurationId,
                  expectedEpoch: assignment.grant.epoch,
                })
              : Effect.fail(new FactoryError({ code: "invalid-state" }))
        ).pipe(Effect.result);
        if (obsolete) {
          if (Result.isFailure(result)) return yield* result.failure;
          yield* store.retireEffect(pending.id);
          return;
        }
        const fresh = yield* store.snapshot;
        const current = fresh.assignments.find((entry) => entry.id === assignment.id);
        const currentRevision = current?.delivery?.revisions.find(
          (entry) => entry.id === revision.id,
        );
        if (!current || !currentRevision || !previewIsCurrent(fresh, current, currentRevision)) {
          yield* stop(intent.instanceId);
          yield* store.finishEffect({
            id: pending.id,
            now: DateTime.formatIso(yield* DateTime.now),
            command: {
              type: "delivery.preview.recorded",
              commandId: CommandId.make(`${pending.id}:receipt`),
              assignmentId: assignment.id,
              revisionId: revision.id,
              instanceId: intent.instanceId,
              status: "stopped",
            },
          });
          return;
        }
        yield* store.finishEffect({
          id: pending.id,
          now: DateTime.formatIso(yield* DateTime.now),
          command: {
            type: "delivery.preview.recorded",
            commandId: CommandId.make(`${pending.id}:receipt`),
            assignmentId: assignment.id,
            revisionId: revision.id,
            instanceId: intent.instanceId,
            status: Result.isFailure(result)
              ? "failed"
              : intent.type === "delivery.preview.stop"
                ? "stopped"
                : "ready",
            ...(Result.isFailure(result)
              ? { error: result.failure.detail ?? result.failure.message }
              : result.success?.origin
                ? { origin: result.success.origin }
                : {}),
          },
        });
      }),
    });
  }),
);
