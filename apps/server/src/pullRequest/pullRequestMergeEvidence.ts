import type {
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestState,
} from "@t3tools/contracts";

/** Fresh host evidence, separate from cached UI rollups. Completeness alone is not readiness. */
export interface ProviderMergeEvidence {
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly mergeState: string;
  readonly reviewDecision: PullRequestReviewDecision | null;
  readonly autoMergeEnabled: boolean;
  readonly mergeQueueEnabled: boolean;
  readonly checks: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly headSha: string;
    readonly required: boolean | null;
    readonly status: "success" | "pending" | "failure" | "unknown";
  }>;
  readonly reviews: ReadonlyArray<{
    readonly id: string;
    readonly author: string | null;
    readonly state: "approved" | "changes-requested" | "commented" | "dismissed" | "pending";
    readonly headSha: string | null;
    readonly submittedAt: string | null;
  }>;
  readonly complete: boolean;
  readonly issues: ReadonlyArray<string>;
}
