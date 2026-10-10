import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import type { ProviderMergeEvidence } from "./pullRequestMergeEvidence.ts";

export class GitHubMergeEvidenceError extends Schema.TaggedError<GitHubMergeEvidenceError>()(
  "GitHubMergeEvidenceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const Revision = Schema.String.check(Schema.isNonEmpty());
const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});
const Check = Schema.Struct({
  __typename: Schema.Literals(["CheckRun", "StatusContext"]),
  id: Revision,
  isRequired: Schema.optional(Schema.NullOr(Schema.Boolean)),
  name: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.Struct({ oid: Revision })),
  checkSuite: Schema.optional(Schema.Struct({ commit: Schema.Struct({ oid: Revision }) })),
});
const Review = Schema.Struct({
  id: Revision,
  author: Schema.NullOr(Schema.Struct({ login: Revision })),
  state: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
  commit: Schema.NullOr(Schema.Struct({ oid: Revision })),
  submittedAt: Schema.NullOr(Schema.String),
});
const Response = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.Struct({
        pullRequest: Schema.Struct({
          headRefOid: Revision,
          baseRefOid: Revision,
          baseRefName: Revision,
          state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
          isDraft: Schema.Boolean,
          mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
          mergeStateStatus: Schema.String,
          reviewDecision: Schema.NullOr(
            Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]),
          ),
          autoMergeRequest: Schema.NullOr(
            Schema.Struct({ enabledAt: Schema.NullOr(Schema.String) }),
          ),
          isMergeQueueEnabled: Schema.Boolean,
          commits: Schema.optional(
            Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({
                  commit: Schema.Struct({
                    oid: Revision,
                    statusCheckRollup: Schema.NullOr(
                      Schema.Struct({
                        contexts: Schema.Struct({
                          totalCount: Schema.Int,
                          pageInfo: PageInfo,
                          nodes: Schema.Array(Check),
                        }),
                      }),
                    ),
                  }),
                }),
              ),
            }),
          ),
          reviews: Schema.optional(
            Schema.Struct({
              totalCount: Schema.Int,
              pageInfo: PageInfo,
              nodes: Schema.Array(Review),
            }),
          ),
        }),
      }),
    }),
  }),
);

/** Each page includes both revisions; the final read repeats the host's readiness decision. */
const QUERY = `query PullRequestMergeEvidence($owner: String!, $name: String!, $number: Int!, $checks: Boolean!, $reviews: Boolean!, $checkCursor: String, $reviewCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid baseRefOid baseRefName state isDraft mergeable mergeStateStatus reviewDecision
      autoMergeRequest { enabledAt }
      isMergeQueueEnabled
      commits(last: 1) @include(if: $checks) { nodes { commit {
        oid
        statusCheckRollup { contexts(first: 100, after: $checkCursor) {
          totalCount pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on CheckRun { id name status conclusion isRequired(pullRequestNumber: $number) checkSuite { commit { oid } } }
            ... on StatusContext { id context state isRequired(pullRequestNumber: $number) commit { oid } }
          }
        } }
      } } }
      reviews(first: 100, after: $reviewCursor) @include(if: $reviews) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { id state author { login } commit { oid } submittedAt }
      }
    }
  }
}`;

const reviewStates = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
} as const;
const reviewDecisions = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  REVIEW_REQUIRED: "review-required",
} as const;
const states = { OPEN: "open", CLOSED: "closed", MERGED: "merged" } as const;
const mergeabilities = {
  MERGEABLE: "mergeable",
  CONFLICTING: "conflicting",
  UNKNOWN: "unknown",
} as const;
const PAGE_LIMIT = 10;

