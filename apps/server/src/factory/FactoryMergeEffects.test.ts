import { assert, it } from "@effect/vitest";
import { CommandId, FactoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Store from "./FactoryStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as Integration from "./FactoryIntegrationExecution.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as MergeEffects from "./FactoryMergeEffects.ts";
import {
  mergeFixture,
  reviewedMergeFixture,
  integrated,
  api,
  deliveryIds,
  deliveryNow,
} from "./FactoryMerge.testkit.ts";
import {
  mergeEffectsBase,
  seedMergeEffects,
  mergeHostEvidence,
} from "./FactoryMergeEffects.testkit.ts";

it.effect(
  "seals freshly inspected member evidence and reconciles a lost local acknowledgement without duplicate reads",
  () =>
    Effect.gen(function* () {
      const fixture = mergeFixture();
      yield* seedMergeEffects(fixture.state);
      const store = yield* Store.FactoryStore;
      let hostReads = 0;
      let captures = 0;
      let lostAck = true;
      let checksFail = false;
      const layers = Layer.mergeAll(
        Layer.succeed(Store.FactoryStore, {
          ...store,
          finishEffect: (input) =>
            store.finishEffect(input).pipe(
              Effect.flatMap((receipt) => {
                if (input.command?.type === "merge.group.inspected" && lostAck) {
                  lostAck = false;
                  return Effect.fail(
                    new FactoryError({
                      code: "persistence",
                      detail: "Lost sealed receipt acknowledgement",
                    }),
                  );
                }
                return Effect.succeed(receipt);
              }),
            ),
        }),
        Layer.mock(PullRequests.PullRequestService)({
          inspectForMerge: (ref) =>
            Effect.gen(function* () {
              hostReads++;
              const observed = mergeHostEvidence(yield* store.snapshot.pipe(Effect.orDie), ref);
              return checksFail
                ? {
                    ...observed,
                    checks: observed.checks.map((entry) => ({
                      ...entry,
                      status: "failure" as const,
                    })),
                  }
                : observed;
            }),
        }),
        Layer.mock(Integration.FactoryIntegrationExecution)({
          capture: () =>
            Effect.sync(() => {
              captures++;
              return fixture.state.integrationTestArtifacts.at(-1)!;
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const effects = yield* MergeEffects.FactoryMergeEffects;
        const requested = yield* store.commit({
          actor: { kind: "thread", threadId: integrated.lead },
          command: {
            type: "merge.group.review",
            commandId: CommandId.make("combined-review"),
            groupId: fixture.groupId,
          },
          now: deliveryNow,
        });
        const pending = (yield* store.pending).find(
          (entry) => entry.intent.type === "merge.group.inspect",
        )!;
        yield* effects.handle(pending);
        const sealed = (yield* store.snapshot).mergeGroupReviews.find(
          (entry) => entry.id === requested.mergeGroupReviewId,
        )!;
        assert.equal(sealed.lifecycle.phase, "sealed");
        assert.equal(hostReads, 2);
        assert.equal(captures, 1);
        yield* effects.handle(pending);
        assert.equal(hostReads, 2);
        checksFail = true;
        const retry = yield* store.commit({
          actor: { kind: "thread", threadId: integrated.lead },
          command: {
            type: "merge.group.review",
            commandId: CommandId.make("changed-host-review"),
            groupId: fixture.groupId,
          },
          now: deliveryNow,
        });
        yield* effects.handle(
          (yield* store.pending).find((entry) => entry.intent.type === "merge.group.inspect")!,
        );
        const failed = (yield* store.snapshot).mergeGroupReviews.find(
          (entry) => entry.id === retry.mergeGroupReviewId,
        )!;
        assert.equal(failed.lifecycle.phase, "failed");
        if (failed.lifecycle.phase === "failed") assert.include(failed.lifecycle.reason, "checks");
        assert.equal(hostReads, 4);
        assert.equal(captures, 1);
      }).pipe(
        Effect.provide(MergeEffects.layer.pipe(Layer.provide(Access.layer), Layer.provide(layers))),
      );
    }).pipe(Effect.provide(mergeEffectsBase), Effect.scoped),
);

it.effect.each(["changed-test-bytes", "pause-during-capture"] as const)(
  "refuses a combined seal after %s",
  (scenario) =>
    Effect.gen(function* () {
      const fixture = mergeFixture();
      yield* seedMergeEffects(fixture.state);
      const store = yield* Store.FactoryStore;
      let captures = 0;
      const adapters = Layer.mergeAll(
        Layer.mock(PullRequests.PullRequestService)({
          inspectForMerge: (ref) =>
            store.snapshot.pipe(
              Effect.map((state) => mergeHostEvidence(state, ref)),
              Effect.orDie,
            ),
        }),
        Layer.mock(Integration.FactoryIntegrationExecution)({
          capture: () =>
            Effect.gen(function* () {
              captures++;
              if (scenario === "pause-during-capture")
                yield* store.commit({
                  actor: { kind: "human" },
                  command: {
                    type: "project.pause",
                    commandId: CommandId.make("pause-while-sealing"),
                    projectId: api.project,
                  },
                  now: deliveryNow,
                });
              const artifact = fixture.state.integrationTestArtifacts.at(-1)!;
              return scenario === "changed-test-bytes"
                ? { ...artifact, digest: "unrecorded-test-change" }
                : artifact;
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const effects = yield* MergeEffects.FactoryMergeEffects;
        const requested = yield* store.commit({
          actor: { kind: "thread", threadId: integrated.lead },
          command: {
            type: "merge.group.review",
            commandId: CommandId.make("race-review"),
            groupId: fixture.groupId,
          },
          now: deliveryNow,
        });
        yield* effects.handle(
          (yield* store.pending).find((entry) => entry.intent.type === "merge.group.inspect")!,
        );
        const result = (yield* store.snapshot).mergeGroupReviews.find(
          (entry) => entry.id === requested.mergeGroupReviewId,
        )!;
        assert.equal(result.lifecycle.phase, "failed");
        assert.isAtMost(captures, 3);
        assert.isFalse(
          (yield* store.pending).some((entry) => entry.intent.type === "merge.group.inspect"),
        );
      }).pipe(
        Effect.provide(
          MergeEffects.layer.pipe(Layer.provide(Access.layer), Layer.provide(adapters)),
        ),
      );
    }).pipe(Effect.provide(mergeEffectsBase), Effect.scoped),
);

it.effect("notifies unpaused leads independently and reconciles a lost send acknowledgement", () =>
  Effect.gen(function* () {
    const fixture = reviewedMergeFixture();
    yield* seedMergeEffects(fixture.state);
    const store = yield* Store.FactoryStore;
    const threads = yield* Threads.ThreadManagementService;
    yield* store.commit({
      actor: { kind: "human" },
      command: {
        type: "merge.group.reject",
        commandId: CommandId.make("request-corrections"),
        groupId: fixture.groupId,
        reviewId: fixture.reviewId,
        expectedDigest: fixture.reviewDigest,
        reason: "The combined feature needs a clearer failure state.",
      },
      now: deliveryNow,
    });
    const pending = (yield* store.pending).find(
      (entry) => entry.intent.type === "merge.group.notify",
    )!;
    yield* store.commit({
      actor: { kind: "human" },
      command: {
        type: "project.pause",
        commandId: CommandId.make("hold-requester"),
        projectId: deliveryIds.project,
      },
      now: deliveryNow,
    });
    let sends = 0;
    yield* Effect.gen(function* () {
      const effects = yield* MergeEffects.FactoryMergeEffects;
      yield* effects.handle(pending);
      yield* effects.handle(pending);
      assert.equal(sends, 1);
      assert.equal((yield* threads.getThreadRecords(api.lead, ["messages"])).messages.length, 1);
      assert.equal(
        (yield* threads.getThreadRecords(deliveryIds.lead, ["messages"])).messages.length,
        0,
      );
      assert.isTrue((yield* store.pending).some((entry) => entry.id === pending.id));
    }).pipe(
      Effect.provide(
        MergeEffects.layer.pipe(
          Layer.provide(Access.layer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(PullRequests.PullRequestService)({}),
              Layer.mock(Integration.FactoryIntegrationExecution)({}),
              Layer.succeed(Threads.ThreadManagementService, {
                ...threads,
                sendToThread: (input) =>
                  threads.sendToThread(input).pipe(
                    Effect.flatMap(() => {
                      sends++;
                      return Effect.fail(
                        new Threads.ThreadManagementDurableRunProjectionError({
                          threadId: input.threadId!,
                          messageId: input.messageId!,
                        }),
                      );
                    }),
                  ),
              }),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(mergeEffectsBase), Effect.scoped),
);
