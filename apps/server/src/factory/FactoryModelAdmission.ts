import {
  FactoryError,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { isFactoryModelApproved, resolveFactoryModelPolicy } from "./FactoryModelPolicy.ts";

export class FactoryModelAdmission extends Context.Service<
  FactoryModelAdmission,
  {
    readonly assertSelectionFor: (
      threadId: ThreadId,
      selection: ModelSelection,
      pendingParentThreadId?: ThreadId,
    ) => Effect.Effect<void, FactoryError>;
    readonly assertDelegationFor: (
      parentThreadId: ThreadId,
      selection: ModelSelection,
    ) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryModelAdmission") {}

const make = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const check = Effect.fn("FactoryModelAdmission.check")(function* (
    requestedThreadId: ThreadId,
    selection: ModelSelection,
    delegating: boolean,
    pendingParentThreadId?: ThreadId,
  ) {
    const state = yield* store.snapshot;
    const visited = new Set<ThreadId>();
    let threadId = requestedThreadId;
    let projectId: ProjectId | undefined;
    for (;;) {
      if (visited.has(threadId) || visited.size >= 64) {
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail: "The thread's engineering assignment could not be resolved.",
        });
      }
      visited.add(threadId);
      const manager = state.managers.find((entry) => entry.threadId === threadId);
      const auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === threadId);
      const assignment = state.assignments.find(
        (entry) =>
          entry.threadId === threadId ||
          entry.previousLeadThreadIds?.includes(threadId) ||
          entry.id === auxiliary?.assignmentId,
      );
      if (manager !== undefined || assignment !== undefined) {
        const owner = manager ?? state.managers.find((entry) => entry.id === assignment?.managerId);
        if (
          owner === undefined ||
          (projectId !== undefined && projectId !== (assignment?.projectId ?? owner.projectId)) ||
          (assignment !== undefined && assignment.projectId !== owner.projectId)
        ) {
          return yield* new FactoryError({ code: "execution-unavailable" });
        }
        if (assignment?.previousLeadThreadIds?.includes(threadId))
          return yield* new FactoryError({
            code: "permission-denied",
            detail: "The replaced lead cannot restart or delegate work.",
          });
        if (
          auxiliary !== undefined &&
          (delegating ||
            threadId !== requestedThreadId ||
            !modelSelectionsEqual(auxiliary.modelSelection, selection))
        )
          return yield* new FactoryError({
            code: "permission-denied",
            detail:
              "Diagnosis uses its approved independent model and cannot delegate implementation.",
          });
        if (manager !== undefined || assignment?.kind === "onboarding") {
          if (
            !delegating &&
            threadId === requestedThreadId &&
            modelSelectionsEqual(owner.modelSelection, selection)
          )
            return;
          return yield* new FactoryError({
            code: "permission-denied",
            detail:
              "Manager and onboarding threads can use only their explicitly approved discovery model.",
          });
        }
        const current = resolveFactoryModelPolicy(
          state.modelDefaults,
          owner.modelOverrides,
          owner.modelSelection,
        );
        if (
          assignment?.modelPolicy !== undefined &&
          isFactoryModelApproved(assignment.modelPolicy, selection) &&
          isFactoryModelApproved(current, selection)
        )
          return;
        return yield* new FactoryError({
          code: "permission-denied",
          detail:
            "This model, provider account, or option is outside the assignment's current approved model grant.",
        });
      }
      const thread = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
      if (thread === null && visited.size === 1 && pendingParentThreadId !== undefined) {
        threadId = pendingParentThreadId;
        continue;
      }
      if (thread === null || thread.deletedAt !== null) {
        return yield* new FactoryError({ code: "execution-unavailable" });
      }
      if (projectId !== undefined && projectId !== thread.projectId) {
        return yield* new FactoryError({ code: "execution-unavailable" });
      }
      projectId = thread.projectId;
      if (thread.lineage.parentThreadId === null) {
        if (thread.lineage.relationshipToParent === "subagent") {
          return yield* new FactoryError({ code: "execution-unavailable" });
        }
        return;
      }
      threadId = thread.lineage.parentThreadId;
    }
  });

  return FactoryModelAdmission.of({
    assertSelectionFor: (threadId, selection, pendingParentThreadId) =>
      check(threadId, selection, false, pendingParentThreadId),
    assertDelegationFor: (threadId, selection) => check(threadId, selection, true),
  });
});

export const layer = Layer.effect(FactoryModelAdmission, make);
