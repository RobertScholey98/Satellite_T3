import {
  FactoryError,
  type OrchestrationV2ThreadShell,
  type FactorySnapshot,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export interface FactoryLineageMatch {
  /** The thread whose factory record matched: the requested thread or a subagent ancestor. */
  readonly threadId: ThreadId;
  /** Threads walked past the requested one, nearest first, ending at `threadId`. */
  readonly ancestorThreadIds: ReadonlyArray<ThreadId>;
  /** Project of the thread shells read on the way, if any were read. */
  readonly projectId: ProjectId | undefined;
  readonly manager: FactorySnapshot["managers"][number] | undefined;
  readonly assignment: FactorySnapshot["assignments"][number] | undefined;
  readonly auxiliary: FactorySnapshot["auxiliaryThreads"][number] | undefined;
}

type LineageShell = Pick<OrchestrationV2ThreadShell, "projectId" | "deletedAt" | "lineage">;

const unavailable = () => new FactoryError({ code: "execution-unavailable" });

function factoryProjectManaged(state: FactorySnapshot, projectId: ProjectId | undefined): boolean {
  return (
    projectId !== undefined &&
    (state.managers.some(
      (manager) =>
        (manager.role === "system" ? manager.workspaceProjectId : manager.projectId) === projectId,
    ) ||
      state.assignments.some((assignment) => assignment.projectId === projectId))
  );
}

/**
 * Finds the factory record that owns a thread by walking its subagent ancestry.
 * Returns undefined for ordinary threads. Every factory access check resolves through here.
 *
 * - With no managers nothing is managed, so it reads nothing.
 * - Forks are human-created, ordinary threads; the walk stops at a fork edge.
 * - A broken chain (deleted or missing ancestor, orphaned subagent, crossed project) is
 *   ordinary unless its project is managed, where it fails closed.
 */
export const resolveFactoryLineage = <E>(input: {
  readonly state: FactorySnapshot;
  readonly threadId: ThreadId;
  /** Parent of a thread that is being created and not yet projected. */
  readonly pendingParentThreadId?: ThreadId | undefined;
  readonly getThreadShell: (threadId: ThreadId) => Effect.Effect<LineageShell | null, E>;
}): Effect.Effect<FactoryLineageMatch | undefined, FactoryError | E> =>
  Effect.gen(function* () {
    const { state } = input;
    if (state.managers.length === 0) return undefined;
    const broken = (...projectIds: ReadonlyArray<ProjectId | undefined>) =>
      projectIds.some((projectId) => factoryProjectManaged(state, projectId))
        ? Effect.fail(unavailable())
        : Effect.succeed(undefined);
    const visited = new Set<ThreadId>();
    const ancestorThreadIds: ThreadId[] = [];
    let threadId = input.threadId;
    let projectId: ProjectId | undefined;
    for (;;) {
      if (visited.has(threadId) || visited.size >= 64) return yield* unavailable();
      visited.add(threadId);
      const manager = state.managers.find((entry) => entry.threadId === threadId);
      const auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === threadId);
      const assignment = state.assignments.find(
        (entry) =>
          entry.threadId === threadId ||
          entry.previousLeadThreadIds?.includes(threadId) ||
          entry.id === auxiliary?.assignmentId,
      );
      if (manager !== undefined || assignment !== undefined)
        return { threadId, ancestorThreadIds, projectId, manager, assignment, auxiliary };
      const thread = yield* input.getThreadShell(threadId);
      if (thread === null && visited.size === 1) {
        if (input.pendingParentThreadId === undefined) return undefined;
        threadId = input.pendingParentThreadId;
        ancestorThreadIds.push(threadId);
        continue;
      }
      if (thread === null || thread.deletedAt !== null)
        return yield* broken(projectId, thread?.projectId);
      if (projectId !== undefined && projectId !== thread.projectId)
        return yield* broken(projectId, thread.projectId);
      projectId = thread.projectId;
      if (thread.lineage.relationshipToParent === "fork") return undefined;
      if (thread.lineage.parentThreadId === null)
        return thread.lineage.relationshipToParent === "subagent"
          ? yield* broken(projectId)
          : undefined;
      threadId = thread.lineage.parentThreadId;
      ancestorThreadIds.push(threadId);
    }
  });
