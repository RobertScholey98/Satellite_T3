import type { FactoryAssignment, FactoryAuxiliaryThread, FactoryRetro } from "@t3tools/contracts";

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
