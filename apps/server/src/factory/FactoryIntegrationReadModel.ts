import type { FactoryAssignmentId, FactorySnapshot, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Struct from "effect/Struct";

export type FactoryIntegrationReadScope =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "manager"; readonly managerId: ThreadId }
  | {
      readonly kind: "assignment";
      readonly assignmentId: FactoryAssignmentId;
      readonly includeLeadCommunication: boolean;
    };

/**
 * The integration records a reader may see. The requester's project and manager and the
 * integration team see an integration whole. A participant's project, manager or assignment
 * sees only its own project's grants, capabilities and test patches, and messages to or from
 * its assignments. An assignment reader sees messages only when it is the lead thread
 * (`includeLeadCommunication`).
 */
export function scopeFactoryIntegration(
  state: FactorySnapshot,
  scope: FactoryIntegrationReadScope,
): Pick<
  FactorySnapshot,
  | "integrationCapabilities"
  | "integrations"
  | "integrationGrants"
  | "integrationPreparations"
  | "integrationTestArtifacts"
  | "integrationVerifications"
  | "integrationMessages"
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
            .filter((entry) => entry.projectId === scope.projectId)
            .map((entry) => entry.id),
  );
  const projectIds = new Set(assignments.map((entry) => entry.projectId));
  if (scope.kind === "project") projectIds.add(scope.projectId);
  if (scope.kind === "manager")
    for (const manager of state.managers)
      if (manager.id === scope.managerId && manager.projectId !== null)
        projectIds.add(manager.projectId);
  const integrations = state.integrations.filter(
    (entry) =>
      managerIds.has(entry.requesterManagerId) ||
      assignmentIds.has(entry.assignmentId) ||
      entry.participantAssignmentIds.some((id) => assignmentIds.has(id)),
  );
  const integrationIds = new Set(integrations.map((entry) => entry.id));
  const completeVectors = new Set(
    integrations
      .filter(
        (entry) =>
          managerIds.has(entry.requesterManagerId) || assignmentIds.has(entry.assignmentId),
      )
      .map((entry) => entry.id),
  );
  const grants = state.integrationGrants.filter(
    (entry) =>
      integrationIds.has(entry.integrationId) &&
      (completeVectors.has(entry.integrationId) || projectIds.has(entry.projectId)),
  );
  const capabilityIds = new Set(grants.map((entry) => entry.capabilityId));
  // Resume targets name threads and runs across projects; only the host needs them.
  return {
    integrations: integrations.map((entry) => ({
      ...entry,
      hold:
        entry.hold === null ? null : Struct.omit(entry.hold, ["resumeThreadIds", "resumeQueues"]),
    })),
    integrationGrants: grants,
    integrationCapabilities: state.integrationCapabilities.filter(
      (entry) => projectIds.has(entry.projectId) || capabilityIds.has(entry.id),
    ),
    integrationPreparations: state.integrationPreparations
      .filter((entry) => integrationIds.has(entry.integrationId))
      .map((entry) =>
        Struct.omit(entry, [
          "resumeThreadIds",
          "resumeQueues",
          "inheritedResumeThreadIds",
          "inheritedResumeQueues",
        ]),
      ),
    integrationTestArtifacts: state.integrationTestArtifacts
      .filter((entry) => integrationIds.has(entry.integrationId))
      .map((entry) => ({
        ...entry,
        projects: entry.projects.filter(
          (project) =>
            completeVectors.has(entry.integrationId) || projectIds.has(project.projectId),
        ),
      })),
    integrationVerifications: state.integrationVerifications
      .filter((entry) => integrationIds.has(entry.integrationId))
      .map((entry) => Struct.omit(entry, ["resumeThreadIds", "resumeQueues"])),
    integrationMessages: state.integrationMessages.filter(
      (entry) =>
        integrationIds.has(entry.integrationId) &&
        (scope.kind !== "assignment" || scope.includeLeadCommunication) &&
        (completeVectors.has(entry.integrationId) ||
          assignmentIds.has(entry.fromAssignmentId) ||
          assignmentIds.has(entry.toAssignmentId)),
    ),
  };
}
