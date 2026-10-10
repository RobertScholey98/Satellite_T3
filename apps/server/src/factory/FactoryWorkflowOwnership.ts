import type { FactoryAssignment, FactorySnapshot } from "@t3tools/contracts";

export function factorySharedAssignmentOwned(
  state: FactorySnapshot,
  assignment: FactoryAssignment,
): boolean {
  const purpose = assignment.sharedWork;
  if (!purpose) return false;
  const repository = state.sharedRepositories.find((entry) => entry.id === purpose.repositoryId);
  if (
    !repository ||
    repository.projectId !== assignment.projectId ||
    repository.managerId !== assignment.managerId ||
    !state.managers.some((entry) => entry.id === assignment.managerId && entry.role === "system")
  )
    return false;
  if (purpose.kind === "experiment")
    return state.workflowExperiments.some(
      (entry) =>
        entry.id === purpose.experimentId &&
        entry.assignmentId === assignment.id &&
        entry.managerId === assignment.managerId &&
        entry.repositoryId === repository.id,
    );
  return state.sharedWorks.some(
    (entry) =>
      entry.id === purpose.workId &&
      entry.managerId === assignment.managerId &&
      entry.plan.repositoryId === repository.id &&
      (entry.lifecycle.phase === "commissioned" || entry.lifecycle.phase === "revoked") &&
      entry.lifecycle.assignmentId === assignment.id,
  );
}

export function factorySharedAssignmentEnabled(
  state: FactorySnapshot,
  assignment: FactoryAssignment,
): boolean {
  if (!factorySharedAssignmentOwned(state, assignment)) return false;
  const purpose = assignment.sharedWork!;
  if (!state.sharedRepositories.some((entry) => entry.id === purpose.repositoryId && entry.enabled))
    return false;
  if (purpose.kind === "experiment") {
    if (!state.experimentConfigurations.at(-1)?.enabled) return false;
  } else if (
    !state.sharedWorks.some(
      (entry) => entry.id === purpose.workId && entry.lifecycle.phase === "commissioned",
    )
  )
    return false;
  return !factoryWorkflowRestartPending(state, assignment.id);
}

export function factoryWorkflowRestartPending(
  state: FactorySnapshot,
  assignmentId: FactoryAssignment["id"],
): boolean {
  const migration = state.workflowMigrations.findLast(
    (entry) => entry.assignmentId === assignmentId,
  );
  return migration !== undefined && migration.lifecycle.phase !== "ready";
}
