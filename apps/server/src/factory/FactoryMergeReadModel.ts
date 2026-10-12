import type { FactoryAssignmentId, FactorySnapshot, ProjectId, ThreadId } from "@t3tools/contracts";

export type FactoryMergeReadScope =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "manager"; readonly managerId: ThreadId }
  | { readonly kind: "assignment"; readonly assignmentId: FactoryAssignmentId };

/**
 * The merge groups, reviews and operations a project, manager or assignment view may see: every
 * group whose integration lead or any member is in scope, so each side sees the whole group.
 */
export function scopeFactoryMerge(
  state: FactorySnapshot,
  scope: FactoryMergeReadScope,
): Pick<FactorySnapshot, "mergeGroups" | "mergeGroupReviews" | "mergeOperations"> {
  const ownedAssignments = new Set(
    state.assignments
      .filter((entry) =>
        scope.kind === "project"
          ? entry.projectId === scope.projectId
          : scope.kind === "manager"
            ? entry.managerId === scope.managerId
            : entry.id === scope.assignmentId,
      )
      .map((entry) => entry.id),
  );
  const groups = state.mergeGroups.filter(
    (entry) =>
      ownedAssignments.has(entry.integrationAssignmentId) ||
      entry.memberAssignmentIds.some((id) => ownedAssignments.has(id)),
  );
  const ids = new Set(groups.map((entry) => entry.id));
  return {
    mergeGroups: groups,
    mergeGroupReviews: state.mergeGroupReviews.filter((entry) => ids.has(entry.groupId)),
    mergeOperations: state.mergeOperations.filter((entry) => ids.has(entry.groupId)),
  };
}
