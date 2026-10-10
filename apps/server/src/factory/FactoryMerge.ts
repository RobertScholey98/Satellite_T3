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
    canApprove: currentSeal && evidence.ready,
    canRequestMerge: false,
  };
}

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

export function reconcileFactoryMergeGroups(
  decision: FactoryDecision,
  now: string,
): FactoryDecision {
  const state = decision.state;
  const groups = new Map(state.mergeGroups.map((entry) => [entry.id, entry]));
  for (const integration of state.integrations) {
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
    groups.set(
      group.id,
      refs.size === group.knownPullRequests.length
        ? group
        : { ...group, knownPullRequests: [...refs.values()], updatedAt: now },
    );
  }
  return { ...decision, state: { ...state, mergeGroups: [...groups.values()] } };
}

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
  const assignment = state.assignments.find((entry) => entry.id === group.integrationAssignmentId);
  const host = actor.kind === "system";
  const human = actor.kind === "human";
  const canReview =
    human ||
    (actor.kind === "thread" && active(assignment) && actor.threadId === assignment.threadId);
  const notice = (eventId: string, text: string): FactoryEffectIntent => ({
    type: "merge.group.notify",
    groupId: group.id,
    eventId,
    recipientAssignmentIds: [group.integrationAssignmentId, ...group.memberAssignmentIds],
    text,
  });
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
          mergeGroups: [
            ...state.mergeGroups.filter((entry) => entry.id !== group.id),
            { ...group, currentReviewId: review.id, updatedAt: now },
          ],
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
          [notice(`failed:${review.id}`, `Combined review could not be sealed. ${command.reason}`)],
        );
      const evidence = factoryMergeGroupEvidence(state, group.id);
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
          notice(
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
          notice(
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
