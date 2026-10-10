import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  FactoryAssignment,
  FactoryControl,
  FactorySnapshot,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

type ThreadLineage = Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId" | "lineage">;

/** Resolve app-owned descendants without crossing an environment or project boundary. */
export function factoryThreadMembership(
  snapshot: FactorySnapshot,
  threadRef: ScopedThreadRef,
  threads: readonly ThreadLineage[],
) {
  const byId = new Map(
    threads
      .filter((thread) => thread.environmentId === threadRef.environmentId)
      .map((thread) => [thread.id, thread]),
  );
  const requested = byId.get(threadRef.threadId);
  if (!requested) return null;
  const visited = new Set<ThreadId>();
  const ancestors: ThreadId[] = [];
  let threadId: ThreadId | null = requested.id;
  while (threadId !== null && !visited.has(threadId) && visited.size < 64) {
    visited.add(threadId);
    const thread = byId.get(threadId);
    if (!thread || thread.projectId !== requested.projectId) return null;
    const auxiliary = snapshot.auxiliaryThreads.find((entry) => entry.threadId === threadId);
    const assignment = snapshot.assignments.find(
      (entry) => entry.threadId === threadId || entry.id === auxiliary?.assignmentId,
    );
    const manager = snapshot.managers.find((entry) =>
      assignment ? entry.id === assignment.managerId : entry.threadId === threadId,
    );
    if (assignment && !manager) return null;
    if (manager) {
      if (
        manager.projectId !== requested.projectId ||
        (assignment && assignment.projectId !== requested.projectId)
      )
        return null;
      return {
        manager,
        assignment,
        auxiliary,
        ancestorThreadIds:
          auxiliary?.kind === "delivery-review" && assignment
            ? [...ancestors, assignment.threadId]
            : ancestors,
      };
    }
    threadId = thread.lineage.parentThreadId;
    if (threadId !== null) ancestors.push(threadId);
  }
  return null;
}

export function factoryAssignmentCancellation(
  snapshot: FactorySnapshot | null,
  assignment: FactoryAssignment,
) {
  return snapshot?.controls?.find(
    (control): control is Extract<FactoryControl, { kind: "cancellation" }> =>
      control.kind === "cancellation" && control.assignmentId === assignment.id,
  );
}

export function factoryManagerPause(snapshot: FactorySnapshot | null, managerId: ThreadId) {
  return snapshot?.controls?.find(
    (control): control is Extract<FactoryControl, { kind: "manager-pause" }> =>
      control.kind === "manager-pause" &&
      control.managerId === managerId &&
      control.status === "active",
  );
}

export function factoryProjectPause(snapshot: FactorySnapshot | null, projectId: ProjectId | null) {
  return snapshot?.controls?.find(
    (control): control is Extract<FactoryControl, { kind: "project-pause" }> =>
      control.kind === "project-pause" &&
      control.projectId === projectId &&
      control.status === "active",
  );
}

export function factoryAssignmentStatus(
  snapshot: FactorySnapshot | null,
  assignment: FactoryAssignment,
) {
  const cancellation = factoryAssignmentCancellation(snapshot, assignment);
  if (cancellation) {
    if (cancellation.stop.status === "pending") return "Cancelling · stopping team";
    if (cancellation.stop.status === "failed") return "Cancellation · stop failed";
    return cancellation.reason ? "Cancelled" : "Cancelled · reason needed";
  }
  const projectPause = factoryProjectPause(snapshot, assignment.projectId);
  if (projectPause && assignment.status !== "complete")
    return `Project: ${factoryPauseStatus(projectPause)}`;
  return {
    pending: "Preparing",
    running: "Working",
    waiting: "Waiting",
    complete: "Complete",
  }[assignment.status];
}

export function factoryPauseStatus(
  control: Extract<FactoryControl, { kind: "manager-pause" | "project-pause" }>,
) {
  if (control.resume?.status === "pending") return "Resuming";
  if (control.resume?.status === "failed") return "Resume failed";
  if (control.stop.status === "pending") return "Stopping";
  if (control.stop.status === "failed") return "Stop failed";
  return "Paused";
}
