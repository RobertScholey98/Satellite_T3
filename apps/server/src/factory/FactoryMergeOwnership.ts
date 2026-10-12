import type {
  FactoryAssignmentId,
  FactoryIntegration,
  FactoryMergeGroup,
  FactorySnapshot,
  PullRequestRef,
} from "@t3tools/contracts";

/** PR identity for comparing refs: the host defaults to github.com and case is ignored. */
export const canonicalFactoryPullRequest = (ref: PullRequestRef): string =>
  `${(ref.host ?? "github.com").toLowerCase()}/${ref.repository.toLowerCase()}#${ref.number}`;

export const factoryMergeGroupId = (integrationId: string): string =>
  `merge-group:${integrationId}`;

/**
 * Every integration has one merge group. Before `reconcileFactoryMergeGroups` persists it, this
 * derives the group from the integration's participants and their published PRs.
 */
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

/** A released group no longer holds its members: they merge through their own delivery paths. */
export const factoryMergeGroupHolds = (group: FactoryMergeGroup) => group.released === undefined;

/** The group currently holding this participant, if any. */
export function factoryMergeGroupForAssignment(
  state: FactorySnapshot,
  assignmentId: FactoryAssignmentId,
): FactoryMergeGroup | undefined {
  const persisted = state.mergeGroups.find(
    (entry) => factoryMergeGroupHolds(entry) && entry.memberAssignmentIds.includes(assignmentId),
  );
  if (persisted) return persisted;
  return state.integrations
    .filter((entry) => entry.participantAssignmentIds.includes(assignmentId))
    .map((entry) => factoryMergeGroupForIntegration(state, entry))
    .find(factoryMergeGroupHolds);
}

/**
 * Every group holding this PR, through a recorded ref or a member's published revision. The pull
 * request gate holds merges of a PR found here outside the shared merge, and more than one group
 * blocks the combined review.
 */
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
      factoryMergeGroupHolds(group) &&
      (group.knownPullRequests.some(
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
        )),
  );
}
