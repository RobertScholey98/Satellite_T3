import type { FactoryAssignment, FactorySnapshot } from "@t3tools/contracts";

/**
 * Whether a shared-work assignment is really the system manager's: its repository, project and
 * manager all match, and the experiment or commissioned work record points back at this exact
 * assignment. Revoked work still counts as owned, so access checks keep scoping the team to its
 * record after authority is withdrawn. Use `factorySharedAssignmentEnabled` to ask whether the
 * team may still work.
 */
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

/**
 * Whether an owned shared-work assignment may run now. The human can withdraw this at three
 * levels: disabling the repository, disabling experiments, or revoking the work.
 */
export function factorySharedAssignmentEnabled(
  state: FactorySnapshot,
  assignment: FactoryAssignment,
): boolean {
  if (!factorySharedAssignmentOwned(state, assignment)) return false;
  const purpose = assignment.sharedWork!;
  if (!state.sharedRepositories.some((entry) => entry.id === purpose.repositoryId && entry.enabled))
    return false;
  if (purpose.kind === "experiment") return state.experimentConfigurations.at(-1)?.enabled === true;
  return state.sharedWorks.some(
    (entry) => entry.id === purpose.workId && entry.lifecycle.phase === "commissioned",
  );
}
