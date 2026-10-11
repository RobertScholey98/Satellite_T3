import type {
  FactoryMergeGroupRead,
  FactoryMergeMemberReadiness,
  FactorySnapshot,
  PullRequestRef,
} from "@t3tools/contracts";

export function factoryMergeDecisionIdentity(read: FactoryMergeGroupRead) {
  const review = read.currentReview;
  if (
    !review ||
    review.lifecycle.phase !== "sealed" ||
    read.group.currentReviewId !== review.id ||
    read.readiness.reviewId !== review.id ||
    read.readiness.reviewDigest !== review.lifecycle.digest
  )
    return null;
  return { groupId: read.group.id, reviewId: review.id, expectedDigest: review.lifecycle.digest };
}

export function factoryMergeMemberRevision(
  state: Pick<FactorySnapshot, "assignments">,
  member: FactoryMergeMemberReadiness,
) {
  const assignment = state.assignments.find((entry) => entry.id === member.assignmentId);
  if (
    !assignment ||
    assignment.threadId !== member.leadThreadId ||
    assignment.delivery?.currentRevisionId !== member.revisionId
  )
    return null;
  const revision = assignment.delivery.revisions.find((entry) => entry.id === member.revisionId);
  return revision?.publication?.headSha === member.headSha &&
    revision?.bundleDigest === member.bundleDigest
    ? revision
    : null;
}

export function factoryMergePullRequestUrl(ref: PullRequestRef | null) {
  if (!ref) return null;
  const host = ref.host ?? "github.com";
  return /^[a-z0-9.-]+$/i.test(host) && Number.isSafeInteger(ref.number) && ref.number > 0
    ? `https://${host}/${ref.repository.split("/").map(encodeURIComponent).join("/")}/pull/${ref.number}`
    : null;
}

export function factoryMergeEvidenceUrl(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function factoryMergeOperationActions(
  read: FactoryMergeGroupRead,
  permissions: { operate: boolean; write: boolean },
) {
  const operationId =
    read.operation?.groupId === read.group.id ? (read.operation?.id ?? null) : null;
  const decision = factoryMergeDecisionIdentity(read);
  const readiness = read.operationReadiness;
  return {
    start: permissions.operate && permissions.write && readiness.canStart ? decision : null,
    retry: permissions.operate && permissions.write && readiness.canRetry ? operationId : null,
    reconcile: permissions.operate && readiness.canReconcile ? operationId : null,
    stop: permissions.operate && readiness.canStop ? operationId : null,
  };
}

export function factoryMergeReviewLocked(read: FactoryMergeGroupRead) {
  const operation = read.operation;
  return (
    operation !== null &&
    (operation.lifecycle.phase !== "stopped" ||
      operation.members.some((member) => member.outcome.phase !== "pending"))
  );
}
