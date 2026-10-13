import {
  type FactorySnapshot,
  type FactoryMergeFrozenProof,
  type FactoryAssignmentId,
} from "@t3tools/contracts";
import {
  reviewedMergeFixture,
  applyMerge,
  mergeCommandId,
  deliveryNow,
} from "./FactoryMerge.testkit.ts";
import {
  factoryMergeFrozenDigest,
  factoryMergeFrozenProof,
  factoryMergeReceiptDigest,
} from "./FactoryMergeOperation.ts";

export { applyMerge, mergeCommandId, deliveryNow };
export function startedMergeOperationFixture() {
  const fixture = reviewedMergeFixture();
  const approved = applyMerge(fixture.state, {
    type: "merge.group.approve",
    commandId: mergeCommandId(),
    groupId: fixture.groupId,
    reviewId: fixture.reviewId,
    expectedDigest: fixture.reviewDigest,
  });
  const started = applyMerge(approved.state, {
    type: "merge.group.start",
    commandId: mergeCommandId(),
    groupId: fixture.groupId,
    reviewId: fixture.reviewId,
    expectedDigest: fixture.reviewDigest,
  });
  return { ...fixture, ...started, operationId: started.result.mergeOperationId! };
}
export function mergeFrozenProof(
  state: FactorySnapshot,
  operationId: string,
): FactoryMergeFrozenProof {
  const operation = state.mergeOperations.find((entry) => entry.id === operationId)!;
  const review = state.mergeGroupReviews.find((entry) => entry.id === operation.reviewId)!;
  if (review.lifecycle.phase !== "sealed") throw new Error("Expected sealed review");
  const sealed = review.lifecycle;
  const preparation = state.integrationPreparations.find(
    (entry) => entry.id === sealed.integrationPreparationId,
  )!;
  if (preparation.lifecycle.phase !== "ready") throw new Error("Expected ready preparation");
  const lead = state.assignments.find((entry) => entry.id === operation.integrationAssignmentId)!;
  const proof = {
    integrationPreparationId: preparation.id,
    integrationVerificationId: sealed.integrationVerificationId,
    inputDigest: sealed.inputDigest,
    testArtifactDigest: sealed.testArtifactDigest,
    captureArtifactId: "stopped-capture",
    captureDigest: sealed.testArtifactDigest,
    coordinatorCapabilityId: preparation.lifecycle.manifest.coordinatorCapabilityId,
    coordinatorDigest: preparation.lifecycle.manifest.coordinatorDigest,
    integrationLeadThreadId: lead.threadId,
    integrationGrantEpoch: lead.grant?.epoch ?? 0,
    planIds: preparation.lifecycle.manifest.planIds,
    stoppedAt: deliveryNow,
  };
  return { ...proof, digest: factoryMergeFrozenDigest(operation, proof) };
}
export function frozenMergeOperationFixture() {
  const fixture = startedMergeOperationFixture();
  const frozen = mergeFrozenProof(fixture.state, fixture.operationId);
  const result = applyMerge(
    fixture.state,
    {
      type: "merge.operation.frozen",
      commandId: mergeCommandId(),
      operationId: fixture.operationId,
      expectedStateRevision: fixture.state.revision,
      frozen,
    },
    { kind: "system" },
  );
  return { ...fixture, ...result, frozen };
}
export function submitMergeMember(
  state: FactorySnapshot,
  operationId: string,
  assignmentId?: FactoryAssignmentId,
) {
  const operation = state.mergeOperations.find((entry) => entry.id === operationId)!;
  const member = operation.members.find((entry) =>
    assignmentId
      ? entry.reviewed.assignmentId === assignmentId
      : entry.outcome.phase !== "confirmed",
  )!;
  const attemptId = `${operationId}:${member.reviewed.assignmentId}:${member.attempts + 1}`;
  const labeled = member.labeled
    ? state
    : applyMerge(
        state,
        {
          type: "merge.operation.labeled",
          commandId: mergeCommandId(),
          operationId,
          assignmentId: member.reviewed.assignmentId,
        },
        { kind: "system" },
      ).state;
  const result = applyMerge(
    labeled,
    {
      type: "merge.operation.submitting",
      commandId: mergeCommandId(),
      operationId,
      assignmentId: member.reviewed.assignmentId,
      attemptId,
      expectedAttempt: member.attempts,
      expectedStateRevision: labeled.revision,
      evidenceDigest: factoryMergeFrozenProof(operation)!.digest,
    },
    { kind: "system" },
  );
  return { ...result, attemptId, assignmentId: member.reviewed.assignmentId };
}
export function confirmMergeMember(
  state: FactorySnapshot,
  operationId: string,
  assignmentId: FactoryAssignmentId,
) {
  const operation = state.mergeOperations.find((entry) => entry.id === operationId)!;
  const member = operation.members.find((entry) => entry.reviewed.assignmentId === assignmentId)!;
  return applyMerge(
    state,
    {
      type: "merge.operation.observed",
      commandId: mergeCommandId(),
      operationId,
      assignmentId,
      ...(member.outcome.phase === "unknown" ? { attemptId: member.outcome.attemptId } : {}),
      observation: {
        phase: "confirmed",
        receipt: {
          id: `merge-receipt:${operationId}:${assignmentId}`,
          operationId,
          assignmentId,
          revisionId: member.reviewed.revisionId,
          ref: member.reviewed.ref,
          headSha: member.reviewed.headSha,
          targetBranch: member.authority.targetBranch,
          mergeCommitSha: `merged-${assignmentId}`,
          mergedAt: deliveryNow,
          observedAt: deliveryNow,
        },
      },
    },
    { kind: "system" },
  );
}
export function completedMergeOperationFixture() {
  const fixture = frozenMergeOperationFixture();
  let state = fixture.state;
  for (const member of state.mergeOperations[0]!.members) {
    state = submitMergeMember(state, fixture.operationId, member.reviewed.assignmentId).state;
    state = confirmMergeMember(state, fixture.operationId, member.reviewed.assignmentId).state;
  }
  const operation = state.mergeOperations.find((entry) => entry.id === fixture.operationId)!;
  const result = applyMerge(
    state,
    {
      type: "merge.operation.completed",
      commandId: mergeCommandId(),
      operationId: operation.id,
      receiptDigest: factoryMergeReceiptDigest(operation),
    },
    { kind: "system" },
  );
  return { ...fixture, ...result };
}
