import type { FactoryAssignment, FactoryAuxiliaryThread, FactoryRetro } from "@t3tools/contracts";

/**
 * Whether an auxiliary thread (a diagnosis, delivery review or retrospective) still serves the
 * work it was started for. Access, model admission, execution and recovery all ask this before
 * letting the thread act, so a thread whose incident, revision or retro has moved on loses its
 * authority. Pass `retros` for retrospective threads; without them a retrospective is never
 * current.
 */
export function factoryAuxiliaryIsCurrent(
  assignment: FactoryAssignment | undefined,
  auxiliary: FactoryAuxiliaryThread,
  retros: ReadonlyArray<FactoryRetro> = [],
) {
  if (auxiliary.kind === "retrospective") {
    const retro = retros.find((entry) => entry.id === auxiliary.incidentId);
    return (
      assignment !== undefined &&
      retro !== undefined &&
      retro.assignmentId === assignment.id &&
      retro.threadId === auxiliary.threadId &&
      retro.conclusionId === assignment.completion?.conclusion?.id &&
      retro.evidenceDigest === assignment.completion?.conclusion?.evidenceDigest &&
      retro.execution.status === "ready" &&
      retro.reports.phase !== "complete" &&
      (auxiliary.status === "pending" || auxiliary.status === "running") &&
      auxiliary.qualification?.profileId === retro.execution.qualification.profileId &&
      auxiliary.sourceDigest === retro.execution.sourceDigest
    );
  }
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
  // A review is bound to the current revision and the exact candidate it was asked to review.
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