function checkStatus(check: typeof Check.Type): ProviderMergeEvidence["checks"][number]["status"] {
  if (check.__typename === "StatusContext") {
    switch (check.state) {
      case "SUCCESS":
        return "success";
      case "PENDING":
      case "EXPECTED":
        return "pending";
      case "ERROR":
      case "FAILURE":
        return "failure";
      default:
        return "unknown";
    }
  }
  if (["QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "PENDING"].includes(check.status ?? ""))
    return "pending";
  if (check.status !== "COMPLETED") return "unknown";
  switch (check.conclusion) {
    case "SUCCESS":
    case "NEUTRAL":
    case "SKIPPED":
      return "success";
    case "FAILURE":
    case "CANCELLED":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STALE":
    case "STARTUP_FAILURE":
      return "failure";
    default:
      return "unknown";
  }
}

export const inspectGitHubMergeEvidence = Effect.fn("GitHubPullRequestCli.inspectForMerge")(
  function* (input: {
    readonly host: string;
    readonly owner: string;
    readonly name: string;
    readonly number: number;
  }) {
    const api = yield* GitHubApi.GitHubApi;
    const read = (
      checks: boolean,
      reviews: boolean,
      checkCursor: string | null,
      reviewCursor: string | null,
    ) =>
      api
        .graphql({
          host: input.host,
          operation: "inspectForMerge",
          query: QUERY,
          variables: {
            owner: input.owner,
            name: input.name,
            number: input.number,
            checks,
            reviews,
            checkCursor,
            reviewCursor,
          },
        })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Response)),
          Effect.map((response) => response.data.repository.pullRequest),
          Effect.mapError((error) =>
            error instanceof Schema.SchemaError
              ? new GitHubMergeEvidenceError({
                  detail: "GitHub returned incomplete or unknown merge evidence.",
                })
              : error,
          ),
        );
    const first = yield* read(true, true, null, null);
    const issues = new Set<string>();
    const checks: Array<ProviderMergeEvidence["checks"][number]> = [];
    const reviews: Array<ProviderMergeEvidence["reviews"][number]> = [];
    const seenChecks = new Set<string>();
    const seenReviews = new Set<string>();
    let checkCursor: string | null = null;
    let reviewCursor: string | null = null;
    let withChecks = true;
    let withReviews = true;
    let totalChecks: number | undefined;
    let totalReviews: number | undefined;
    const sameRevision = (page: typeof first) =>
      page.headRefOid === first.headRefOid &&
      page.baseRefOid === first.baseRefOid &&
      page.baseRefName === first.baseRefName;
    for (let index = 0; index < PAGE_LIMIT; index++) {
      const page: typeof first =
        index === 0 ? first : yield* read(withChecks, withReviews, checkCursor, reviewCursor);
      if (!sameRevision(page)) {
        issues.add("Pull request revisions changed while reading evidence.");
        break;
      }
      if (withChecks) {
        const commit = page.commits?.nodes[0]?.commit;
        if (page.commits?.nodes.length !== 1 || commit?.oid !== first.headRefOid) {
          issues.add("Check evidence did not identify the current head commit.");
          break;
        }
        const contexts = commit.statusCheckRollup?.contexts;
        const count = contexts?.totalCount ?? 0;
        if (totalChecks !== undefined && totalChecks !== count)
          issues.add("Check membership changed during inspection.");
        totalChecks = count;
        for (const check of contexts?.nodes ?? []) {
          const headSha =
            check.__typename === "CheckRun" ? check.checkSuite?.commit.oid : check.commit?.oid;
          const name = check.__typename === "CheckRun" ? check.name : check.context;
          const status = checkStatus(check);
          if (seenChecks.has(check.id)) issues.add("Repeated check evidence across pages.");
          seenChecks.add(check.id);
          if (
            headSha !== first.headRefOid ||
            name === undefined ||
            status === "unknown" ||
            typeof check.isRequired !== "boolean"
          )
            issues.add("Check metadata is unknown or belongs to another head.");
          checks.push({
            id: check.id,
            name: name ?? "",
            headSha: headSha ?? "",
            required: check.isRequired ?? null,
            status,
          });
        }
        withChecks = contexts?.pageInfo.hasNextPage ?? false;
        const next = contexts?.pageInfo.endCursor ?? null;
        if (withChecks && (next === null || next === checkCursor)) {
          issues.add("Check pagination is incomplete.");
          break;
        }
        checkCursor = next;
      }
      if (withReviews) {
        if (page.reviews === undefined) {
          issues.add("Review evidence is missing.");
          break;
        }
        if (totalReviews !== undefined && totalReviews !== page.reviews.totalCount)
          issues.add("Review membership changed during inspection.");
        totalReviews = page.reviews.totalCount;
        for (const review of page.reviews.nodes) {
          if (seenReviews.has(review.id)) issues.add("Repeated review evidence across pages.");
          seenReviews.add(review.id);
          if (
            review.state !== "PENDING" &&
            (review.author === null || review.commit === null || review.submittedAt === null)
          )
            issues.add("Review metadata is incomplete.");
          reviews.push({
            id: review.id,
            author: review.author?.login ?? null,
            state: reviewStates[review.state],
            headSha: review.commit?.oid ?? null,
            submittedAt: review.submittedAt,
          });
        }
        withReviews = page.reviews.pageInfo.hasNextPage;
        const next = page.reviews.pageInfo.endCursor;
        if (withReviews && (next === null || next === reviewCursor)) {
          issues.add("Review pagination is incomplete.");
          break;
        }
        reviewCursor = next;
      }
      if (!withChecks && !withReviews) break;
    }
    if (
      withChecks ||
      withReviews ||
      seenChecks.size !== totalChecks ||
      seenReviews.size !== totalReviews
    )
      issues.add("Merge evidence is truncated.");
    const last = yield* read(false, false, null, null);
    if (!sameRevision(last))
      issues.add("Pull request revisions changed before inspection finished.");
    if (
      last.state !== first.state ||
      last.isDraft !== first.isDraft ||
      last.reviewDecision !== first.reviewDecision ||
      last.mergeStateStatus !== first.mergeStateStatus ||
      last.mergeable !== first.mergeable ||
      (last.autoMergeRequest !== null) !== (first.autoMergeRequest !== null) ||
      last.isMergeQueueEnabled !== first.isMergeQueueEnabled
    )
      issues.add("Host merge readiness changed during inspection.");
    if (
      last.mergeable === "UNKNOWN" ||
      !["BEHIND", "BLOCKED", "CLEAN", "DIRTY", "DRAFT", "HAS_HOOKS", "UNSTABLE"].includes(
        last.mergeStateStatus,
      )
    )
      issues.add("Host merge readiness is unknown.");
    return {
      headSha: first.headRefOid,
      baseSha: first.baseRefOid,
      baseBranch: first.baseRefName,
      state: states[first.state],
      isDraft: first.isDraft,
      mergeability: mergeabilities[first.mergeable],
      mergeState: first.mergeStateStatus,
      reviewDecision: first.reviewDecision === null ? null : reviewDecisions[first.reviewDecision],
      autoMergeEnabled: first.autoMergeRequest !== null,
      mergeQueueEnabled: first.isMergeQueueEnabled,
      checks,
      reviews,
      complete: issues.size === 0,
      issues: [...issues],
    } satisfies ProviderMergeEvidence;
  },
);
