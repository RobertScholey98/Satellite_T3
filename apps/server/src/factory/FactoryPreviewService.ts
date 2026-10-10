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
import { FactoryPreviewExecution } from "./FactoryPreviewExecution.ts";
import { FactoryPreviewEvidence } from "./FactoryPreviewEvidence.ts";
import { FactoryStore, type PendingFactoryEffect } from "./FactoryStore.ts";
import { factoryExecutionBlocked } from "./FactoryControls.ts";

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
    !factoryExecutionBlocked(state, {
      threadId: preview.threadId,
      assignmentId: assignment.id,
      managerId: assignment.managerId,
      projectId: assignment.projectId,
      ancestorThreadIds: [],
    })
  );
};

export class FactoryPreviewService extends Context.Service<
  FactoryPreviewService,
  {
    readonly reconcile: Effect.Effect<void, FactoryError>;
    readonly handle: (pending: PendingFactoryEffect) => Effect.Effect<void, FactoryError>;
    readonly invoke: (
      threadId: ThreadId,
      input: FactoryPreviewActionInput,
    ) => Effect.Effect<FactoryPreviewActionResult, FactoryError>;
    readonly finish: (
      threadId: ThreadId,
      input: FactoryPreviewFinishInput,
    ) => Effect.Effect<FactoryRevisionUxEvidence, FactoryError>;
  }
>()("t3/factory/FactoryPreviewService") {}

export const layer = Layer.effect(
  FactoryPreviewService,
  Effect.gen(function* () {
    const store = yield* FactoryStore;
    const runtime = yield* FactoryPreviewExecution;
    const evidence = yield* FactoryPreviewEvidence;
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
      for (const assignment of state.assignments) {
        for (const revision of assignment.delivery?.revisions ?? []) {
          const preview = revision.preview;
          if (!preview || !["starting", "ready", "stopping"].includes(preview.status)) continue;
          if (previewIsCurrent(state, assignment, revision)) continue;
          yield* stop(preview.instanceId);
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
        if (
          intent.type === "delivery.preview.start" &&
          !obsolete &&
          factoryExecutionBlocked(state, {
            threadId: preview.threadId,
            assignmentId: assignment.id,
            managerId: assignment.managerId,
            projectId: assignment.projectId,
            ancestorThreadIds: [],
          })
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
