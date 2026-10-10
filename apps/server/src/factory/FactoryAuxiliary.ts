import type { FactoryAssignment, FactoryAuxiliaryThread } from "@t3tools/contracts";

export function factoryAuxiliaryIsCurrent(
  assignment: FactoryAssignment | undefined,
  auxiliary: FactoryAuxiliaryThread,
) {
  if (
    !assignment ||
    assignment.outcome ||
    assignment.status === "complete" ||
    (auxiliary.status !== "pending" && auxiliary.status !== "running")
  )
    return false;
  if (auxiliary.kind === "diagnosis") {
    const incident = assignment.oversight?.recovery.incident;
    return (
      incident?.phase === "diagnosing" &&
      incident.id === auxiliary.incidentId &&
      incident.diagnosisThreadId === auxiliary.threadId
    );
  }
  const revision = assignment.delivery?.revisions.find(
    (entry) => entry.id === auxiliary.revisionId,
  );
  return (
    assignment.delivery?.currentRevisionId === auxiliary.revisionId &&
    revision?.candidateDigest === auxiliary.sourceDigest &&
    revision?.reviews.some(
      (review) =>
        review.threadId === auxiliary.threadId &&
        review.id === auxiliary.incidentId &&
        (review.status === "pending" || review.status === "running"),
    ) === true
  );
}
