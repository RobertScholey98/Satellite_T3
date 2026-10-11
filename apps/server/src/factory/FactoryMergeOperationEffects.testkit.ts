import {
  CommandId,
  PullRequestOperationError,
  type FactoryDecisionCommand,
  type FactoryError,
  type FactoryMergeOperation,
  type PullRequestDetail,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Config from "../config.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import { GitHubApiRateLimitError } from "../sourceControl/GitHubApi.ts";
import * as Store from "./FactoryStore.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Gate from "./FactoryPullRequestGate.ts";
import * as Handover from "./FactoryHandover.ts";
import * as Integration from "./FactoryIntegrationExecution.ts";
import * as MergeEffects from "./FactoryMergeEffects.ts";
import * as OperationEffects from "./FactoryMergeOperationEffects.ts";
import { mergeFixture, deliveryNow } from "./FactoryMerge.testkit.ts";
import { mergeHostEvidence, seedMergeEffects } from "./FactoryMergeEffects.testkit.ts";
import { canonicalFactoryPullRequest } from "./FactoryMergeOwnership.ts";
import { makeFakeGitHub } from "./FactoryMergeSignal.testkit.ts";

export type MergeHostBehavior = "merge" | "lost-ack" | "unknown" | "transient";
export const makeMergeOperationHarness = Effect.fn(function* (
  options: {
    readonly behavior?: (ref: PullRequestRef, attempt: number) => MergeHostBehavior;
    readonly beforeWrite?: (ref: PullRequestRef) => Effect.Effect<void, FactoryError>;
    readonly changedCapture?: boolean;
    readonly failFirstMergedRead?: boolean;
  } = {},
) {
  const fixture = mergeFixture();
  yield* seedMergeEffects(fixture.state);
  const store = yield* Store.FactoryStore;
  const gate = yield* Gate.FactoryPullRequestGate;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const merged = new Set<string>();
  const github = makeFakeGitHub();
  const writes: string[] = [];
  const stages: string[] = [];
  const attempts = new Map<string, number>();
  let failedMergedRead = false;
  const detail = (ref: PullRequestRef): PullRequestDetail => {
    const evidence = mergeHostEvidence(fixture.state, ref);
    const done = merged.has(canonicalFactoryPullRequest(ref));
    return {
      provider: "github",
      capabilities: {
        diff: true,
        actions: ["merge"],
        comment: true,
        mergeMethods: ["merge"],
        conditionalMerge: true,
        search: true,
        review: { inlineComment: true, reply: true, resolve: true, verdicts: ["approve"] },
        reviewers: { request: true, listCandidates: true },
      },
      viewerPermissions: {
        actions: ["merge"],
        comment: true,
        resolve: true,
        verdicts: ["approve"],
        requestReviewers: true,
      },
      projectId: ref.projectId,
      projectTitle: ref.projectId,
      workspaceRoot: `/fixture/${ref.projectId}`,
      repository: ref.repository,
      number: ref.number,
      title: "Reviewed feature",
      body: "Body",
      url: `https://github.com/${ref.repository}/pull/${ref.number}`,
      author: null,
      state: done ? "merged" : "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      headBranch: "factory/member",
      headSha: evidence.headSha,
      baseBranch: "main",
      createdAt: deliveryNow,
      updatedAt: deliveryNow,
      mergedAt: done ? deliveryNow : null,
      closedAt: done ? deliveryNow : null,
      ...(done ? { mergeCommitSha: `merge-${ref.number}` } : {}),
      reviewers: [],
      labels: [],
      checks: [],
      mergeCapabilities: { merge: true, squash: true, rebase: true },
    };
  };
  const adapters = Layer.mergeAll(
    Config.layerTest(root, root),
    github.layer,
    Layer.mock(PullRequests.PullRequestService)({
      invalidate: () => Effect.void,
      detail: (ref) =>
        Effect.gen(function* () {
          if (
            options.failFirstMergedRead &&
            !failedMergedRead &&
            merged.has(canonicalFactoryPullRequest(ref))
          ) {
            failedMergedRead = true;
            return yield* new PullRequestOperationError({
              operation: "detail",
              detail: "The host observation failed after an actual merge",
            });
          }
          return detail(ref);
        }),
      inspectForMerge: (ref) =>
        Effect.sync(() => {
          const evidence = mergeHostEvidence(fixture.state, ref);
          return merged.has(canonicalFactoryPullRequest(ref))
            ? { ...evidence, state: "merged" as const }
            : evidence;
        }),
      runAction: (input) =>
        Effect.gen(function* () {
          const key = canonicalFactoryPullRequest(input);
          if (options.beforeWrite)
            yield* options.beforeWrite(input).pipe(
              Effect.mapError(
                (cause) =>
                  new PullRequestOperationError({
                    operation: "merge",
                    detail: "The host staging failed",
                    cause,
                  }),
              ),
            );
          yield* gate
            .authorizeMutation({
              action: input.action,
              ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}),
              targets: [
                {
                  ref: input,
                  headBranch: detail(input).headBranch,
                  headSha: detail(input).headSha!,
                },
              ],
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PullRequestOperationError({
                    operation: "merge",
                    detail: "Queued authority changed",
                    cause,
                  }),
              ),
            );
          writes.push(key);
          const attempt = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, attempt);
          const behavior = options.behavior?.(input, attempt) ?? "merge";
          if (behavior === "merge" || behavior === "lost-ack") {
            merged.add(key);
            github.associate(input.repository, `merge-${input.number}`, input.number);
          }
          if (behavior === "lost-ack" || behavior === "unknown")
            return yield* new PullRequestOperationError({
              operation: "merge",
              detail: "The transport acknowledgement was lost",
            });
          if (behavior === "transient")
            return yield* new PullRequestOperationError({
              operation: "merge",
              detail: "The host refused the rate-limited request",
              cause: new GitHubApiRateLimitError({ host: "github.com", operation: "merge" }),
            });
          return input.repository;
        }),
    }),
    Layer.mock(Integration.FactoryIntegrationExecution)({
      stop: () =>
        Effect.sync(() => {
          stages.push("physical-stop");
        }),
      capture: () =>
        Effect.sync(() => {
          stages.push("capture");
          const artifact = fixture.state.integrationTestArtifacts.at(-1)!;
          return options.changedCapture && stages.filter((entry) => entry === "capture").length > 1
            ? { ...artifact, digest: "changed-bytes" }
            : artifact;
        }),
      release: () =>
        Effect.sync(() => {
          stages.push("release");
        }),
    }),
    Layer.mock(Handover.FactoryHandover)({
      stopTeam: () =>
        Effect.sync(() => {
          stages.push("provider-stop");
        }),
    }),
  );
  const layer = Layer.mergeAll(MergeEffects.layer, OperationEffects.layer).pipe(
    Layer.provide(Access.layer),
    Layer.provide(adapters),
  );
  const commit = (command: FactoryDecisionCommand) =>
    store.commit({ actor: { kind: "human" }, command, now: deliveryNow });
  const start = Effect.gen(function* () {
    const reviewed = yield* commit({
      type: "merge.group.review",
      commandId: CommandId.make("operation-review"),
      groupId: fixture.groupId,
    });
    const pending = (yield* store.pending).find(
      (entry) => entry.intent.type === "merge.group.inspect",
    )!;
    yield* (yield* MergeEffects.FactoryMergeEffects).handle(pending);
    const review = (yield* store.snapshot).mergeGroupReviews.find(
      (entry) => entry.id === reviewed.mergeGroupReviewId,
    )!;
    if (review.lifecycle.phase !== "sealed")
      return yield* Effect.die(new Error("Review must be sealed before start"));
    yield* commit({
      type: "merge.group.approve",
      commandId: CommandId.make("operation-approval"),
      groupId: fixture.groupId,
      reviewId: review.id,
      expectedDigest: review.lifecycle.digest,
    });
    yield* commit({
      type: "merge.group.start",
      commandId: CommandId.make("operation-start"),
      groupId: fixture.groupId,
      reviewId: review.id,
      expectedDigest: review.lifecycle.digest,
    });
    return (yield* store.snapshot).mergeOperations[0]!;
  });
  const drain = Effect.gen(function* () {
    const effects = yield* OperationEffects.FactoryMergeOperationEffects;
    for (let turn = 0; turn < 30; turn++) {
      const pending = (yield* store.pending).find((entry) =>
        entry.intent.type.startsWith("merge.operation."),
      );
      if (!pending) return;
      yield* effects.handle(pending);
    }
    return yield* Effect.die(new Error("Merge operation did not reach a bounded durable outcome"));
  });
  const current: Effect.Effect<FactoryMergeOperation, FactoryError> = store.snapshot.pipe(
    Effect.map((state) => state.mergeOperations[0]!),
  );
  return { fixture, store, layer, start, drain, current, writes, stages, merged, commit, github };
});
