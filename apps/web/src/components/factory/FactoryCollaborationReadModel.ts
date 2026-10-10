import type {
  FactoryAssignmentScope,
  FactoryCollaborationPlan,
  FactorySnapshot,
} from "@t3tools/contracts";

const sameScope = (left: FactoryAssignmentScope | undefined, right: FactoryAssignmentScope) =>
  left !== undefined &&
  left.description === right.description &&
  left.completionCondition === right.completionCondition &&
  left.requiresPullRequest === right.requiresPullRequest &&
  left.noPrTarget?.kind === right.noPrTarget?.kind &&
  (left.noPrTarget?.kind !== "report-received" ||
    (right.noPrTarget?.kind === "report-received" &&
      left.noPrTarget.recipientThreadId === right.noPrTarget.recipientThreadId));

export function factoryCollaborationPlanStatus(
  state: Pick<FactorySnapshot, "assignments">,
  plan: FactoryCollaborationPlan,
): FactoryCollaborationPlan["phase"] | "stale" | "unverified" {
  if (plan.phase === "superseded") return "superseded";
  let incomplete = false;
  for (const participant of plan.participants) {
    const assignment = state.assignments.find((entry) => entry.id === participant.assignmentId);
    if (!assignment) {
      incomplete = true;
      continue;
    }
    if (
      assignment.threadId !== participant.threadId ||
      assignment.grant?.epoch !== participant.grantEpoch ||
      !sameScope(assignment.scope, participant.scope)
    )
      return "stale";
  }
  return incomplete ? "unverified" : plan.phase;
}
