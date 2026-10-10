import type {
  FactoryAssignmentId,
  FactoryIntegration,
  FactoryMergeGroup,
  FactorySnapshot,
  PullRequestRef,
} from "@t3tools/contracts";

export const canonicalFactoryPullRequest = (ref: PullRequestRef): string =>
  `${(ref.host ?? "github.com").toLowerCase()}/${ref.repository.toLowerCase()}#${ref.number}`;

export const factoryMergeGroupId = (integrationId: string): string =>
  `merge-group:${integrationId}`;

export function factoryMergeGroupForIntegration(
  state: FactorySnapshot,
  integration: FactoryIntegration,
): FactoryMergeGroup {
  const persisted = state.mergeGroups.find((entry) => entry.integrationId === integration.id);
  if (persisted) return persisted;
  return {
    id: factoryMergeGroupId(integration.id),
    integrationId: integration.id,
    integrationAssignmentId: integration.assignmentId,
    memberAssignmentIds: integration.participantAssignmentIds,
    knownPullRequests: state.assignments
      .filter((entry) => integration.participantAssignmentIds.includes(entry.id))
      .flatMap((entry) =>
        (entry.delivery?.revisions ?? []).flatMap((revision) =>
          revision.publication?.ref
            ? [{ assignmentId: entry.id, ref: revision.publication.ref }]
            : [],
        ),
      ),
    currentReviewId: null,
    createdAt: integration.createdAt,
    updatedAt: integration.updatedAt,
  };
}

export function factoryMergeGroupForAssignment(
  state: FactorySnapshot,
  assignmentId: FactoryAssignmentId,
): FactoryMergeGroup | undefined {
  const persisted = state.mergeGroups.find((entry) =>
    entry.memberAssignmentIds.includes(assignmentId),
  );
  if (persisted) return persisted;
  const integration = state.integrations.find((entry) =>
    entry.participantAssignmentIds.includes(assignmentId),
  );
  return integration ? factoryMergeGroupForIntegration(state, integration) : undefined;
}

export function factoryMergeGroupsForPullRequest(
  state: FactorySnapshot,
  ref: PullRequestRef,
): readonly FactoryMergeGroup[] {
  const identity = canonicalFactoryPullRequest(ref);
  const groups = new Map(state.mergeGroups.map((entry) => [entry.id, entry]));
  for (const integration of state.integrations) {
    const group = factoryMergeGroupForIntegration(state, integration);
    groups.set(group.id, group);
  }
  return [...groups.values()].filter(
    (group) =>
      group.knownPullRequests.some(
        (entry) => canonicalFactoryPullRequest(entry.ref) === identity,
      ) ||
      state.assignments.some(
        (assignment) =>
          group.memberAssignmentIds.includes(assignment.id) &&
          assignment.delivery?.revisions.some(
            (revision) =>
              revision.publication?.ref &&
              canonicalFactoryPullRequest(revision.publication.ref) === identity,
          ),
      ),
  );
}
