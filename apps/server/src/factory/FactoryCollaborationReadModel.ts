import type { FactoryAssignmentId, FactorySnapshot, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Struct from "effect/Struct";

export type FactoryCollaborationReadScope =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "manager"; readonly managerId: ThreadId }
  | {
      readonly kind: "assignment";
      readonly assignmentId: FactoryAssignmentId;
      readonly includeLeadCommunication: boolean;
    };

export function scopeFactoryCollaboration(
  state: FactorySnapshot,
  scope: FactoryCollaborationReadScope,
): Pick<
  FactorySnapshot,
  | "crossProjectRequests"
  | "collaborationMessages"
  | "collaborationPlans"
  | "collaborationDecisions"
  | "incidentRestrictions"
> {
  const assignments = state.assignments.filter((entry) =>
    scope.kind === "project"
      ? entry.projectId === scope.projectId
      : scope.kind === "manager"
        ? entry.managerId === scope.managerId
        : entry.id === scope.assignmentId,
  );
  const assignmentIds = new Set(assignments.map((entry) => entry.id));
  const managerIds = new Set(
    scope.kind === "assignment"
      ? []
      : scope.kind === "manager"
        ? [scope.managerId]
        : state.managers
            .filter(
              (entry) =>
                entry.projectId === scope.projectId ||
                (entry.role === "system" && entry.workspaceProjectId === scope.projectId),
            )
            .map((entry) => entry.id),
  );
  const requests = state.crossProjectRequests.filter(
    (entry) =>
      managerIds.has(entry.originManagerId) ||
      managerIds.has(entry.receiverManagerId) ||
      (entry.origin.kind === "assignment" && assignmentIds.has(entry.origin.assignmentId)) ||
      ((entry.lifecycle.phase === "accepted" || entry.lifecycle.phase === "withdrawn") &&
        entry.lifecycle.support !== null &&
        assignmentIds.has(entry.lifecycle.support.assignmentId)),
  );
  const requestIds = new Set(requests.map((entry) => entry.id));
  const includeCommunication = scope.kind !== "assignment" || scope.includeLeadCommunication;
  return {
    crossProjectRequests: requests,
    collaborationMessages: includeCommunication
      ? state.collaborationMessages.filter(
          (entry) =>
            requestIds.has(entry.requestId) &&
            (scope.kind !== "assignment" ||
              assignmentIds.has(entry.fromAssignmentId) ||
              assignmentIds.has(entry.toAssignmentId)),
        )
      : [],
    collaborationPlans: includeCommunication
      ? state.collaborationPlans.filter(
          (entry) =>
            entry.requestIds.some((id) => requestIds.has(id)) &&
            (scope.kind !== "assignment" ||
              entry.participants.some((participant) =>
                assignmentIds.has(participant.assignmentId),
              )),
        )
      : [],
    collaborationDecisions: includeCommunication
      ? state.collaborationDecisions.filter((entry) =>
          entry.requestIds.some((id) => requestIds.has(id)),
        )
      : [],
    incidentRestrictions: state.incidentRestrictions.flatMap((entry) => {
      const targetedIds = entry.assignmentIds.filter((id) => assignmentIds.has(id));
      return managerIds.has(entry.managerId) || targetedIds.length
        ? [
            {
              ...Struct.omit(entry, ["resumeThreadIds", "resumeQueues"]),
              assignmentIds: targetedIds.length ? targetedIds : entry.assignmentIds,
            },
          ]
        : [];
    }),
  };
}
