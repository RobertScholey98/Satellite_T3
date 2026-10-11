import {
  FACTORY_MERGE_GROUP_LABEL,
  FACTORY_MERGE_GROUP_STATUS_CONTEXT,
  FactoryError,
  type FactoryAssignment,
  type FactoryAssignmentId,
  type FactoryDecisionCommand,
  type FactoryEffectIntent,
  type FactoryMergeFrozenProof,
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
import { canonicalFactoryPullRequest } from "./FactoryMergeOwnership.ts";
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
 * Whether merged members publish Group deployment readiness. Managed publication only targets
 * GitHub, so a member is supported once its current revision has a published pull request.
 */
export function factoryMergeDeploymentGate(state: FactorySnapshot, groupId: string) {
  const group = state.mergeGroups.find((entry) => entry.id === groupId);
  const missing = (group?.memberAssignmentIds ?? []).flatMap((id) => {
    const assignment = state.assignments.find((entry) => entry.id === id);
    const revision = assignment?.delivery?.revisions.find(
      (entry) => entry.id === assignment.delivery?.currentRevisionId,
    );
    return revision?.publication?.ref?.host ? [] : [assignment?.projectId ?? id];
  });
  return missing.length
    ? {
        supported: false,
        detail: `Deployment gate unsupported for ${missing.join(", ")}: only GitHub pull requests publish the ${FACTORY_MERGE_GROUP_STATUS_CONTEXT} status.`,
      }
    : {
        supported: true,
        detail: `Deployment gate: GitHub status ${FACTORY_MERGE_GROUP_STATUS_CONTEXT} on each merge commit.`,
      };
}

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
  if (operation.members.find((entry) => entry.outcome.phase !== "confirmed") !== selected)
    reasons.push("Merge members in the frozen operation order.");
  if (
    !selected ||
    selected.outcome.phase === "confirmed" ||
    (selected.outcome.phase === "pending" && selected.attempts >= 3)
  )
    reasons.push("This member has completed or exhausted its three submission attempts.");
  if (
    operation.members.some(
      (entry) => entry.reviewed.assignmentId !== assignmentId && entry.outcome.phase === "unknown",
    )
  )
    reasons.push("Reconcile the previous member's unknown outcome before another write.");
  if (operation.lifecycle.phase !== "running" && operation.lifecycle.phase !== "attention")
    reasons.push("This shared operation is not available for another write.");
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}

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
    deploymentGate: factoryMergeDeploymentGate(state, groupId),
  };
}

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
      if (["completed", "stopped"].includes(operation.lifecycle.phase)) return save(operation);
      return hold(command.reason, command.recommendation, command.retry);
    case "merge.operation.observed": {
      if (!host)
        return fail("Only verified host observations record merge results.", "permission-denied");
      const member = operation.members.find(
        (entry) => entry.reviewed.assignmentId === command.assignmentId,
      );
      if (!member) return fail("This observation names a foreign member.");
      if (member.outcome.phase === "confirmed")
        return command.observation.phase === "confirmed" &&
          same(member.outcome.receipt, command.observation.receipt)
          ? save(operation)
          : fail("A confirmed merge receipt cannot be replaced.", "stale-revision");
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
          if (
            observed.classification === "transient" &&
            member.attempts < 3 &&
            frozen &&
            operation.lifecycle.phase === "running"
          )
            return save({ ...operation, members, lifecycle: { phase: "running", frozen } }, [
              effect("merge.operation.advance"),
            ]);
          return hold(
            observed.reason,
            member.attempts >= 3
              ? "Three conditional submissions were attempted. Review the actual outcomes and authorize any further recovery as a separate task."
              : "Resolve the rejected merge with its owning lead before deciding whether the unchanged vector is still safe.",
            member.attempts >= 3 ? "none" : "same-vector",
            members,
          );
        }
        if (member.outcome.phase === "pending")
          return save(
            operation.lifecycle.phase === "attention" &&
              frozen &&
              operation.members.every((entry) => entry.outcome.phase !== "unknown")
              ? { ...operation, lifecycle: { ...operation.lifecycle, retry: "same-vector" } }
              : operation,
          );
      }
      if (operation.lifecycle.phase === "stopped") return save(operation);
      return hold(
        observed.phase === "unresolved"
          ? observed.reason
          : "The host has not confirmed whether the submitted merge completed.",
        "Reconcile actual host outcomes before deciding recovery. An open PR alone does not prove the previous request cannot still complete.",
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
