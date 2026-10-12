import {
  FACTORY_MERGE_GROUP_LABEL,
  FactoryError,
  factoryMergeDeploymentGate,
  type FactoryAssignment,
  type FactoryAssignmentId,
  type FactoryDecisionCommand,
  type FactoryEffectIntent,
  type FactoryMergeFrozenProof,
  type FactoryMergeGroup,
  type FactoryMergeMemberReceipt,
  type FactoryMergeOperation,
  type FactoryMergeOperationMember,
  type FactoryMergeOperationReadiness,
  type FactorySnapshot,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";
import { factoryMergeGroupEvidence, factoryMergeGroupReadiness } from "./FactoryMerge.ts";
import {
  canonicalFactoryPullRequest,
  factoryMergeGroupForAssignment,
  factoryMergeGroupHolds,
} from "./FactoryMergeOwnership.ts";
import { factoryDeliveryReadiness } from "./FactoryDelivery.ts";
import { factoryIncidentBlocked } from "./FactoryCollaboration.ts";
import { initialFactoryCompletion } from "./FactoryRetros.ts";
import type { FactoryActor, FactoryDecision } from "./FactoryState.ts";

const hash = (value: unknown) =>
  Hex.encode(sha256(new TextEncoder().encode(stableStringify(value))));
const same = (left: unknown, right: unknown) => stableStringify(left) === stableStringify(right);
const active = (assignment: FactoryAssignment | undefined): assignment is FactoryAssignment =>
  assignment !== undefined &&
  !assignment.outcome &&
  assignment.status !== "complete" &&
  (!assignment.completion || assignment.completion.phase === "collecting");
export const latestFactoryMergeOperation = (state: FactorySnapshot, groupId: string) =>
  state.mergeOperations.findLast((entry) => entry.groupId === groupId);
/**
 * The operation that still owns this integration's team and combined review. A stop before any
 * member was submitted no longer counts, so the team runs again and the group can review or start
 * anew. A stop after any submission keeps the freeze in place, and a completed one stays too.
 */
export const currentFactoryMergeOperation = (state: FactorySnapshot, integrationId: string) => {
  const operation = state.mergeOperations.findLast(
    (entry) => entry.integrationId === integrationId,
  );
  return operation &&
    (operation.lifecycle.phase !== "stopped" ||
      operation.members.some((entry) => entry.outcome.phase !== "pending"))
    ? operation
    : undefined;
};
export const factoryMergeFrozenProof = (operation: FactoryMergeOperation) =>
  "frozen" in operation.lifecycle ? operation.lifecycle.frozen : null;
/**
 * Whether the shared merge freeze stops `threadId` in this integration team. Once the tested
 * bytes are frozen, the lead's own thread may run again to reconcile, retry or escalate its
 * operation; its tools are limited by the MCP guard and pauses and incidents still apply.
 * Omit `threadId` to ask whether any team member is frozen.
 */
export const factoryMergeFreezeBlocks = (
  state: FactorySnapshot,
  assignment: FactoryAssignment,
  threadId?: string,
) => {
  if (assignment.integrationId === undefined) return false;
  const operation = currentFactoryMergeOperation(state, assignment.integrationId);
  return (
    operation !== undefined &&
    !(
      threadId === assignment.threadId &&
      factoryMergeFrozenProof(operation) !== null &&
      operation.lifecycle.phase !== "completed"
    )
  );
};
/**
 * Binds a frozen proof to this operation's review and each member's reviewed revision and
 * authority, so the proof cannot be carried to another operation or a changed member vector. The
 * host computes it when freezing; write readiness recomputes it before every merge.
 */
export const factoryMergeFrozenDigest = (
  operation: FactoryMergeOperation,
  frozen: Omit<FactoryMergeFrozenProof, "digest">,
) =>
  hash({
    operationId: operation.id,
    groupId: operation.groupId,
    reviewId: operation.reviewId,
    reviewDigest: operation.reviewDigest,
    members: operation.members.map(({ reviewed, authority }) => ({ reviewed, authority })),
    frozen,
  });
/**
 * Digest of every member's confirmed receipt. The host sends it with `merge.operation.completed`
 * and the decider recomputes it, so completion names exactly the receipts the host saw.
 */
export const factoryMergeReceiptDigest = (operation: FactoryMergeOperation) =>
  hash({
    operationId: operation.id,
    frozenDigest: factoryMergeFrozenProof(operation)?.digest,
    receipts: operation.members.map((entry) =>
      entry.outcome.phase === "confirmed" ? entry.outcome.receipt : null,
    ),
  });

/**
 * The Group deployment readiness status every confirmed member's merge commit should carry. Only a
 * completed operation, which requires every exact receipt, is `success`; a stopped one is
 * `failure`; partial, held and reconciling operations stay `pending`. Null until a merge exists.
 */
export function factoryMergeSignal(operation: FactoryMergeOperation) {
  const receipts = operation.members.flatMap((entry) =>
    entry.outcome.phase === "confirmed" ? [entry.outcome.receipt] : [],
  );
  if (!receipts.length) return null;
  const state =
    operation.lifecycle.phase === "completed"
      ? ("success" as const)
      : operation.lifecycle.phase === "stopped"
        ? ("failure" as const)
        : ("pending" as const);
  const count = `${receipts.length} of ${operation.members.length}`;
  const text =
    state === "success"
      ? `Group ${operation.groupId} merged: ${receipts.map((entry) => `${entry.ref.repository}@${entry.mergeCommitSha.slice(0, 7)}`).join(", ")}`
      : state === "failure"
        ? `Group ${operation.groupId} stopped after ${count} merges. Do not deploy.`
        : `Group ${operation.groupId}: ${count} merges confirmed. Waiting for the rest.`;
  // GitHub rejects status descriptions over 140 characters.
  const description = text.length > 140 ? `${text.slice(0, 139)}…` : text;
  const targets = receipts.map((entry) => ({ ref: entry.ref, sha: entry.mergeCommitSha }));
  return { state, description, targets, digest: hash({ state, description, targets }) };
}

/**
 * The `satellite/merge-group` status each unmerged member's PR head should carry. `pending` holds
 * the PR while its group waits; `success` lets the host merge it once the shared merge runs or the
 * group stops holding it. Required in branch protection, this blocks merges outside Satellite.
 */
export function factoryMergeGroupHeads(state: FactorySnapshot, groupId: string) {
  const group = state.mergeGroups.find((entry) => entry.id === groupId);
  if (!group) return [];
  const operation = latestFactoryMergeOperation(state, groupId);
  const holds = factoryMergeGroupHolds(group);
  const merging =
    operation?.lifecycle.phase === "running" || operation?.lifecycle.phase === "completed";
  const status = holds && !merging ? ("pending" as const) : ("success" as const);
  const description = !holds
    ? "Released from its Satellite merge group."
    : merging
      ? "Satellite is merging this PR with its group."
      : "Held for its Satellite merge group's shared merge.";
  return group.memberAssignmentIds.flatMap((id) => {
    const assignment = state.assignments.find((entry) => entry.id === id);
    const revision = assignment?.delivery?.revisions.find(
      (entry) => entry.id === assignment.delivery?.currentRevisionId,
    );
    const publication = revision?.publication;
    if (
      !publication?.ref ||
      revision?.merge?.status === "merged" ||
      operation?.members.some(
        (entry) => entry.reviewed.assignmentId === id && entry.outcome.phase === "confirmed",
      )
    )
      return [];
    return [
      {
        ref: {
          ...publication.ref,
          host: (publication.ref.host ?? publication.host).toLowerCase(),
          repository: publication.ref.repository.toLowerCase(),
        },
        sha: publication.headSha,
        state: status,
        description,
      },
    ];
  });
}

/** Why the human cannot release this group now, or null when its members can leave it. */
export function factoryMergeGroupReleaseBlock(state: FactorySnapshot, group: FactoryMergeGroup) {
  if (!factoryMergeGroupHolds(group)) return "This merge group is already released.";
  const operation = latestFactoryMergeOperation(state, group.id);
  if (operation?.members.some((entry) => entry.outcome.phase === "unknown"))
    return "Reconcile the uncertain shared merge outcome before releasing the group.";
  if (operation && !["stopped", "completed"].includes(operation.lifecycle.phase))
    return "Stop the shared merge before releasing the group.";
  return null;
}

/** Why a released group cannot hold its members again, or null when it can. */
export function factoryMergeGroupRestoreBlock(state: FactorySnapshot, group: FactoryMergeGroup) {
  if (factoryMergeGroupHolds(group)) return "This merge group already holds its members.";
  const lead = state.assignments.find((entry) => entry.id === group.integrationAssignmentId);
  if (!active(lead))
    return "The integration assignment ended. Commission a new integration to group these PRs again.";
  if (group.memberAssignmentIds.some((id) => factoryMergeGroupForAssignment(state, id)))
    return "A member already belongs to another merge group.";
  return null;
}

/**
 * Whether an earlier operation already spent submissions on this sealed review's exact members
 * and tested bytes. Starting that vector again would grant a fresh three-attempt budget, so it is
 * refused; changed members or bytes need a new review instead.
 */
function attemptedReviewVector(state: FactorySnapshot, groupId: string, reviewId: string) {
  const review = state.mergeGroupReviews.find((entry) => entry.id === reviewId);
  if (review?.lifecycle.phase !== "sealed") return false;
  const sealed = review.lifecycle;
  const ordered = (members: readonly FactoryMergeOperationMember["reviewed"][]) =>
    [...members].sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
  return state.mergeOperations.some(
    (entry) =>
      entry.groupId === groupId &&
      entry.members.some((member) => member.attempts > 0) &&
      same(ordered(entry.members.map((member) => member.reviewed)), ordered(sealed.members)) &&
      factoryMergeFrozenProof(entry)?.testArtifactDigest === sealed.testArtifactDigest,
  );
}

/**
 * A host receipt counts only for this operation's exact reviewed revision, PR, head and target.
 * Its id derives from the operation and member, so a receipt cannot move between operations.
 */
function receiptMatches(
  operation: FactoryMergeOperation,
  member: FactoryMergeOperationMember,
  receipt: FactoryMergeMemberReceipt,
) {
  return (
    receipt.id === `merge-receipt:${operation.id}:${member.reviewed.assignmentId}` &&
    receipt.operationId === operation.id &&
    receipt.assignmentId === member.reviewed.assignmentId &&
    receipt.revisionId === member.reviewed.revisionId &&
    receipt.ref.projectId === member.reviewed.projectId &&
    canonicalFactoryPullRequest(receipt.ref) === canonicalFactoryPullRequest(member.reviewed.ref) &&
    receipt.headSha === member.reviewed.headSha &&
    receipt.targetBranch === member.authority.targetBranch &&
    receipt.mergeCommitSha.length > 0 &&
    receipt.mergedAt.length > 0
  );
}

/**
 * Whether the host may submit `assignmentId`'s merge now, with every reason it may not. The
 * decider, the advance effect and the pull request gate all check it before a write. It checks
 * every member of the frozen vector, because a change anywhere invalidates the shared merge.
 */
export function factoryMergeOperationWriteReadiness(
  state: FactorySnapshot,
  operationId: string,
  assignmentId: FactoryAssignmentId,
) {
  const operation = state.mergeOperations.find((entry) => entry.id === operationId);
  const reasons: string[] = [];
  if (!operation)
    return { allowed: false, reasons: ["The shared merge operation is unavailable."] };
  const frozen = factoryMergeFrozenProof(operation);
  const group = state.mergeGroups.find((entry) => entry.id === operation.groupId);
  if (group?.released) reasons.push(`This merge group was released. ${group.released.reason}`);
  const integration = state.integrations.find((entry) => entry.id === operation.integrationId);
  const lead = state.assignments.find((entry) => entry.id === operation.integrationAssignmentId);
  const review = state.mergeGroupReviews.find((entry) => entry.id === operation.reviewId);
  if (
    latestFactoryMergeOperation(state, operation.groupId)?.id !== operation.id ||
    !group ||
    group.integrationAssignmentId !== operation.integrationAssignmentId ||
    group.integrationId !== operation.integrationId ||
    !same(
      [...group.memberAssignmentIds].sort(),
      operation.members.map((entry) => entry.reviewed.assignmentId).sort(),
    ) ||
    !integration ||
    !same([...integration.participantAssignmentIds].sort(), [...group.memberAssignmentIds].sort())
  )
    reasons.push("The shared operation's membership changed.");
  if (
    !active(lead) ||
    lead.integrationId !== operation.integrationId ||
    lead.wait?.kind === "authority"
  )
    reasons.push("The integration lead no longer has current authority.");
  if (
    integration?.requestIds.some(
      (id) =>
        state.crossProjectRequests.find((entry) => entry.id === id)?.lifecycle.phase !== "accepted",
    )
  )
    reasons.push("A participating project request is no longer accepted.");
  if (
    !review ||
    review.lifecycle.phase !== "sealed" ||
    review.lifecycle.digest !== operation.reviewDigest ||
    group?.currentReviewId !== review.id ||
    review.decision?.outcome === "changes-requested"
  )
    reasons.push("The frozen combined review is no longer authorized.");
  if (!frozen) reasons.push("The integration team and tested bytes have not been frozen.");
  else {
    const { digest, ...proof } = frozen;
    const preparation = state.integrationPreparations.find(
      (entry) => entry.id === frozen.integrationPreparationId,
    );
    const verification = state.integrationVerifications.find(
      (entry) => entry.id === frozen.integrationVerificationId,
    );
    const artifact = state.integrationTestArtifacts.find(
      (entry) =>
        entry.id ===
        (verification?.lifecycle.phase === "completed"
          ? verification.lifecycle.testArtifactId
          : undefined),
    );
    const manifest =
      preparation?.lifecycle.phase === "ready" ? preparation.lifecycle.manifest : undefined;
    const coordinator = state.integrationCapabilities.find(
      (entry) => entry.id === frozen.coordinatorCapabilityId,
    );
    const plans = state.collaborationPlans
      .filter(
        (entry) =>
          entry.phase === "agreed" &&
          entry.requestIds.some((id) => integration?.requestIds.includes(id)),
      )
      .map((entry) => entry.id)
      .sort();
    if (
      factoryMergeFrozenDigest(operation, proof) !== digest ||
      frozen.captureDigest !== frozen.testArtifactDigest ||
      lead?.threadId !== frozen.integrationLeadThreadId ||
      (lead?.grant?.epoch ?? 0) !== frozen.integrationGrantEpoch ||
      integration?.currentPreparationId !== frozen.integrationPreparationId ||
      !manifest ||
      manifest.inputDigest !== frozen.inputDigest ||
      manifest.coordinatorCapabilityId !== frozen.coordinatorCapabilityId ||
      manifest.coordinatorDigest !== frozen.coordinatorDigest ||
      !same([...manifest.planIds].sort(), [...frozen.planIds].sort()) ||
      !same(plans, [...frozen.planIds].sort()) ||
      verification?.lifecycle.phase !== "completed" ||
      verification.lifecycle.result !== "passed" ||
      verification.inputDigest !== frozen.inputDigest ||
      verification.lifecycle.testArtifactDigest !== frozen.testArtifactDigest ||
      artifact?.digest !== frozen.testArtifactDigest ||
      integration?.currentTestArtifactId !== artifact?.id ||
      !coordinator ||
      coordinator.supersededBy !== null ||
      coordinator.qualification.status !== "qualified" ||
      coordinator.qualification.coordinatorDigest !== frozen.coordinatorDigest
    )
      reasons.push("The frozen integration verification or protected configuration changed.");
  }
  for (const member of operation.members) {
    const assignment = state.assignments.find((entry) => entry.id === member.reviewed.assignmentId);
    const grant = state.integrationGrants.find(
      (entry) => entry.id === member.authority.integrationGrantId,
    );
    const capability = state.integrationCapabilities.find(
      (entry) => entry.id === member.authority.capabilityId,
    );
    if (
      !grant ||
      grant.lifecycle.phase !== "active" ||
      grant.integrationId !== operation.integrationId ||
      grant.participantAssignmentId !== member.reviewed.assignmentId ||
      grant.projectId !== member.reviewed.projectId ||
      grant.ownerManagerId !== assignment?.managerId ||
      grant.capabilityId !== member.authority.capabilityId ||
      grant.boundaryId !== member.authority.boundaryId ||
      !capability ||
      capability.supersededBy !== null ||
      capability.boundaryId !== member.authority.boundaryId ||
      capability.qualification.status !== "qualified"
    )
      reasons.push(
        `Project ${member.reviewed.projectId} withdrew or changed its integration resources.`,
      );
    if (
      state.controls.some(
        (entry) =>
          entry.kind === "project-pause" &&
          entry.status === "active" &&
          entry.projectId === member.reviewed.projectId,
      )
    )
      reasons.push(`Project ${member.reviewed.projectId} is paused.`);
    const incident = factoryIncidentBlocked(state, member.reviewed.assignmentId, "delivery");
    if (incident) reasons.push(incident);
    // A merged member's assignment moves on to completion, so only its receipt is checked.
    if (member.outcome.phase === "confirmed") {
      if (!receiptMatches(operation, member, member.outcome.receipt))
        reasons.push("A confirmed member receipt does not match this operation.");
      continue;
    }
    const revision = assignment?.delivery?.revisions.find(
      (entry) => entry.id === member.reviewed.revisionId,
    );
    if (
      !active(assignment) ||
      !revision ||
      assignment.threadId !== member.reviewed.leadThreadId ||
      assignment.delivery?.currentRevisionId !== revision.id ||
      assignment.grant?.epoch !== member.authority.grantEpoch ||
      assignment.grant.boundaryId !== member.authority.boundaryId ||
      revision.bundleDigest !== member.reviewed.bundleDigest ||
      revision.candidateDigest !== member.reviewed.candidateDigest ||
      revision.publication?.headSha !== member.reviewed.headSha ||
      revision.publication.baseBranch !== member.authority.targetBranch ||
      !revision.publication.ref ||
      canonicalFactoryPullRequest(revision.publication.ref) !==
        canonicalFactoryPullRequest(member.reviewed.ref) ||
      revision.hostEvidence?.baseSha !== member.reviewed.baseSha
    ) {
      reasons.push(
        `Member ${member.reviewed.assignmentId} no longer matches the exact reviewed revision and grant.`,
      );
      continue;
    }
    const ready = factoryDeliveryReadiness(state, assignment, revision);
    reasons.push(...ready.reasons);
    if (
      ready.needsHuman !== member.reviewed.needsHuman ||
      ready.ruleEligible !== member.reviewed.ruleEligible ||
      ready.ruleVersion !== member.reviewed.ruleVersion ||
      (ready.needsHuman && (!ready.humanApproved || review?.decision?.outcome !== "approved"))
    )
      reasons.push(
        `Member ${assignment.id} needs a fresh exact approval under its current policy.`,
      );
  }
  if (lead) {
    const incident = factoryIncidentBlocked(state, lead.id, "delivery");
    if (incident) reasons.push(incident);
    if (
      state.controls.some(
        (entry) =>
          entry.kind === "takeover" &&
          entry.status === "active" &&
          [
            lead.threadId,
            ...operation.members
              .filter((entry) => entry.outcome.phase !== "confirmed")
              .map((entry) => entry.reviewed.leadThreadId),
          ].includes(entry.threadId),
      )
    )
      reasons.push("Human takeover holds the shared merge action until handback.");
  }
  const selected = operation.members.find((entry) => entry.reviewed.assignmentId === assignmentId);
  // Members merge one at a time in the frozen order, so confirmed members are always a prefix.
  if (operation.members.find((entry) => entry.outcome.phase !== "confirmed") !== selected)
    reasons.push("Merge members in the frozen operation order.");
  if (
    !selected ||
    selected.outcome.phase === "confirmed" ||
    (selected.outcome.phase === "pending" && selected.attempts >= 3)
  )
    reasons.push("This member has completed or exhausted its three submission attempts.");
  // The selected member is excluded: the pull request gate runs after `submitting` has already
  // marked its own attempt unknown.
  if (
    operation.members.some(
      (entry) => entry.reviewed.assignmentId !== assignmentId && entry.outcome.phase === "unknown",
    )
  )
    reasons.push("Reconcile the previous member's unknown outcome before another write.");
  // `attention` is accepted so a retry can be checked before it returns the operation to running.
  if (operation.lifecycle.phase !== "running" && operation.lifecycle.phase !== "attention")
    reasons.push("This shared operation is not available for another write.");
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/**
 * The shared merge status and actions the group view offers. A stop before any submission counts
 * as idle, so the group may start again unless that exact reviewed vector already spent attempts.
 */
export function factoryMergeOperationReadiness(
  state: FactorySnapshot,
  groupId: string,
): FactoryMergeOperationReadiness {
  const operation = latestFactoryMergeOperation(state, groupId);
  const group = state.mergeGroups.find((entry) => entry.id === groupId);
  const confirmedCount =
    operation?.members.filter((entry) => entry.outcome.phase === "confirmed").length ?? 0;
  const pending = operation?.members.find((entry) => entry.outcome.phase === "pending");
  const safeStop =
    operation?.lifecycle.phase === "stopped" &&
    operation.members.every((entry) => entry.outcome.phase === "pending");
  const idle = !operation || safeStop;
  const reasons = operation?.lifecycle.phase === "attention" ? [operation.lifecycle.reason] : [];
  if (operation && pending && ["running", "attention"].includes(operation.lifecycle.phase))
    reasons.push(
      ...factoryMergeOperationWriteReadiness(state, operation.id, pending.reviewed.assignmentId)
        .reasons,
    );
  const repeated =
    idle &&
    group?.currentReviewId !== null &&
    group?.currentReviewId !== undefined &&
    attemptedReviewVector(state, groupId, group.currentReviewId);
  if (repeated)
    reasons.push("Starting again cannot reset this exact reviewed vector's submission budget.");
  return {
    status: !operation
      ? "idle"
      : operation.lifecycle.phase === "completed"
        ? "completed"
        : operation.lifecycle.phase === "stopped"
          ? "stopped"
          : confirmedCount > 0
            ? "partial"
            : operation.lifecycle.phase === "running"
              ? "merging"
              : operation.lifecycle.phase,
    confirmedCount,
    memberCount: operation?.members.length ?? group?.memberAssignmentIds.length ?? 0,
    reasons: [...new Set(reasons)],
    recommendation:
      operation?.lifecycle.phase === "attention" ? operation.lifecycle.recommendation : null,
    canStart: idle && !repeated && factoryMergeGroupReadiness(state, groupId).status === "ready",
    canReconcile: operation !== undefined && operation.lifecycle.phase !== "completed",
    canRetry:
      operation?.lifecycle.phase === "attention" &&
      operation.lifecycle.retry === "same-vector" &&
      pending !== undefined &&
      factoryMergeOperationWriteReadiness(state, operation.id, pending.reviewed.assignmentId)
        .allowed,
    canStop:
      operation !== undefined && !["stopped", "completed"].includes(operation.lifecycle.phase),
    canRelease: group !== undefined && factoryMergeGroupReleaseBlock(state, group) === null,
    canRestore: group !== undefined && factoryMergeGroupRestoreBlock(state, group) === null,
    deploymentGate: factoryMergeDeploymentGate(group?.memberAssignmentIds ?? [], state.assignments),
  };
}

/**
 * Decides `merge.group.start` and every `merge.operation.*` command. The human or the current
 * integration lead starts, reconciles, escalates and retries; only the human stops; only the host
 * records what happened. An operation runs preparing, running, completed, with attention and
 * stopped beside them. It never merges itself and never replaces a confirmed receipt.
 */
export function decideFactoryMergeOperation(input: {
  state: FactorySnapshot;
  actor: FactoryActor;
  command: FactoryDecisionCommand;
  now: string;
}): Result.Result<FactoryDecision, FactoryError> | undefined {
  const { state, actor, command, now } = input;
  if (command.type !== "merge.group.start" && !command.type.startsWith("merge.operation."))
    return undefined;
  const fail = (detail: string, code: FactoryError["code"] = "invalid-state") =>
    Result.fail(new FactoryError({ code, detail }));
  const save = (
    operation: FactoryMergeOperation,
    effects: readonly FactoryEffectIntent[] = [],
    assignments = state.assignments,
  ): Result.Result<FactoryDecision, FactoryError> => {
    // Publish readiness whenever it changes; reconcile republishes one not yet confirmed.
    const signal = factoryMergeSignal(operation);
    const previous = state.mergeOperations.find((entry) => entry.id === operation.id);
    const publish =
      signal !== null &&
      operation.signal?.digest !== signal.digest &&
      (command.type === "merge.operation.reconcile" ||
        (previous ? factoryMergeSignal(previous)?.digest : undefined) !== signal.digest);
    return Result.succeed({
      state: {
        ...state,
        revision: state.revision + 1,
        assignments,
        mergeOperations: state.mergeOperations.some((entry) => entry.id === operation.id)
          ? state.mergeOperations.map((entry) =>
              entry.id === operation.id ? { ...operation, updatedAt: now } : entry,
            )
          : [...state.mergeOperations, { ...operation, updatedAt: now }],
      },
      result: {
        revision: state.revision + 1,
        mergeOperationId: operation.id,
        mergeGroupId: operation.groupId,
      },
      effects: publish
        ? [...effects, { type: "merge.operation.signal", operationId: operation.id }]
        : effects,
    });
  };
  const host = actor.kind === "system";
  if (command.type === "merge.group.start") {
    const group = state.mergeGroups.find((entry) => entry.id === command.groupId);
    const lead = state.assignments.find((entry) => entry.id === group?.integrationAssignmentId);
    const review = state.mergeGroupReviews.find((entry) => entry.id === command.reviewId);
    if (
      !group ||
      !active(lead) ||
      !(actor.kind === "human" || (actor.kind === "thread" && actor.threadId === lead.threadId))
    )
      return fail(
        "Only the human or current integration lead may request this shared action.",
        "permission-denied",
      );
    if (currentFactoryMergeOperation(state, group.integrationId))
      return fail(
        "This group already has a shared operation. Inspect its actual outcomes.",
        "command-conflict",
      );
    const readiness = factoryMergeGroupReadiness(state, group.id);
    if (
      readiness.status !== "ready" ||
      review?.lifecycle.phase !== "sealed" ||
      group.currentReviewId !== review.id ||
      review.lifecycle.digest !== command.expectedDigest
    )
      return fail(
        readiness.reasons.join(" ") || "The exact reviewed vector changed.",
        "stale-revision",
      );
    // The freeze stops the integration and captures its bytes; work still in flight would race it.
    if (
      state.integrationPreparations.some(
        (entry) =>
          entry.integrationId === group.integrationId && entry.lifecycle.phase === "requested",
      ) ||
      state.integrationVerifications.some(
        (entry) =>
          entry.integrationId === group.integrationId && entry.lifecycle.phase === "requested",
      )
    )
      return fail(
        "Wait for integration preparation or verification to finish before freezing merge evidence.",
      );
    const sealed = review.lifecycle;
    const preparation = state.integrationPreparations.find(
      (entry) => entry.id === sealed.integrationPreparationId,
    );
    if (preparation?.lifecycle.phase !== "ready")
      return fail("The verified integration preparation is unavailable.");
    const members: FactoryMergeOperationMember[] = [];
    // Canonical PR order, so every start of the same vector merges its members in the same order.
    for (const reviewed of [...review.lifecycle.members].sort((a, b) =>
      canonicalFactoryPullRequest(a.ref).localeCompare(canonicalFactoryPullRequest(b.ref)),
    )) {
      const assignment = state.assignments.find((entry) => entry.id === reviewed.assignmentId);
      const basis = preparation.lifecycle.manifest.inputs.find(
        (entry) => entry.assignmentId === reviewed.assignmentId,
      );
      const revision = assignment?.delivery?.revisions.find(
        (entry) => entry.id === reviewed.revisionId,
      );
      if (!assignment?.grant || !basis || !revision?.publication)
        return fail("A reviewed member's source authority is unavailable.");
      members.push({
        reviewed,
        authority: {
          boundaryId: assignment.grant.boundaryId,
          grantEpoch: assignment.grant.epoch,
          integrationGrantId: basis.integrationGrantId,
          capabilityId: basis.capabilityId,
          targetBranch: revision.publication.baseBranch,
        },
        attempts: 0,
        outcome: { phase: "pending" },
      });
    }
    if (attemptedReviewVector(state, group.id, review.id))
      return fail(
        "A previous operation already attempted this exact reviewed vector. Stopping and starting again cannot reset its submission budget. Use its recovery decision or a separately authorized changed task.",
        "command-conflict",
      );
    const operation: FactoryMergeOperation = {
      id: `merge-operation:${command.commandId}`,
      groupId: group.id,
      integrationId: group.integrationId,
      integrationAssignmentId: group.integrationAssignmentId,
      reviewId: review.id,
      reviewDigest: review.lifecycle.digest,
      authorizingCommandId: command.commandId,
      members,
      lifecycle: { phase: "preparing" },
      createdAt: now,
      updatedAt: now,
    };
    return save(operation, [{ type: "merge.operation.prepare", operationId: operation.id }]);
  }
  if (!("operationId" in command)) return fail("Select the shared merge operation.");
  const operation = state.mergeOperations.find((entry) => entry.id === command.operationId);
  if (!operation) return fail("This shared merge operation is unavailable.");
  const lead = state.assignments.find((entry) => entry.id === operation.integrationAssignmentId);
  const owns =
    actor.kind === "human" || (actor.kind === "thread" && actor.threadId === lead?.threadId);
  const frozen = factoryMergeFrozenProof(operation);
  const effect = (
    type: "merge.operation.advance" | "merge.operation.reconcile" | "merge.operation.resume",
  ): FactoryEffectIntent => ({ type, operationId: operation.id });
  const notify = (event: string, text: string): FactoryEffectIntent => ({
    type: "merge.group.notify",
    groupId: operation.groupId,
    eventId: `${operation.id}:${event}`,
    recipientAssignmentIds: [
      operation.integrationAssignmentId,
      ...operation.members.map((entry) => entry.reviewed.assignmentId),
    ],
    text,
  });
  // `retry` names the way out: reconcile first, retry the same vector, review anew, or nothing.
  const hold = (
    reason: string,
    recommendation: string,
    retry: "reconcile" | "same-vector" | "new-review" | "none",
    members = operation.members,
  ) =>
    save(
      {
        ...operation,
        members,
        lifecycle: { phase: "attention", frozen, reason, recommendation, retry },
      },
      [notify(`attention:${command.commandId}`, `${reason}\n${recommendation}`)],
    );
  switch (command.type) {
    case "merge.operation.reconcile":
      // Allowed in every phase, stopped included, because only the host can say what an uncertain
      // submission did. On a completed operation it only republishes an unconfirmed signal.
      if (!owns)
        return fail(
          "Only this integration lead or the human can request reconciliation.",
          "permission-denied",
        );
      return save(
        operation,
        operation.lifecycle.phase === "completed" ? [] : [effect("merge.operation.reconcile")],
      );
    case "merge.operation.stop":
      if (actor.kind !== "human")
        return fail("Only the human can stop the shared action.", "permission-denied");
      if (operation.lifecycle.phase === "completed")
        return fail("All merges are confirmed. A revert requires a separately authorized task.");
      // An uncertain submission is read again rather than assumed. A stop before any submission
      // resumes the team's paused work; after a confirmed merge the team stays frozen.
      return save(
        {
          ...operation,
          lifecycle: { phase: "stopped", frozen, reason: command.reason, stoppedAt: now },
        },
        operation.members.some((entry) => entry.outcome.phase === "unknown")
          ? [effect("merge.operation.reconcile")]
          : operation.members.every((entry) => entry.outcome.phase === "pending")
            ? [effect("merge.operation.resume")]
            : [],
      );
    case "merge.operation.escalate":
      // Holds further automatic submissions and hands the decision, such as a revert, to the human.
      if (!owns)
        return fail(
          "Only this integration lead or the human can escalate the shared action.",
          "permission-denied",
        );
      if (operation.lifecycle.phase !== "running" && operation.lifecycle.phase !== "attention")
        return fail("Only a running or held shared merge can be escalated.");
      return hold(
        command.reason,
        command.recommendation,
        operation.lifecycle.phase === "attention"
          ? operation.lifecycle.retry
          : operation.members.some((entry) => entry.outcome.phase === "unknown")
            ? "reconcile"
            : "same-vector",
      );
    case "merge.operation.retry": {
      const next = operation.members.find((entry) => entry.outcome.phase === "pending");
      if (
        !owns ||
        operation.lifecycle.phase !== "attention" ||
        operation.lifecycle.retry !== "same-vector" ||
        !frozen ||
        !next
      )
        return fail(
          "This operation needs reconciliation or a separate recovery decision before retry.",
          "permission-denied",
        );
      const readiness = factoryMergeOperationWriteReadiness(
        state,
        operation.id,
        next.reviewed.assignmentId,
      );
      if (!readiness.allowed) return fail(readiness.reasons.join(" "), "permission-denied");
      return save({ ...operation, lifecycle: { phase: "running", frozen } }, [
        effect("merge.operation.advance"),
      ]);
    }
    case "merge.operation.frozen": {
      // The host freezes against the state revision it captured, so any change in between is
      // refused rather than frozen into the proof.
      if (
        !host ||
        operation.lifecycle.phase !== "preparing" ||
        state.revision !== command.expectedStateRevision
      )
        return fail("The merge freeze no longer matches current preparation.", "stale-revision");
      const evidence = factoryMergeGroupEvidence(state, operation.groupId);
      const { digest, ...proof } = command.frozen;
      const review = state.mergeGroupReviews.find((entry) => entry.id === operation.reviewId);
      if (
        !evidence.ready ||
        review?.lifecycle.phase !== "sealed" ||
        review.lifecycle.digest !== operation.reviewDigest ||
        command.frozen.integrationPreparationId !== evidence.integrationPreparationId ||
        command.frozen.integrationVerificationId !== evidence.integrationVerificationId ||
        command.frozen.inputDigest !== evidence.inputDigest ||
        command.frozen.testArtifactDigest !== evidence.testArtifactDigest ||
        command.frozen.captureDigest !== evidence.testArtifactDigest ||
        factoryMergeFrozenDigest(operation, proof) !== digest
      )
        return fail(
          "The stopped capture does not match this operation's reviewed evidence.",
          "stale-revision",
        );
      const next = {
        ...operation,
        lifecycle: { phase: "running" as const, frozen: command.frozen },
      };
      // Check the first member as though the freeze had landed; a failing proof never runs.
      const readiness = factoryMergeOperationWriteReadiness(
        {
          ...state,
          mergeOperations: state.mergeOperations.map((entry) =>
            entry.id === operation.id ? next : entry,
          ),
        },
        operation.id,
        operation.members[0]!.reviewed.assignmentId,
      );
      if (!readiness.allowed) return fail(readiness.reasons.join(" "), "stale-revision");
      return save(next, [effect("merge.operation.advance")]);
    }
    case "merge.operation.submitting": {
      const member = operation.members.find(
        (entry) => entry.reviewed.assignmentId === command.assignmentId,
      );
      if (
        !host ||
        operation.lifecycle.phase !== "running" ||
        !member ||
        member.outcome.phase !== "pending" ||
        member.attempts !== command.expectedAttempt ||
        member.attempts >= 3 ||
        state.revision !== command.expectedStateRevision ||
        command.evidenceDigest !== frozen?.digest
      )
        return fail(
          "This submission no longer matches the current member attempt.",
          "stale-revision",
        );
      // Deployment pipelines tell grouped merge commits apart by this label.
      if (member.labeled !== true)
        return fail(
          `Confirm the ${FACTORY_MERGE_GROUP_LABEL} label on this member PR before merging it.`,
          "permission-denied",
        );
      const readiness = factoryMergeOperationWriteReadiness(
        state,
        operation.id,
        command.assignmentId,
      );
      if (!readiness.allowed) return fail(readiness.reasons.join(" "), "permission-denied");
      // The attempt is spent and marked unknown before the host calls GitHub, so a crash mid-call
      // leaves an outcome to reconcile instead of a write to repeat.
      return save(
        {
          ...operation,
          members: operation.members.map((entry) =>
            entry === member
              ? {
                  ...entry,
                  attempts: entry.attempts + 1,
                  outcome: {
                    phase: "unknown",
                    attemptId: command.attemptId,
                    submittedAt: now,
                    reason: null,
                  },
                }
              : entry,
          ),
        },
        [effect("merge.operation.reconcile")],
      );
    }
    case "merge.operation.labeled": {
      if (!host) return fail("Only the host confirms a merge group label.", "permission-denied");
      const member = operation.members.find(
        (entry) => entry.reviewed.assignmentId === command.assignmentId,
      );
      if (!member) return fail("This label confirmation names a foreign member.");
      return save({
        ...operation,
        members: operation.members.map((entry) =>
          entry === member ? { ...entry, labeled: true } : entry,
        ),
      });
    }
    case "merge.operation.signaled": {
      if (!host)
        return fail("Only the host confirms published deployment readiness.", "permission-denied");
      const signal = factoryMergeSignal(operation);
      // A receipt for an older state changes nothing; the newer state has its own pending effect.
      if (signal?.digest !== command.digest) return save(operation);
      return save({
        ...operation,
        signal: { state: signal.state, digest: signal.digest, publishedAt: now },
      });
    }
    case "merge.operation.held":
      if (!host)
        return fail("Only the host records shared execution failure.", "permission-denied");
      // A late failure report cannot reopen a stopped or completed operation.
      if (["completed", "stopped"].includes(operation.lifecycle.phase)) return save(operation);
      return hold(command.reason, command.recommendation, command.retry);
    case "merge.operation.observed": {
      if (!host)
        return fail("Only verified host observations record merge results.", "permission-denied");
      const member = operation.members.find(
        (entry) => entry.reviewed.assignmentId === command.assignmentId,
      );
      if (!member) return fail("This observation names a foreign member.");
      // Repeating the same receipt is a no-op; any other observation would rewrite a real merge.
      if (member.outcome.phase === "confirmed")
        return command.observation.phase === "confirmed" &&
          same(member.outcome.receipt, command.observation.receipt)
          ? save(operation)
          : fail("A confirmed merge receipt cannot be replaced.", "stale-revision");
      // An observation of an unknown outcome must name its current attempt; one taken before any
      // submission must name none.
      if (
        (member.outcome.phase === "unknown" && command.attemptId !== member.outcome.attemptId) ||
        (member.outcome.phase !== "unknown" && command.attemptId !== undefined)
      )
        return fail(
          "This observation belongs to an obsolete submission attempt.",
          "stale-revision",
        );
      const observed = command.observation;
      if (observed.phase === "confirmed") {
        if (!receiptMatches(operation, member, observed.receipt))
          return fail("The actual merge belongs to another reviewed revision.", "stale-revision");
        const members = operation.members.map((entry) =>
          entry === member
            ? { ...entry, outcome: { phase: "confirmed" as const, receipt: observed.receipt } }
            : entry,
        );
        // Record the merge on the member's assignment as an individual merge would, unless its
        // revision moved on or its completion already closed.
        const assignments = state.assignments.map((entry) => {
          if (
            entry.id !== member.reviewed.assignmentId ||
            entry.delivery?.currentRevisionId !== member.reviewed.revisionId ||
            (entry.completion && entry.completion.phase !== "collecting")
          )
            return entry;
          const completion = entry.completion ?? initialFactoryCompletion(entry.scope);
          const delivery = {
            kind: "pull-request-merged" as const,
            id: observed.receipt.id,
            projectId: entry.projectId,
            ref: observed.receipt.ref,
            headSha: observed.receipt.headSha,
            mergedAt: observed.receipt.mergedAt,
            observedAt: observed.receipt.observedAt,
          };
          return {
            ...entry,
            completion: {
              ...completion,
              deliveries: [
                ...completion.deliveries.filter((item) => item.id !== delivery.id),
                delivery,
              ],
            },
            delivery: {
              ...entry.delivery,
              // Merged work no longer waits on direction, as for an individual merge.
              directionHeld: false,
              revisions: entry.delivery.revisions.map((revision) =>
                revision.id === member.reviewed.revisionId
                  ? {
                      ...revision,
                      merge: {
                        operationId: operation.id,
                        status: "merged" as const,
                        requestedAt: operation.createdAt,
                        mergedAt: observed.receipt.mergedAt,
                      },
                    }
                  : revision,
              ),
            },
          };
        });
        // A merge seen before the freeze happened outside the frozen evidence, so nothing retries.
        // Otherwise a hold becomes retryable once no outcome is uncertain.
        const lifecycle =
          !frozen && operation.lifecycle.phase !== "stopped"
            ? {
                phase: "attention" as const,
                frozen: null,
                reason:
                  "A reviewed member merged before the stopped integration evidence could be frozen.",
                recommendation:
                  "The actual merge is preserved. Review the combined evidence and remaining outcomes through a separately authorized recovery task.",
                retry: "none" as const,
              }
            : operation.lifecycle.phase === "attention" &&
                members.every((entry) => entry.outcome.phase !== "unknown")
              ? { ...operation.lifecycle, retry: "same-vector" as const }
              : operation.lifecycle;
        return save(
          { ...operation, members, lifecycle },
          [
            // Advance merges the next member while running; once all are confirmed it completes
            // the operation from any phase.
            ...(frozen &&
            (operation.lifecycle.phase === "running" ||
              members.every((entry) => entry.outcome.phase === "confirmed"))
              ? [effect("merge.operation.advance")]
              : []),
            notify(
              `confirmed:${member.reviewed.assignmentId}`,
              `${members.filter((entry) => entry.outcome.phase === "confirmed").length} of ${members.length} linked PRs have confirmed actual merges.`,
            ),
          ],
          assignments,
        );
      }
      if (observed.phase === "open" || observed.phase === "rejected") {
        if (
          observed.headSha !== member.reviewed.headSha ||
          observed.targetBranch !== member.authority.targetBranch
        ) {
          if (operation.lifecycle.phase === "stopped") return save(operation);
          return hold(
            "A member's host head or target branch changed.",
            "Stop and review the remaining PRs with their owning leads. Do not revert successful members without separate authorization.",
            "new-review",
          );
        }
        if (observed.phase === "rejected") {
          if (member.outcome.phase !== "unknown")
            return fail("A rejection must identify its submitted attempt.");
          const members = operation.members.map((entry) =>
            entry === member ? { ...entry, outcome: { phase: "pending" as const } } : entry,
          );
          if (operation.lifecycle.phase === "stopped")
            return save(
              { ...operation, members },
              members.every((entry) => entry.outcome.phase === "pending")
                ? [effect("merge.operation.resume")]
                : [],
            );
          // Nothing retries on its own: a rate limit would otherwise spend every attempt at once.
          return hold(
            observed.reason,
            member.attempts >= 3
              ? "Three conditional submissions were attempted. Review the actual outcomes and authorize any further recovery as a separate task."
              : observed.classification === "transient"
                ? "The host refused this merge without merging it, for example under a rate limit. Retry the remaining merges once it clears; each retry uses one of three submissions."
                : "Resolve the rejected merge with its owning lead before deciding whether the unchanged vector is still safe.",
            member.attempts >= 3 ? "none" : "same-vector",
            members,
          );
        }
        // Expected for a member not yet submitted. Once no outcome is uncertain, a frozen hold
        // becomes retryable; write readiness still gates the retry itself.
        if (member.outcome.phase === "pending")
          return save(
            operation.lifecycle.phase === "attention" &&
              frozen &&
              operation.members.every((entry) => entry.outcome.phase !== "unknown")
              ? { ...operation, lifecycle: { ...operation.lifecycle, retry: "same-vector" } }
              : operation,
          );
        // The exact PR is open with no auto-merge or queue instruction left to complete it, so the
        // submission did not merge. A retry stays conditional on the reviewed head.
        const members = operation.members.map((entry) =>
          entry === member ? { ...entry, outcome: { phase: "pending" as const } } : entry,
        );
        if (operation.lifecycle.phase === "stopped")
          return save(
            { ...operation, members },
            members.every((entry) => entry.outcome.phase === "pending")
              ? [effect("merge.operation.resume")]
              : [],
          );
        return hold(
          "The host shows this member's PR still open with no pending merge instruction, so the submitted merge did not complete.",
          member.attempts >= 3
            ? "Three conditional submissions were attempted. Review the actual outcomes and authorize any further recovery as a separate task."
            : "Retry the remaining merges when ready. Each retry is conditional on the reviewed head and uses one of three submissions.",
          member.attempts >= 3 ? "none" : "same-vector",
          members,
        );
      }
      // Unresolved: hold for reconciliation, never retry, because the host has not shown that the
      // submission can no longer complete.
      if (operation.lifecycle.phase === "stopped") return save(operation);
      return hold(
        observed.reason,
        member.outcome.phase === "pending"
          ? "Nothing was submitted for this member. Resolve its PR with the owning lead, then reconcile."
          : "Reconcile actual host outcomes before deciding recovery. The host has not shown that the submitted merge can no longer complete.",
        "reconcile",
      );
    }
    case "merge.operation.completed":
      if (
        !host ||
        !frozen ||
        !operation.members.every(
          (entry) =>
            entry.outcome.phase === "confirmed" &&
            receiptMatches(operation, entry, entry.outcome.receipt),
        ) ||
        factoryMergeReceiptDigest(operation) !== command.receiptDigest
      )
        return fail(
          "Every exact member must have a confirmed actual merge receipt before group completion.",
          "stale-revision",
        );
      if (operation.lifecycle.phase === "completed") return save(operation);
      return save(
        {
          ...operation,
          lifecycle: {
            phase: "completed",
            frozen,
            receiptDigest: command.receiptDigest,
            completedAt: now,
          },
        },
        [
          notify(
            "completed",
            "Every linked pull request has actually merged. The integration team can now conclude and run its retrospective with the requesting manager.",
          ),
        ],
      );
  }
  return fail("Unsupported shared merge command.");
}
