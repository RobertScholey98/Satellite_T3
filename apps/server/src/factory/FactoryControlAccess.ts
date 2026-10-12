import { FactoryError, type FactorySnapshot, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { factoryAuxiliaryIsCurrent } from "./FactoryAuxiliary.ts";
import { factorySharedAssignmentOwned } from "./FactoryWorkflowOwnership.ts";
import { currentFactoryMergeOperation, factoryMergeFreezeBlocks } from "./FactoryMergeOperation.ts";
import {
  factoryIntegrationAccessBlocked,
  factoryIntegrationManifestReasons,
} from "./FactoryIntegration.ts";
import { factoryRequestParticipants } from "./FactoryCollaboration.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { resolveFactoryLineage } from "./FactoryLineage.ts";
import {
  factoryDirectionBlocked,
  factoryExecutionBlocked,
  type FactoryControlMembership,
} from "./FactoryControls.ts";

/**
 * Answers which factory record a thread belongs to and whether it may run or be directed now.
 * The governance seams, the MCP guard and the factory's own workers ask here. An ordinary
 * thread resolves to `undefined` and every check passes. `pendingParentThreadId` resolves a
 * subagent that is not projected yet through its parent.
 */
export class FactoryControlAccess extends Context.Service<
  FactoryControlAccess,
  {
    /**
     * The thread's manager, assignment, auxiliary role and ancestors. Fails with
     * `execution-unavailable` when the lineage is broken inside a managed project or points at a
     * record its owner does not hold.
     */
    readonly membership: (
      threadId: ThreadId,
      pendingParentThreadId?: ThreadId,
    ) => Effect.Effect<FactoryControlMembership | undefined, FactoryError>;
    /** Fails with `permission-denied` and the reason when the thread may not run now. */
    readonly assertExecution: (
      threadId: ThreadId,
      pendingParentThreadId?: ThreadId,
    ) => Effect.Effect<void, FactoryError>;
    /**
     * Execution plus who may direct the thread. `senderThreadId` is the directing thread, `null`
     * for the human or host; omitting it checks execution only.
     */
    readonly assertDirection: (input: {
      readonly threadId: ThreadId;
      readonly senderThreadId?: ThreadId | null | undefined;
      readonly pendingParentThreadId?: ThreadId;
    }) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryControlAccess") {}

const make = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const resolve = (
    state: FactorySnapshot,
    requestedThreadId: ThreadId,
    pendingParentThreadId?: ThreadId,
  ) =>
    Effect.gen(function* () {
      const match = yield* resolveFactoryLineage({
        state,
        threadId: requestedThreadId,
        pendingParentThreadId,
        getThreadShell: (threadId) =>
          projections
            .getThreadShell(threadId)
            .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause }))),
      });
      if (match === undefined) return undefined;
      const { manager, assignment, auxiliary, projectId } = match;
      const owner = manager ?? state.managers.find((entry) => entry.id === assignment?.managerId);
      // Fail closed when the record does not hang together: a system manager's subagent, a
      // thread in another project than its record, or an assignment outside its manager's remit.
      if (
        owner === undefined ||
        (owner.role === "system" &&
          assignment === undefined &&
          requestedThreadId !== owner.threadId) ||
        (projectId !== undefined &&
          projectId !==
            (assignment?.projectId ??
              (owner.role === "system" ? owner.workspaceProjectId : owner.projectId))) ||
        (assignment !== undefined &&
          (owner.role === "system"
            ? !factorySharedAssignmentOwned(state, assignment)
            : assignment.projectId !== owner.projectId))
      )
        return yield* new FactoryError({ code: "execution-unavailable" });
      return {
        threadId: requestedThreadId,
        managerId: owner.id,
        projectId:
          assignment?.projectId ??
          (owner.role === "system" ? owner.workspaceProjectId : owner.projectId),
        managerRole: owner.role,
        ...(assignment === undefined ? {} : { assignmentId: assignment.id }),
        ...(auxiliary === undefined ? {} : { auxiliaryThreadId: auxiliary.threadId }),
        // Root first. A delivery review counts its lead as an ancestor, so controls on the lead,
        // such as a takeover, also cover the review.
        ancestorThreadIds:
          auxiliary?.kind === "delivery-review" && assignment !== undefined
            ? [assignment.threadId, ...match.ancestorThreadIds.toReversed()]
            : match.ancestorThreadIds.toReversed(),
      } satisfies FactoryControlMembership;
    });
  const membership = Effect.fn("FactoryControlAccess.membership")(function* (
    threadId: ThreadId,
    pendingParentThreadId?: ThreadId,
  ) {
    return yield* resolve(yield* store.snapshot, threadId, pendingParentThreadId);
  });
  const check = Effect.fn("FactoryControlAccess.check")(function* (
    threadId: ThreadId,
    direction: boolean,
    senderThreadId?: ThreadId | null,
    pendingParentThreadId?: ThreadId,
  ) {
    const state = yield* store.snapshot;
    const member = yield* resolve(state, threadId, pendingParentThreadId);
    if (member === undefined) return;
    const lineage = new Set([...member.ancestorThreadIds, member.threadId]);
    // A shared merge freezes its integration team (its retrospective still runs), and a replaced
    // lead's whole lineage stops for good.
    const owner = state.assignments.find((entry) => entry.id === member.assignmentId);
    const auxiliary = state.auxiliaryThreads.find(
      (entry) => entry.threadId === member.auxiliaryThreadId,
    );
    if (
      owner &&
      auxiliary?.kind !== "retrospective" &&
      factoryMergeFreezeBlocks(state, owner, member.threadId)
    )
      return yield* new FactoryError({
        code: "permission-denied",
        detail: "The shared merge operation has frozen this integration team.",
      });
    if (
      state.assignments.some((entry) => entry.previousLeadThreadIds?.some((id) => lineage.has(id)))
    )
      return yield* new FactoryError({
        code: "permission-denied",
        detail:
          "This lead was replaced. Its evidence is preserved, but execution belongs to the current lead.",
      });
    if (member.auxiliaryThreadId !== undefined) {
      const auxiliary = state.auxiliaryThreads.find(
        (entry) => entry.threadId === member.auxiliaryThreadId,
      );
      const assignment = state.assignments.find((entry) => entry.id === member.assignmentId);
      if (
        member.threadId !== member.auxiliaryThreadId ||
        auxiliary === undefined ||
        !factoryAuxiliaryIsCurrent(assignment, auxiliary, state.retros)
      )
        return yield* new FactoryError({
          code: "permission-denied",
          detail:
            "Only the current independent review or retrospective can run. A completed or superseded conversation cannot resume or create a team.",
        });
    }
    // Auxiliary threads (diagnosis, review, retrospective) report; they never direct another
    // thread.
    if (
      direction &&
      senderThreadId != null &&
      senderThreadId !== threadId &&
      state.auxiliaryThreads.some((entry) => entry.threadId === senderThreadId)
    )
      return yield* new FactoryError({
        code: "permission-denied",
        detail: "Independent diagnosis can report findings but cannot direct implementation work.",
      });
    // A lead may direct another team's lead only across a live edge: an accepted cross-project
    // request between the current leads, or a ready, unheld integration it leads or joins.
    // The sending team must itself be free to act. Same-project, non-integration peers skip this.
    if (direction && senderThreadId != null && member.assignmentId !== undefined) {
      const source = state.assignments.find(
        (entry) =>
          entry.threadId === senderThreadId ||
          entry.previousLeadThreadIds?.includes(senderThreadId),
      );
      const targetAssignment = state.assignments.find((entry) => entry.id === member.assignmentId);
      if (
        source &&
        source.id !== member.assignmentId &&
        (source.projectId !== member.projectId ||
          source.integrationId !== undefined ||
          targetAssignment?.integrationId !== undefined)
      ) {
        const authorized =
          source.threadId === senderThreadId &&
          source.outcome === undefined &&
          source.status !== "complete" &&
          (source.completion === undefined || source.completion.phase === "collecting") &&
          source.wait?.kind !== "authority" &&
          (!source.integrationId || !currentFactoryMergeOperation(state, source.integrationId)) &&
          factoryDirectionBlocked(
            state,
            {
              assignmentId: source.id,
              managerId: source.managerId,
              projectId: source.projectId,
              threadId: source.threadId,
              ancestorThreadIds: [],
            },
            null,
          ) === undefined &&
          !state.controls.some(
            (control) =>
              control.kind === "takeover" &&
              control.status === "active" &&
              lineage.has(control.threadId),
          ) &&
          (state.crossProjectRequests.some((request) => {
            const participants = factoryRequestParticipants(state, request);
            return (
              participants.some((entry) => entry.id === source.id) &&
              participants.some(
                (entry) => entry.id === member.assignmentId && entry.threadId === threadId,
              )
            );
          }) ||
            state.integrations.some((integration) => {
              const target = state.assignments.find(
                (entry) => entry.id === member.assignmentId && entry.threadId === threadId,
              );
              const integrationEdge =
                (source.id === integration.assignmentId &&
                  target !== undefined &&
                  integration.participantAssignmentIds.includes(target.id)) ||
                (target?.id === integration.assignmentId &&
                  integration.participantAssignmentIds.includes(source.id));
              const prepared = state.integrationPreparations.find(
                (entry) => entry.id === integration.currentPreparationId,
              )?.lifecycle;
              return (
                integrationEdge &&
                integration.hold === null &&
                factoryIntegrationAccessBlocked(state, integration.id) === null &&
                prepared?.phase === "ready" &&
                factoryIntegrationManifestReasons(state, integration.id, prepared.manifest)
                  .length === 0
              );
            }));
        if (!authorized)
          return yield* new FactoryError({
            code: "permission-denied",
            detail:
              "This peer message no longer belongs to an accepted request between the current leads.",
          });
      }
    }
    const reason = direction
      ? factoryDirectionBlocked(state, member, senderThreadId)
      : factoryExecutionBlocked(state, member);
    if (reason !== undefined)
      return yield* new FactoryError({ code: "permission-denied", detail: reason });
  });
  return FactoryControlAccess.of({
    membership,
    assertExecution: (threadId, pendingParentThreadId) =>
      check(threadId, false, undefined, pendingParentThreadId),
    assertDirection: (input) =>
      check(input.threadId, true, input.senderThreadId, input.pendingParentThreadId),
  });
});

export const layer = Layer.effect(FactoryControlAccess, make);
