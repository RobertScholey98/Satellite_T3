import { FactoryError, type ModelSelection, type ThreadId } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { isFactoryModelApproved, resolveFactoryModelPolicy } from "./FactoryModelPolicy.ts";
import { factoryAuxiliaryIsCurrent } from "./FactoryAuxiliary.ts";
import { factorySharedAssignmentOwned } from "./FactoryWorkflowOwnership.ts";
import { factoryMergeFreezeBlocks } from "./FactoryMergeOperation.ts";
import { resolveFactoryLineage } from "./FactoryLineage.ts";

/**
 * Decides which model a factory thread may run or delegate to. `FactoryExecution` exposes it as
 * the `ThreadGovernance` model checks and to the factory's own effects. Ordinary threads always
 * pass. It governs supported delegation paths only, not spend: a shell command in the container
 * can still reach a model directly.
 */
export class FactoryModelAdmission extends Context.Service<
  FactoryModelAdmission,
  {
    /**
     * Admits `selection` for work in the thread itself. Pass `pendingParentThreadId` for a child
     * that is not projected yet.
     */
    readonly assertSelectionFor: (
      threadId: ThreadId,
      selection: ModelSelection,
      pendingParentThreadId?: ThreadId,
    ) => Effect.Effect<void, FactoryError>;
    /**
     * Admits `selection` for work delegated from `parentThreadId`. Manager, onboarding and
     * auxiliary threads can never delegate.
     */
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
    const match = yield* resolveFactoryLineage({
      state,
      threadId: requestedThreadId,
      pendingParentThreadId,
      getThreadShell: (threadId) =>
        projections
          .getThreadShell(threadId)
          .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause }))),
    });
    if (match === undefined) return;
    const { threadId, projectId, manager, assignment, auxiliary } = match;
    const owner = manager ?? state.managers.find((entry) => entry.id === assignment?.managerId);
    // A missing owner, or a thread, assignment and manager that disagree on the project, fails
    // closed rather than falling back to an ordinary thread.
    if (
      owner === undefined ||
      (projectId !== undefined &&
        projectId !==
          (assignment?.projectId ??
            (owner.role === "system" ? owner.workspaceProjectId : owner.projectId))) ||
      (assignment !== undefined &&
        (owner.role === "system"
          ? !factorySharedAssignmentOwned(state, assignment)
          : assignment.projectId !== owner.projectId))
    ) {
      return yield* new FactoryError({ code: "execution-unavailable" });
    }
    if (assignment?.previousLeadThreadIds?.includes(threadId))
      return yield* new FactoryError({
        code: "permission-denied",
        detail: "The replaced lead cannot restart or delegate work.",
      });
    if (
      assignment &&
      auxiliary?.kind !== "retrospective" &&
      factoryMergeFreezeBlocks(state, assignment, delegating ? undefined : requestedThreadId)
    )
      return yield* new FactoryError({
        code: "permission-denied",
        detail: "The shared merge operation has frozen this integration team.",
      });
    if (
      auxiliary !== undefined &&
      (delegating ||
        threadId !== requestedThreadId ||
        (auxiliary.kind === "retrospective" &&
          !factoryAuxiliaryIsCurrent(assignment, auxiliary, state.retros)) ||
        !modelSelectionsEqual(auxiliary.modelSelection, selection))
    )
      return yield* new FactoryError({
        code: "permission-denied",
        detail:
          "Independent review and retrospective conversations use their approved model and cannot delegate implementation.",
      });
    // Manager and onboarding threads run only on the manager's own model, and only in that
    // thread; their subagents are refused. A system manager's model must also still be approved
    // by its current policy.
    if (manager !== undefined || assignment?.kind === "onboarding") {
      if (
        !delegating &&
        threadId === requestedThreadId &&
        modelSelectionsEqual(owner.modelSelection, selection) &&
        (owner.role !== "system" ||
          isFactoryModelApproved(
            resolveFactoryModelPolicy(
              state.modelDefaults,
              owner.modelOverrides,
              owner.modelSelection,
            ),
            selection,
          ))
      )
        return;
      return yield* new FactoryError({
        code: "permission-denied",
        detail:
          "Manager and onboarding threads can use only their explicitly approved discovery model.",
      });
    }
    // Team work needs the model in both the assignment's pinned grant and the manager's current
    // policy, so withdrawing a model takes effect without rewriting the assignment.
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
  });

  return FactoryModelAdmission.of({
    assertSelectionFor: (threadId, selection, pendingParentThreadId) =>
      check(threadId, selection, false, pendingParentThreadId),
    assertDelegationFor: (threadId, selection) => check(threadId, selection, true),
  });
});

export const layer = Layer.effect(FactoryModelAdmission, make);
