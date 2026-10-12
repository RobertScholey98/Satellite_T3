import {
  FactoryError,
  type FactoryAssignment,
  type FactoryCommandResult,
  type FactoryDecisionCommand,
  type FactoryEffectIntent,
  type FactoryMergeGroup,
  type FactoryMergeGroupReadiness,
  type FactoryMergeGroupReview,
  type FactoryMergeMemberReadiness,
  type FactoryMergeReviewMember,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { currentFactoryDeliveryRevision, factoryDeliveryReadiness } from "./FactoryDelivery.ts";
import { factoryIntegrationVerificationReadiness } from "./FactoryIntegration.ts";
import {
  canonicalFactoryPullRequest,
  factoryMergeGroupForAssignment,
  factoryMergeGroupForIntegration,
  factoryMergeGroupsForPullRequest,
} from "./FactoryMergeOwnership.ts";
import type { FactoryActor, FactoryDecision } from "./FactoryState.ts";
import {
  currentFactoryMergeOperation,
  factoryMergeGroupHeads,
  factoryMergeGroupReleaseBlock,
  factoryMergeGroupRestoreBlock,
  latestFactoryMergeOperation,
} from "./FactoryMergeOperation.ts";

const active = (assignment: FactoryAssignment | undefined): assignment is FactoryAssignment =>
  assignment !== undefined &&
  !assignment.outcome &&
  assignment.status !== "complete" &&
  (!assignment.completion || assignment.completion.phase === "collecting");
const unique = (values: readonly string[]) => [...new Set(values)];
const sameMembers = (
  left: readonly FactoryMergeReviewMember[],
  right: readonly FactoryMergeReviewMember[],
) =>
  stableStringify([...left].sort((a, b) => a.assignmentId.localeCompare(b.assignmentId))) ===
  stableStringify([...right].sort((a, b) => a.assignmentId.localeCompare(b.assignmentId)));
/** A persisted group, or the group an integration implies before its first decision persists it. */
const findGroup = (state: FactorySnapshot, groupId: string) =>
  state.mergeGroups.find((entry) => entry.id === groupId) ??
  state.integrations
    .map((entry) => factoryMergeGroupForIntegration(state, entry))
    .find((entry) => entry.id === groupId);

const memberReadiness = (
  state: FactorySnapshot,
  group: FactoryMergeGroup,
): readonly FactoryMergeMemberReadiness[] =>
  group.memberAssignmentIds.flatMap((assignmentId) => {
    const assignment = state.assignments.find((entry) => entry.id === assignmentId);
    if (!assignment) return [];
    const revision = currentFactoryDeliveryRevision(assignment);
    const readiness = revision
      ? factoryDeliveryReadiness(state, assignment, revision)
      : {
          reasons: ["The implementation team has not published a reviewed revision."],
          needsHuman: true,
          humanApproved: false,
          ruleEligible: false,
        };
    const latestReview = revision?.reviews.at(-1);
    return [
      {
        assignmentId,
        projectId: assignment.projectId,
        leadThreadId: assignment.threadId,
        title: assignment.title ?? null,
        revisionId: revision?.id ?? null,
        ref: revision?.publication?.ref ?? null,
        headSha: revision?.publication?.headSha ?? null,
        bundleDigest: revision?.bundleDigest ?? null,
        reasons: readiness.reasons,
        needsHuman: readiness.needsHuman,
        humanApproved: readiness.humanApproved,
        ruleEligible: readiness.ruleEligible,
        hostEvidence: revision?.hostEvidence ?? null,
        teamReview: latestReview
          ? {
              threadId: latestReview.threadId,
              status: latestReview.status,
              findings: latestReview.findings ?? null,
            }
          : null,
        screenshots: revision?.uxEvidence?.screenshots ?? [],
        publishedScreenshotUrls: revision?.publishedUxEvidence?.urls ?? [],
      },
    ];
  });

/**
 * What a combined review seals: each member's current published, inspected revision and the
 * passing combined verification that exercised exactly those bytes. Inspection, approval and the
 * shared merge freeze all compare against it, so any reason means the group is not ready.
 */
export type FactoryMergeGroupEvidence =
  | { readonly ready: false; readonly reasons: readonly string[] }
  | {
      readonly ready: true;
      readonly members: readonly FactoryMergeReviewMember[];
      readonly integrationVerificationId: string;
      readonly integrationPreparationId: string;
      readonly inputDigest: string;
      readonly testArtifactDigest: string;
    };

export function factoryMergeGroupEvidence(
  state: FactorySnapshot,
  groupId: string,
): FactoryMergeGroupEvidence {
  const group = findGroup(state, groupId);
  if (!group) return { ready: false, reasons: ["The merge group is unavailable."] };
  if (group.released)
    return { ready: false, reasons: [`This merge group was released. ${group.released.reason}`] };
  const integration = state.integrations.find((entry) => entry.id === group.integrationId);
  const lead = state.assignments.find((entry) => entry.id === group.integrationAssignmentId);
  const reasons: string[] = [];
  if (
    !integration ||
    !active(lead) ||
    integration.assignmentId !== group.integrationAssignmentId ||
    stableStringify([...integration.participantAssignmentIds].sort()) !==
      stableStringify([...group.memberAssignmentIds].sort())
  )
    reasons.push("The integration assignment or its participating scope changed.");
  for (const known of group.knownPullRequests) {
    if (factoryMergeGroupsForPullRequest(state, known.ref).some((entry) => entry.id !== group.id))
      reasons.push(
        `Pull request ${canonicalFactoryPullRequest(known.ref)} belongs to more than one merge group.`,
      );
  }
  const members: FactoryMergeReviewMember[] = [];
  for (const assignmentId of group.memberAssignmentIds) {
    const assignment = state.assignments.find((entry) => entry.id === assignmentId);
    const revision = assignment && currentFactoryDeliveryRevision(assignment);
    if (!assignment || !revision) {
      reasons.push(`Participant ${assignmentId} has no current delivery revision.`);
      continue;
    }
    const readiness = factoryDeliveryReadiness(state, assignment, revision);
    reasons.push(
      ...readiness.reasons.map((reason) => `${assignment.title ?? assignmentId}: ${reason}`),
    );
    // A member merging on its own would leave the group with a partial vector it never reviewed.
    if (revision.merge && revision.merge.status !== "failed")
      reasons.push(`Participant ${assignmentId} has an independent merge outcome to reconcile.`);
    const publication = revision.publication;
    if (
      !publication?.ref ||
      !revision.candidateDigest ||
      !revision.bundleDigest ||
      !revision.hostEvidence
    )
      continue;
    if (
      factoryMergeGroupsForPullRequest(state, publication.ref).some(
        (entry) => entry.id !== group.id,
      )
    )
      reasons.push(
        `Pull request ${canonicalFactoryPullRequest(publication.ref)} belongs to more than one merge group.`,
      );
    members.push({
      assignmentId,
      projectId: assignment.projectId,
      leadThreadId: assignment.threadId,
      revisionId: revision.id,
      ref: {
        ...publication.ref,
        host: (publication.ref.host ?? "github.com").toLowerCase(),
        repository: publication.ref.repository.toLowerCase(),
      },
      headSha: publication.headSha,
      baseSha: revision.hostEvidence.baseSha,
      candidateDigest: revision.candidateDigest,
      bundleDigest: revision.bundleDigest,
      needsHuman: readiness.needsHuman,
      ruleEligible: readiness.ruleEligible,
      ruleVersion: readiness.ruleVersion,
    });
  }
  if (members.length !== group.memberAssignmentIds.length || members.length < 2)
    reasons.push("Every member needs a published, inspected revision before combined review.");
  if (
    new Set(members.map((entry) => canonicalFactoryPullRequest(entry.ref))).size !== members.length
  )
    reasons.push("A pull request cannot represent multiple members of a merge group.");
  const combined = factoryIntegrationVerificationReadiness(state, group.integrationId);
  if (combined.status !== "passed" || !combined.published)
    reasons.push(
      ...combined.reasons,
      "Verify the exact published participant revisions together before combined review.",
    );
  const verification = state.integrationVerifications.find(
    (entry) => entry.id === combined.verificationId,
  );
  const preparation = state.integrationPreparations.find(
    (entry) => entry.id === verification?.preparationId,
  );
  const result = verification?.lifecycle;
  const prepared = preparation?.lifecycle;
  if (
    result?.phase !== "completed" ||
    result.result !== "passed" ||
    prepared?.phase !== "ready" ||
    !verification ||
    !preparation
  )
    return {
      ready: false,
      reasons: unique([...reasons, "Current host-recorded combined verification is missing."]),
    };
  const artifact = state.integrationTestArtifacts.find(
    (entry) => entry.id === result.testArtifactId,
  );
  // Tests that exist only in the integration would not merge with the members, so every changed
  // path must already be in the published candidates.
  if (
    !artifact ||
    artifact.digest !== result.testArtifactDigest ||
    artifact.projects.length !== members.length ||
    artifact.projects.some(
      (entry) => entry.changedPaths.length > 0 || entry.deletedPaths.length > 0,
    )
  )
    reasons.push(
      "Owning teams must incorporate the integration tests and fixtures into their published candidates, then verify again.",
    );
  if (prepared.manifest.inputs.length !== members.length)
    reasons.push("The tested participant set differs from this merge group.");
  for (const member of members) {
    const input = prepared.manifest.inputs.find(
      (entry) => entry.assignmentId === member.assignmentId,
    );
    const publication = input?.publication;
    const assignment = state.assignments.find((entry) => entry.id === member.assignmentId)!;
    const revision = currentFactoryDeliveryRevision(assignment)!;
    const patch = artifact?.projects.find((entry) => entry.projectId === member.projectId);
    if (
      !input ||
      publication?.kind !== "published-head" ||
      canonicalFactoryPullRequest(publication.ref) !== canonicalFactoryPullRequest(member.ref) ||
      publication.headSha !== member.headSha ||
      publication.baseSha !== member.baseSha ||
      publication.treeOid !== revision.publication?.treeOid ||
      input.revisionId !== member.revisionId ||
      input.candidateDigest !== member.candidateDigest ||
      patch?.candidateId !== input.candidateId ||
      patch.candidateDigest !== input.candidateDigest ||
      patch.sourceDigest !== input.sourceDigest
    )
      reasons.push(
        `Participant ${member.assignmentId} does not match the published bytes exercised by combined verification.`,
      );
  }
  if (reasons.length) return { ready: false, reasons: unique(reasons) };
  return {
    ready: true,
    members: members.sort((a, b) => a.assignmentId.localeCompare(b.assignmentId)),
    integrationVerificationId: verification.id,
    integrationPreparationId: preparation.id,
    inputDigest: verification.inputDigest,
    testArtifactDigest: result.testArtifactDigest,
  };
}

const reviewMatches = (
  review: FactoryMergeGroupReview,
  evidence: Extract<FactoryMergeGroupEvidence, { ready: true }>,
) => {
  const sealed = review.lifecycle;
  return (
    sealed.phase === "sealed" &&
    sameMembers(sealed.members, evidence.members) &&
    sealed.integrationVerificationId === evidence.integrationVerificationId &&
    sealed.integrationPreparationId === evidence.integrationPreparationId &&
    sealed.inputDigest === evidence.inputDigest &&
    sealed.testArtifactDigest === evidence.testArtifactDigest
  );
};

/**
 * The combined review status the group view shows. `ready` needs current evidence, a seal that
 * still matches it and, when any member needs the human, the human's approval of that exact
 * review. Approving and requesting the merge both close while a shared operation owns the review.
 */
export function factoryMergeGroupReadiness(
  state: FactorySnapshot,
  groupId: string,
): FactoryMergeGroupReadiness {
  const group = findGroup(state, groupId);
  const evidence = factoryMergeGroupEvidence(state, groupId);
  const review = state.mergeGroupReviews.find((entry) => entry.id === group?.currentReviewId);
  const members = group ? memberReadiness(state, group) : [];
  const reasons = evidence.ready ? [] : [...evidence.reasons];
  const currentSeal = Boolean(review && evidence.ready && reviewMatches(review, evidence));
  const needsHuman = members.some((entry) => entry.needsHuman);
  if (!currentSeal)
    reasons.push(
      review?.lifecycle.phase === "requested"
        ? "The host is refreshing the combined review evidence."
        : review?.lifecycle.phase === "failed"
          ? review.lifecycle.reason
          : "Refresh the combined review for the current member revisions and integration evidence.",
    );
  const rejection =
    currentSeal && review?.decision?.outcome === "changes-requested" ? review.decision : null;
  if (rejection) reasons.push(rejection.reason);
  if (
    currentSeal &&
    needsHuman &&
    (review?.decision?.outcome !== "approved" ||
      members.some((entry) => entry.needsHuman && !entry.humanApproved))
  )
    reasons.push(
      "Human approval is required for this exact combined review and its member revisions.",
    );
  return {
    groupId,
    status: rejection
      ? "changes-requested"
      : !evidence.ready || !currentSeal
        ? "waiting"
        : reasons.length
          ? "reviewing"
          : "ready",
    reasons: unique(reasons),
    reviewId: review?.id ?? null,
    reviewDigest: review?.lifecycle.phase === "sealed" ? review.lifecycle.digest : null,
    members,
    integrationVerificationId: evidence.ready ? evidence.integrationVerificationId : null,
    canApprove:
      currentSeal &&
      evidence.ready &&
      !currentFactoryMergeOperation(state, group?.integrationId ?? ""),
    canRequestMerge:
      currentSeal &&
      reasons.length === 0 &&
      !currentFactoryMergeOperation(state, group?.integrationId ?? ""),
  };
}

/**
 * Why a decision cannot create its new integrations: a participant already belongs to a group
 * that holds it. `decide` checks every command's result, so no path puts one member in two groups.
 */
export function factoryMergeEnrollmentConflict(
  previous: FactorySnapshot,
  state: FactorySnapshot,
): string | null {
  for (const integration of state.integrations.filter(
    (entry) => !previous.integrations.some((old) => old.id === entry.id),
  )) {
    for (const assignmentId of integration.participantAssignmentIds) {
      const existing = factoryMergeGroupForAssignment(previous, assignmentId);
      if (existing)
        return `Participant ${assignmentId} already belongs to merge group ${existing.id}. Coordinate through its existing integration lead.`;
    }
  }
  return null;
}

/**
 * Withdraws the group's combined approvals from members that have not merged, so a member leaving
 * the group needs its own approval before it merges alone.
 */
function withdrawGroupApprovals(
  state: FactorySnapshot,
  group: FactoryMergeGroup,
  now: string,
): FactorySnapshot["assignments"] {
  const decisions = new Set(
    state.mergeGroupReviews.flatMap((entry) =>
      entry.groupId === group.id && entry.decision?.outcome === "approved"
        ? [entry.decision.commandId]
        : [],
    ),
  );
  return state.assignments.map((assignment) => {
    if (
      !group.memberAssignmentIds.includes(assignment.id) ||
      !assignment.delivery?.revisions.some(
        (revision) =>
          revision.merge?.status !== "merged" &&
          revision.approval !== undefined &&
          decisions.has(revision.approval.commandId),
      )
    )
      return assignment;
    return {
      ...assignment,
      delivery: {
        ...assignment.delivery,
        revisions: assignment.delivery.revisions.map((revision) => {
          if (
            revision.merge?.status === "merged" ||
            !revision.approval ||
            !decisions.has(revision.approval.commandId)
          )
            return revision;
          const { approval: _approval, ...rest } = revision;
          return rest;
        }),
      },
      updatedAt: now,
    };
  });
}

/** What the host shows for a group; any change queues one `merge.group.hold`. */
const holdKey = (state: FactorySnapshot, group: FactoryMergeGroup | undefined) =>
  group
    ? stableStringify({
        released: group.released !== undefined,
        known: group.knownPullRequests.map((entry) => canonicalFactoryPullRequest(entry.ref)),
        heads: factoryMergeGroupHeads(state, group.id),
      })
    : null;

/**
 * Persists every integration's merge group with its known PRs, releases groups whose integration
 * ended, and asks the host to update labels and head statuses whenever what it shows changes.
 */
export function reconcileFactoryMergeGroups(
  decision: FactoryDecision,
  now: string,
  previous: FactorySnapshot,
): FactoryDecision {
  const groups = new Map(decision.state.mergeGroups.map((entry) => [entry.id, entry]));
  let assignments = decision.state.assignments;
  for (const integration of decision.state.integrations) {
    const state = decision.state;
    const group = factoryMergeGroupForIntegration(state, integration);
    const refs = new Map(
      group.knownPullRequests.map((entry) => [
        `${entry.assignmentId}:${canonicalFactoryPullRequest(entry.ref)}`,
        entry,
      ]),
    );
    for (const assignment of state.assignments.filter((entry) =>
      group.memberAssignmentIds.includes(entry.id),
    )) {
      for (const revision of assignment.delivery?.revisions ?? []) {
        const ref = revision.publication?.ref;
        if (ref)
          refs.set(`${assignment.id}:${canonicalFactoryPullRequest(ref)}`, {
            assignmentId: assignment.id,
            ref: {
              ...ref,
              host: (ref.host ?? "github.com").toLowerCase(),
              repository: ref.repository.toLowerCase(),
            },
          });
      }
    }
    const known =
      refs.size === group.knownPullRequests.length
        ? group
        : { ...group, knownPullRequests: [...refs.values()], updatedAt: now };
    const lead = state.assignments.find((entry) => entry.id === group.integrationAssignmentId);
    const cancelled = lead?.outcome !== undefined;
    // An uncertain shared write keeps the group until reconciliation shows what happened.
    if (
      known.released === undefined &&
      lead !== undefined &&
      !active(lead) &&
      !latestFactoryMergeOperation(state, group.id)?.members.some(
        (entry) => entry.outcome.phase === "unknown",
      )
    ) {
      const released = {
        ...known,
        released: {
          reason: cancelled
            ? "The integration assignment was cancelled."
            : "The integration assignment concluded.",
          releasedAt: now,
        },
        updatedAt: now,
      };
      assignments = withdrawGroupApprovals({ ...state, assignments }, released, now);
      groups.set(group.id, released);
    } else groups.set(group.id, known);
  }
  const state = { ...decision.state, assignments, mergeGroups: [...groups.values()] };
  const holds = state.mergeGroups.flatMap((group): FactoryEffectIntent[] => {
    const before = previous.mergeGroups.find((entry) => entry.id === group.id);
    return holdKey(state, group) === holdKey(previous, before)
      ? []
      : [{ type: "merge.group.hold", groupId: group.id }];
  });
  return { ...decision, state, effects: [...decision.effects, ...holds] };
}

/**
 * Decides the combined review and group membership commands; `merge.group.start` belongs to the
 * shared merge decider, which runs first. The human releases and restores a group. The active
 * integration lead or the human requests a review, only the host seals it, and only the human
 * approves or rejects it. Review commands are refused while a shared operation owns the review.
 */
export function decideFactoryMerge(input: {
  readonly state: FactorySnapshot;
  readonly actor: FactoryActor;
  readonly command: FactoryDecisionCommand;
  readonly now: string;
}): Result.Result<FactoryDecision, FactoryError> | undefined {
  const { state, actor, command, now } = input;
  if (!command.type.startsWith("merge.group.")) return undefined;
  const fail = (detail: string, code: FactoryError["code"] = "permission-denied") =>
    Result.fail(new FactoryError({ code, detail }));
  const accept = (
    patch: Partial<FactorySnapshot>,
    result: Omit<FactoryCommandResult, "revision"> = {},
    effects: readonly FactoryEffectIntent[] = [],
  ): Result.Result<FactoryDecision, FactoryError> =>
    Result.succeed({
      state: { ...state, ...patch, revision: state.revision + 1 },
      result: { ...result, revision: state.revision + 1 },
      effects,
    });
  if (!("groupId" in command)) return fail("Select the merge group.", "invalid-state");
  const group = findGroup(state, command.groupId);
  if (!group) return fail("The merge group is unavailable.", "invalid-state");
  const notifyGroup = (eventId: string, text: string): FactoryEffectIntent => ({
    type: "merge.group.notify",
    groupId: group.id,
    eventId,
    recipientAssignmentIds: [group.integrationAssignmentId, ...group.memberAssignmentIds],
    text,
  });
  const replaceGroup = (next: FactoryMergeGroup) => [
    ...state.mergeGroups.filter((entry) => entry.id !== group.id),
    next,
  ];
  if (command.type === "merge.group.release" || command.type === "merge.group.restore") {
    if (actor.kind !== "human")
      return fail("Only the human can release a merge group or group its PRs again.");
    if (command.type === "merge.group.release") {
      const block = factoryMergeGroupReleaseBlock(state, group);
      if (block) return fail(block, "invalid-state");
      const released = {
        ...group,
        released: { reason: command.reason, releasedAt: now },
        updatedAt: now,
      };
      return accept(
        {
          mergeGroups: replaceGroup(released),
          assignments: withdrawGroupApprovals(state, released, now),
        },
        { mergeGroupId: group.id },
        [
          notifyGroup(
            `released:${command.commandId}`,
            `The human released this merge group: ${command.reason}\nMember PRs no longer wait for the shared merge. Each merges through its own delivery approval; the combined approval was withdrawn.`,
          ),
        ],
      );
    }
    const block = factoryMergeGroupRestoreBlock(state, group);
    if (block) return fail(block, "invalid-state");
    const { released: _released, ...restored } = group;
    return accept(
      { mergeGroups: replaceGroup({ ...restored, currentReviewId: null, updatedAt: now }) },
      { mergeGroupId: group.id },
      [
        notifyGroup(
          `restored:${command.commandId}`,
          "The human grouped these PRs again. Every member waits for a fresh combined review and the shared merge action.",
        ),
      ],
    );
  }
  if (group.released)
    return fail(`This merge group was released. ${group.released.reason}`, "invalid-state");
  if (currentFactoryMergeOperation(state, group.integrationId))
    return fail(
      "The shared merge operation owns this exact review. Stop it safely before replacing or changing the review.",
      "invalid-state",
    );
  const assignment = state.assignments.find((entry) => entry.id === group.integrationAssignmentId);
  const host = actor.kind === "system";
  const human = actor.kind === "human";
  const canReview =
    human ||
    (actor.kind === "thread" && active(assignment) && actor.threadId === assignment.threadId);
  switch (command.type) {
    case "merge.group.review": {
      if (!canReview || !active(assignment))
        return fail(
          "The active integration lead prepares this combined review. Managers do not review PRs.",
        );
      if (
        state.mergeGroupReviews.some(
          (entry) => entry.id === group.currentReviewId && entry.lifecycle.phase === "requested",
        )
      )
        return fail("This group's host review is already being refreshed.", "invalid-state");
      const review: FactoryMergeGroupReview = {
        id: `merge-review:${command.commandId}`,
        groupId: group.id,
        lifecycle: { phase: "requested" },
        decision: null,
        createdAt: now,
      };
      return accept(
        {
          mergeGroups: replaceGroup({ ...group, currentReviewId: review.id, updatedAt: now }),
          mergeGroupReviews: [...state.mergeGroupReviews, review],
        },
        { mergeGroupId: group.id, mergeGroupReviewId: review.id },
        [{ type: "merge.group.inspect", groupId: group.id, reviewId: review.id }],
      );
    }
    case "merge.group.inspected":
    case "merge.group.inspect.failed": {
      const review = state.mergeGroupReviews.find((entry) => entry.id === command.reviewId);
      if (
        !host ||
        !review ||
        review.groupId !== group.id ||
        group.currentReviewId !== review.id ||
        review.lifecycle.phase !== "requested"
      )
        return fail(
          "This host inspection no longer belongs to the pending combined review.",
          "stale-revision",
        );
      if (command.type === "merge.group.inspect.failed")
        return accept(
          {
            mergeGroupReviews: state.mergeGroupReviews.map((entry) =>
              entry.id === review.id
                ? { ...entry, lifecycle: { phase: "failed", reason: command.reason } }
                : entry,
            ),
          },
          { mergeGroupId: group.id, mergeGroupReviewId: review.id },
          [
            notifyGroup(
              `failed:${review.id}`,
              `Combined review could not be sealed. ${command.reason}`,
            ),
          ],
        );
      const evidence = factoryMergeGroupEvidence(state, group.id);
      // Sealing the same vector again keeps an earlier request for changes, so refreshing the
      // review cannot clear it. An earlier approval is not carried over.
      const priorDecision = evidence.ready
        ? state.mergeGroupReviews.findLast(
            (entry) =>
              entry.groupId === group.id &&
              entry.decision !== null &&
              entry.lifecycle.phase === "sealed" &&
              sameMembers(entry.lifecycle.members, evidence.members) &&
              entry.lifecycle.inputDigest === evidence.inputDigest &&
              entry.lifecycle.testArtifactDigest === evidence.testArtifactDigest,
          )?.decision
        : null;
      const sealed: FactoryMergeGroupReview = {
        ...review,
        decision: priorDecision?.outcome === "changes-requested" ? priorDecision : null,
        lifecycle: {
          phase: "sealed",
          digest: command.digest,
          members: command.members,
          integrationVerificationId: command.integrationVerificationId,
          integrationPreparationId: command.integrationPreparationId,
          inputDigest: command.inputDigest,
          testArtifactDigest: command.testArtifactDigest,
          sealedAt: now,
        },
      };
      if (
        command.expectedStateRevision !== state.revision ||
        !evidence.ready ||
        !reviewMatches(sealed, evidence)
      )
        return fail(
          "The member or combined verification evidence changed before this review was sealed.",
          "stale-revision",
        );
      return accept(
        {
          mergeGroupReviews: state.mergeGroupReviews.map((entry) =>
            entry.id === review.id ? sealed : entry,
          ),
        },
        { mergeGroupId: group.id, mergeGroupReviewId: review.id },
        [
          notifyGroup(
            `sealed:${review.id}`,
            "The combined feature review is ready in the integration thread. Owning implementation leads handle corrections. Every member remains held for the shared merge action.",
          ),
        ],
      );
    }
    case "merge.group.approve":
    case "merge.group.reject": {
      const review = state.mergeGroupReviews.find((entry) => entry.id === command.reviewId);
      const evidence = factoryMergeGroupEvidence(state, group.id);
      if (
        !human ||
        !review ||
        group.currentReviewId !== review.id ||
        review.lifecycle.phase !== "sealed" ||
        review.lifecycle.digest !== command.expectedDigest ||
        !evidence.ready ||
        !reviewMatches(review, evidence)
      )
        return fail(
          "Only the human can decide the exact current combined feature review.",
          "stale-revision",
        );
      const approved = command.type === "merge.group.approve";
      const decision: FactoryMergeGroupReview["decision"] = approved
        ? { outcome: "approved", commandId: command.commandId, decidedAt: now }
        : {
            outcome: "changes-requested",
            commandId: command.commandId,
            reason: command.reason,
            decidedAt: now,
          };
      // Approval lands on each member's reviewed revision as a human delivery approval bound to its
      // head and bundle. Releasing the group withdraws it from members that have not merged.
      const assignments = approved
        ? state.assignments.map((entry) => {
            const member = evidence.members.find((item) => item.assignmentId === entry.id);
            if (!member || !entry.delivery) return entry;
            return {
              ...entry,
              delivery: {
                ...entry.delivery,
                readiness: [],
                revisions: entry.delivery.revisions.map((revision) =>
                  revision.id === member.revisionId
                    ? {
                        ...revision,
                        approval: {
                          expectedHeadSha: member.headSha,
                          bundleDigest: member.bundleDigest,
                          ruleVersion: member.ruleVersion,
                          authority: "human" as const,
                          commandId: command.commandId,
                          approvedAt: now,
                        },
                      }
                    : revision,
                ),
              },
              updatedAt: now,
            };
          })
        : state.assignments;
      return accept(
        {
          assignments,
          mergeGroupReviews: state.mergeGroupReviews.map((entry) =>
            entry.id === review.id ? { ...entry, decision } : entry,
          ),
        },
        { mergeGroupId: group.id, mergeGroupReviewId: review.id },
        [
          notifyGroup(
            `${approved ? "approved" : "rejected"}:${command.commandId}`,
            approved
              ? "The human approved this exact combined feature and its displayed member revisions. All member PRs still wait for the shared merge action."
              : `The human requested combined-feature corrections. Owning leads should discuss and implement the changes, then refresh combined evidence. ${command.reason}`,
          ),
        ],
      );
    }
  }
}
