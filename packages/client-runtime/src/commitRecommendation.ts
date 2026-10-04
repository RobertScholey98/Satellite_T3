import type { CommitRecommendation, VcsStatusResult } from "@t3tools/contracts";

/** A recommendation applies only to the dirty checkout the agent assessed. */
export function activeCommitRecommendation(
  recommendation: CommitRecommendation | null | undefined,
  status: VcsStatusResult | null | undefined,
  cwd: string | null,
): CommitRecommendation | null {
  if (
    !recommendation ||
    !status?.isRepo ||
    !status.hasWorkingTreeChanges ||
    status.headCommit === undefined ||
    recommendation.cwd !== cwd ||
    recommendation.branch !== status.refName ||
    recommendation.headCommit !== status.headCommit
  ) {
    return null;
  }
  return recommendation;
}

export function commitRecommendationLabel(recommendation: CommitRecommendation): string {
  return recommendation.level === "overdue" ? "Commit overdue" : "Commit recommended";
}
