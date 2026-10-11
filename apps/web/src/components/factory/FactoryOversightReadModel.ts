import type {
  FactoryAssignment,
  FactoryDependency,
  FactorySnapshot,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

/** Captured allowance and current policy both constrain recovery; a new default never refills it. */
export function factoryRecoveryAllowance(snapshot: FactorySnapshot, assignment: FactoryAssignment) {
  const manager = snapshot.managers.find((entry) => entry.id === assignment.managerId);
  const limit = Math.min(
    assignment.grantedPolicy.recoveryCycles,
    manager?.overrides.recoveryCycles ?? snapshot.defaults.recoveryCycles,
  );
  const used = assignment.oversight?.recovery.cyclesUsed ?? 0;
  return { limit, used, remaining: Math.max(0, limit - used) };
}

/** Approval and delivery are separate from the receiving team's check of the exact delivery. */
export function factoryDependencyStatus(dependency: FactoryDependency) {
  const checked =
    dependency.delivery !== undefined &&
    dependency.usability?.deliveryId === dependency.delivery.id;
  if (checked) return dependency.usability?.usable ? "Usable" : "Delivered · not usable";
  if (dependency.delivery) return "Delivered · usability check needed";
  return {
    requested: "Work approval needed",
    approved: "Approved · awaiting supporting team",
    commissioned: "Supporting team working",
    checking: "Checking actual delivery",
    usable: "Delivery confirmation needed",
    unusable: "Delivery confirmation needed",
  }[dependency.state];
}

export function factorySystemManagerActive(snapshot: FactorySnapshot | null) {
  return (
    snapshot?.managers.some((entry) => entry.role === "system" && entry.status === "active") ??
    false
  );
}

/** Escalations reach the system manager when one is active; otherwise they wait for the human. */
export function factoryEscalationAwaitsHuman(
  snapshot: FactorySnapshot | null,
  assignmentId: string,
) {
  return (
    !factorySystemManagerActive(snapshot) &&
    (snapshot?.findings.some(
      (finding) =>
        finding.assignmentId === assignmentId &&
        finding.escalation !== null &&
        !finding.escalation.acknowledgedAt,
    ) ??
      false)
  );
}

export function factoryOversightSummary(assignment: FactoryAssignment) {
  const incident = assignment.oversight?.recovery.incident;
  if (incident?.phase === "escalated") return "Recovery needs your decision";
  if (incident) return `Recovery: ${incident.phase}`;
  if (assignment.wait) return assignment.wait.reason;
  return assignment.oversight?.progress?.summary ?? "Progress and dependencies";
}

/**
 * Finds the assignment a thread links to directly. Without one, `lineage` means the thread's
 * ancestry could still reach overseen work in its project. Only then does a caller need the
 * project's thread roster, so threads outside the factory never subscribe to it.
 */
export function factoryThreadOversightTarget(
  snapshot: FactorySnapshot,
  threadId: ThreadId,
  projectId: ProjectId,
):
  | { readonly kind: "direct"; readonly assignment: FactoryAssignment }
  | { readonly kind: "lineage" }
  | null {
  const auxiliary = snapshot.auxiliaryThreads.find((entry) => entry.threadId === threadId);
  const assignment = snapshot.assignments.find(
    (entry) =>
      entry.id === auxiliary?.assignmentId || entry.previousLeadThreadIds?.includes(threadId),
  );
  if (assignment) return { kind: "direct", assignment };
  return snapshot.assignments.some(
    (entry) => entry.projectId === projectId && entry.kind !== "onboarding",
  )
    ? { kind: "lineage" }
    : null;
}
