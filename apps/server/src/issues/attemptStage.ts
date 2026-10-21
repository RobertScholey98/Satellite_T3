import type {
  IssueAttemptStatus,
  IssueBoardMapping,
  OrchestrationV2Run,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

/** The stages an attempt moves through while it runs. Failed and ended are recorded, not derived. */
export type AttemptStage = Extract<
  IssueAttemptStatus,
  "launching" | "working" | "in-pr" | "merged"
>;

export type FirstRunProgress = "none" | "pending" | "running" | "failed-before-running";

export interface ControllingPullRequest {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
}

export interface AttemptFacts {
  readonly worktreeReady: boolean;
  readonly firstRun: FirstRunProgress;
  readonly controllingPullRequest: ControllingPullRequest | null;
}

const NEVER_STARTED = new Set<OrchestrationV2Run["status"]>([
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

/** How far the thread's first run got. "Running" is the signal that the agent has the prompt. */
export const firstRunProgress = (
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status" | "startedAt">>,
): FirstRunProgress => {
  const first = runs.reduce<(typeof runs)[number] | undefined>(
    (earliest, run) => (earliest === undefined || run.ordinal < earliest.ordinal ? run : earliest),
    undefined,
  );
  if (first === undefined) return "none";
  if (first.startedAt !== null) return "running";
  if (first.status === "running" || first.status === "waiting" || first.status === "completed")
    return "running";
  return NEVER_STARTED.has(first.status) ? "failed-before-running" : "pending";
};

/**
 * The newest pull request linked to the thread that is neither a stack layer nor dismissed. Earlier
 * pull requests never move the ticket. A link not yet synced counts as open.
 */
export const controllingPullRequestOf = (
  links: ReadonlyArray<ThreadPullRequestLink>,
): ControllingPullRequest | null => {
  const candidates = links.filter(
    (link) => link.source !== "stack" && link.source !== "stack-dismissed" && link.stack === null,
  );
  const newest = candidates.reduce<ThreadPullRequestLink | undefined>(
    (latest, link) => (latest === undefined || link.linkedAt >= latest.linkedAt ? link : latest),
    undefined,
  );
  if (newest === undefined) return null;
  return {
    host: newest.host,
    repository: newest.repository,
    number: newest.number,
    url: newest.url,
    state: newest.snapshot?.state ?? "open",
  };
};

/** The stage a running attempt is in, or `failed` when its launch never reached the agent. */
export const deriveStage = (facts: AttemptFacts): AttemptStage | "failed" => {
  if (facts.firstRun === "failed-before-running") return "failed";
  if (!facts.worktreeReady || facts.firstRun !== "running") return "launching";
  switch (facts.controllingPullRequest?.state) {
    case "open":
      return "in-pr";
    case "merged":
      return "merged";
    default:
      return "working";
  }
};

/** The column an attempt in `stage` puts its ticket in, if any. */
export const stageColumn = (stage: AttemptStage, mapping: IssueBoardMapping): string | null => {
  switch (stage) {
    case "launching":
      return null;
    case "working":
      return mapping.inProgress;
    case "in-pr":
      return mapping.inPullRequest;
    case "merged":
      return mapping.moveOnMerge ? mapping.completed : null;
  }
};

export const pullRequestKey = (pr: {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}) => `${pr.host.toLowerCase()}/${pr.repository.toLowerCase()}#${pr.number}`;
