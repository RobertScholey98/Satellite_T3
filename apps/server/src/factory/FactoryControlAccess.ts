import {
  FactoryError,
  type OrchestrationV2ConversationMessage,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { factoryAuxiliaryIsCurrent } from "./FactoryAuxiliary.ts";
import { factorySharedAssignmentOwned } from "./FactoryWorkflowOwnership.ts";
import { factoryRequestParticipants } from "./FactoryCollaboration.ts";
import * as FactoryStore from "./FactoryStore.ts";
import {
  factoryDirectionBlocked,
  factoryExecutionBlocked,
  type FactoryControlMembership,
} from "./FactoryControls.ts";

export function factoryDirectionSender(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "senderThreadId" | "scheduledTaskId"
  >,
): ThreadId | null | undefined {
  return message.createdBy === "user" &&
    message.senderThreadId === undefined &&
    message.scheduledTaskId === undefined
    ? undefined
    : (message.senderThreadId ?? null);
}

export class FactoryControlAccess extends Context.Service<
  FactoryControlAccess,
  {
    readonly membership: (
      threadId: ThreadId,
      pendingParentThreadId?: ThreadId,
    ) => Effect.Effect<FactoryControlMembership | undefined, FactoryError>;
    readonly assertExecution: (
      threadId: ThreadId,
      pendingParentThreadId?: ThreadId,
    ) => Effect.Effect<void, FactoryError>;
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
  const membership = Effect.fn("FactoryControlAccess.membership")(function* (
    requestedThreadId: ThreadId,
    pendingParentThreadId?: ThreadId,
  ) {
    const state = yield* store.snapshot;
    const visited = new Set<ThreadId>();
    const ancestors: ThreadId[] = [];
    let threadId = requestedThreadId;
    let projectId: ProjectId | undefined;
    for (;;) {
      if (visited.has(threadId) || visited.size >= 64)
        return yield* new FactoryError({ code: "execution-unavailable" });
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
          ancestorThreadIds:
            auxiliary?.kind === "delivery-review" && assignment !== undefined
              ? [assignment.threadId, ...ancestors.toReversed()]
              : ancestors.toReversed(),
        } satisfies FactoryControlMembership;
      }
      const thread = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
      if (thread === null && visited.size === 1) {
        if (pendingParentThreadId === undefined) return undefined;
        threadId = pendingParentThreadId;
        ancestors.push(threadId);
        continue;
      }
      if (
        thread === null ||
        thread.deletedAt !== null ||
        (projectId !== undefined && projectId !== thread.projectId)
      )
        return yield* new FactoryError({ code: "execution-unavailable" });
      projectId = thread.projectId;
      if (thread.lineage.parentThreadId === null) {
        if (thread.lineage.relationshipToParent === "subagent")
          return yield* new FactoryError({ code: "execution-unavailable" });
        return undefined;
      }
      threadId = thread.lineage.parentThreadId;
      ancestors.push(threadId);
    }
  });
  const check = Effect.fn("FactoryControlAccess.check")(function* (
    threadId: ThreadId,
    direction: boolean,
    senderThreadId?: ThreadId | null,
    pendingParentThreadId?: ThreadId,
  ) {
    const member = yield* membership(threadId, pendingParentThreadId);
    if (member === undefined) return;
    const state = yield* store.snapshot;
    const lineage = new Set([...member.ancestorThreadIds, member.threadId]);
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
    if (direction && senderThreadId != null && member.assignmentId !== undefined) {
      const source = state.assignments.find(
        (entry) =>
          entry.threadId === senderThreadId ||
          entry.previousLeadThreadIds?.includes(senderThreadId),
      );
      if (source && source.projectId !== member.projectId) {
        const authorized =
          source.threadId === senderThreadId &&
          source.outcome === undefined &&
          source.status !== "complete" &&
          (source.completion === undefined || source.completion.phase === "collecting") &&
          source.wait?.kind !== "authority" &&
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
          state.crossProjectRequests.some((request) => {
            const participants = factoryRequestParticipants(state, request);
            return (
              participants.some((entry) => entry.id === source.id) &&
              participants.some(
                (entry) => entry.id === member.assignmentId && entry.threadId === threadId,
              )
            );
          });
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
