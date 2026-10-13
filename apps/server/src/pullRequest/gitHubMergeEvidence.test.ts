import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import { inspectGitHubMergeEvidence } from "./gitHubMergeEvidence.ts";

const input = { host: "github.com", owner: "acme", name: "web", number: 7 };
const check = (id = "check-1") => ({
  __typename: "CheckRun",
  id,
  name: id,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  isRequired: true,
  checkSuite: { commit: { oid: "head-1" } },
});
const review = (id = "review-1") => ({
  id,
  author: { login: "reviewer" },
  state: "APPROVED",
  commit: { oid: "head-1" },
  submittedAt: "2026-10-10T12:00:00Z",
});
const connection = (
  nodes: ReadonlyArray<unknown>,
  next: string | null = null,
  totalCount = nodes.length,
) => ({ nodes, totalCount, pageInfo: { hasNextPage: next !== null, endCursor: next } });
const page = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  headRefOid: "head-1",
  baseRefOid: "base-1",
  baseRefName: "main",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  autoMergeRequest: null,
  isMergeQueueEnabled: false,
  commits: {
    nodes: [{ commit: { oid: "head-1", statusCheckRollup: { contexts: connection([check()]) } } }],
  },
  reviews: connection([review()]),
  ...overrides,
});
const checksPage = (contexts: ReturnType<typeof connection>) => ({
  nodes: [{ commit: { oid: "head-1", statusCheckRollup: { contexts } } }],
});
const layer = (read: (input: GitHubApi.GitHubGraphQlInput) => Readonly<Record<string, unknown>>) =>
  Layer.mock(GitHubApi.GitHubApi)({
    graphql: (request) =>
      Effect.sync(() => JSON.stringify({ data: { repository: { pullRequest: read(request) } } })),
  });

it.effect("reads fresh head-bound checks and reviews instead of reusing a successful rollup", () =>
  Effect.gen(function* () {
    let reads = 0;
    const testLayer = layer(() => {
      reads++;
      return page({
        commits: checksPage(
          connection([{ ...check(), conclusion: reads > 2 ? "FAILURE" : "SUCCESS" }]),
        ),
      });
    });
    const results = yield* Effect.gen(function* () {
      return [yield* inspectGitHubMergeEvidence(input), yield* inspectGitHubMergeEvidence(input)];
    }).pipe(Effect.provide(testLayer));
    expect(reads).toBe(4);
    expect(results[0]).toMatchObject({
      complete: true,
      headSha: "head-1",
      baseSha: "base-1",
      checks: [{ headSha: "head-1", required: true, status: "success" }],
      reviews: [{ headSha: "head-1", state: "approved" }],
    });
    expect(results[1]?.checks[0]?.status).toBe("failure");
  }),
);

it.effect("walks independent check and review pages completely and rechecks both revisions", () =>
  Effect.gen(function* () {
    const requests: GitHubApi.GitHubGraphQlInput[] = [];
    const result = yield* inspectGitHubMergeEvidence(input).pipe(
      Effect.provide(
        layer((request) => {
          requests.push(request);
          if (requests.length === 1)
            return page({
              commits: checksPage(connection([check()], "checks-next", 2)),
              reviews: connection([review()], "reviews-next", 2),
            });
          return page({
            commits: checksPage(
              connection(
                [
                  {
                    __typename: "StatusContext",
                    id: "status-2",
                    context: "build",
                    state: "SUCCESS",
                    isRequired: false,
                    commit: { oid: "head-1" },
                  },
                ],
                null,
                2,
              ),
            ),
            reviews: connection([review("review-2")], null, 2),
          });
        }),
      ),
    );
    expect(result.complete).toBe(true);
    expect(result.checks).toHaveLength(2);
    expect(result.reviews).toHaveLength(2);
    expect(requests[1]?.variables).toMatchObject({
      checkCursor: "checks-next",
      reviewCursor: "reviews-next",
    });
    expect(requests[2]?.variables).toMatchObject({ checks: false, reviews: false });
  }),
);

it.effect.each([
  { commits: checksPage(connection([{ ...check(), isRequired: null }])) },
  { commits: checksPage(connection([{ ...check(), conclusion: "NEW_UNKNOWN_VALUE" }])) },
  {
    commits: checksPage(
      connection([{ ...check(), checkSuite: { commit: { oid: "other-head" } } }]),
    ),
  },
  { reviews: connection([{ ...review(), author: null }]) },
  { reviews: connection([{ ...review(), commit: null }]) },
  { reviews: connection([review()], null, 2) },
  { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
  { reviews: { ...connection([review()]), pageInfo: { hasNextPage: true, endCursor: null } } },
])("marks unknown or incomplete evidence unusable %#", (overrides) =>
  Effect.gen(function* () {
    const result = yield* inspectGitHubMergeEvidence(input).pipe(
      Effect.provide(layer(() => page(overrides))),
    );
    expect(result.complete).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  }),
);

it.effect.each([
  { headRefOid: "head-2" },
  { baseRefOid: "base-2" },
  { baseRefName: "release" },
  { reviewDecision: "CHANGES_REQUESTED" },
])("refuses revisions or readiness that change during inspection %#", (changed) =>
  Effect.gen(function* () {
    let reads = 0;
    const result = yield* inspectGitHubMergeEvidence(input).pipe(
      Effect.provide(layer(() => page(++reads === 1 ? {} : changed))),
    );
    expect(result.complete).toBe(false);
  }),
);

it.effect("refuses a changed head between evidence pages", () =>
  Effect.gen(function* () {
    let reads = 0;
    const result = yield* inspectGitHubMergeEvidence(input).pipe(
      Effect.provide(
        layer(() =>
          ++reads === 1
            ? page({ reviews: connection([review()], "next", 2) })
            : page({ headRefOid: "head-2" }),
        ),
      ),
    );
    expect(result.complete).toBe(false);
    expect(result.reviews).toHaveLength(1);
  }),
);

it.effect("reports truncation when the bounded page walk has more reviews", () =>
  Effect.gen(function* () {
    let reads = 0;
    const result = yield* inspectGitHubMergeEvidence(input).pipe(
      Effect.provide(
        layer(() =>
          page({ reviews: connection([review(`review-${++reads}`)], `next-${reads}`, 1001) }),
        ),
      ),
    );
    expect(result.complete).toBe(false);
    expect(result.reviews).toHaveLength(10);
    expect(reads).toBe(11);
  }),
);

it.effect("does not turn missing host review requirements into permission to merge", () =>
  Effect.gen(function* () {
    const result = yield* inspectGitHubMergeEvidence(input).pipe(
      Effect.provide(layer(() => page({ reviewDecision: undefined }))),
      Effect.flip,
    );
    expect(result._tag).toBe("GitHubMergeEvidenceError");
  }),
);

it.effect("reports standing auto-merge even when GitHub omits its enable time", () =>
  Effect.gen(function* () {
    const result = yield* inspectGitHubMergeEvidence(input).pipe(
      Effect.provide(layer(() => page({ autoMergeRequest: { enabledAt: null } }))),
    );
    expect(result.complete).toBe(true);
    expect(result.autoMergeEnabled).toBe(true);
  }),
);
