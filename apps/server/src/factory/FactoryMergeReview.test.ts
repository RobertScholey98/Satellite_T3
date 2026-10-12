import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as Store from "./FactoryStore.ts";
import * as Service from "./FactoryService.ts";
import * as Merge from "./FactoryMergeEffects.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Integration from "./FactoryIntegrationExecution.ts";
import * as Execution from "./FactoryExecution.ts";
import * as Boundaries from "./FactoryBoundaryExecution.ts";
import * as Handover from "./FactoryHandover.ts";
import * as Source from "./FactorySource.ts";
import {
  mergeEffectsBase,
  seedMergeEffects,
  mergeHostEvidence,
} from "./FactoryMergeEffects.testkit.ts";
import { mergeFixture, integrated, deliveryIds, api } from "./FactoryMerge.testkit.ts";
import * as FactoryServiceTestkit from "./FactoryService.testkit.ts";

it.effect(
  "refreshes one combined review, approves exact members, and keeps their independent merge paths closed",
  () =>
    Effect.gen(function* () {
      const fixture = mergeFixture();
      yield* seedMergeEffects(fixture.state);
      const store = yield* Store.FactoryStore;
      let failedChecks = false;
      let observations = 0;
      const external = Layer.mergeAll(
        Layer.mock(PullRequests.PullRequestService)({
          inspectForMerge: (ref) =>
            Effect.gen(function* () {
              observations += 1;
              const raw = mergeHostEvidence(yield* store.snapshot.pipe(Effect.orDie), ref);
              return failedChecks && ref.projectId === api.project
                ? {
                    ...raw,
                    checks: raw.checks.map((check) => ({ ...check, status: "failure" as const })),
                  }
                : raw;
            }),
        }),
        Layer.mock(Integration.FactoryIntegrationExecution)({
          capture: (input) =>
            store.snapshot.pipe(
              Effect.map((state) =>
                state.integrationTestArtifacts.find(
                  (artifact) =>
                    artifact.integrationId === input.integrationId &&
                    artifact.preparationId === input.preparationId,
                )!,
              ),
            ),
        }),
        Layer.mock(Execution.FactoryExecution)({ assertSelectionFor: () => Effect.void }),
        Layer.mock(Boundaries.FactoryBoundaryExecution)({ stop: () => Effect.void }),
        Layer.mock(Handover.FactoryHandover)({ stopTeam: () => Effect.void }),
        Layer.mock(Source.FactorySource)({}),
      );
      const runtime = Service.layer.pipe(
        Layer.provideMerge(Merge.layer.pipe(Layer.provide(Access.layer))),
        Layer.provide(external),
        Layer.provide(FactoryServiceTestkit.layerTestDependencies),
      );
      yield* Effect.gen(function* () {
        const factory = yield* Service.FactoryService;
        const request = {
          type: "merge.group.review",
          commandId: CommandId.make("review-combined"),
          groupId: fixture.groupId,
        } as const;
        const result = yield* factory.dispatch(
          { kind: "thread", threadId: integrated.lead },
          request,
        );
        yield* factory.drain;
        const read = yield* factory.mergeGroupGet({ groupId: fixture.groupId });
        assert.equal(read.readiness.canApprove, true);
        assert.equal(read.readiness.status, "reviewing");
        assert.equal(read.readiness.members.length, 2);
        assert.equal(
          read.readiness.members.every((member) => member.hostEvidence?.checks === "passed"),
          true,
        );
        assert.isAtLeast(observations, 2);
        assert.deepEqual(
          yield* factory.dispatch({ kind: "thread", threadId: integrated.lead }, request),
          result,
        );
        const approval = {
          type: "merge.group.approve",
          commandId: CommandId.make("approve-combined"),
          groupId: fixture.groupId,
          reviewId: read.readiness.reviewId!,
          expectedDigest: read.readiness.reviewDigest!,
        } as const;
        const approved = yield* factory.dispatch({ kind: "human" }, approval);
        yield* factory.drain;
        assert.deepEqual(yield* factory.dispatch({ kind: "human" }, approval), approved);
        const ready = yield* factory.mergeGroupGet({ groupId: fixture.groupId });
        assert.equal(ready.readiness.status, "ready");
        assert.equal(ready.readiness.canRequestMerge, true);
        assert.equal(
          ready.readiness.members.every((member) => member.humanApproved),
          true,
        );
        for (const member of ready.readiness.members) {
          const denied = yield* factory
            .dispatch(
              { kind: "thread", threadId: member.leadThreadId },
              {
                type: "delivery.merge",
                commandId: CommandId.make(`individual:${member.assignmentId}`),
                assignmentId: member.assignmentId,
                revisionId: member.revisionId!,
              },
            )
            .pipe(Effect.flip);
          assert.include(denied.detail ?? "", "shared action");
        }
        assert.equal(
          (yield* factory.snapshot({ projectId: deliveryIds.project })).mergeGroups.length,
          1,
        );
        assert.equal((yield* factory.snapshot({ projectId: api.project })).mergeGroups.length, 1);
        assert.deepEqual(
          (yield* factory.snapshot({ projectId: ProjectId.make("unrelated") })).mergeGroups,
          [],
        );
        failedChecks = true;
        yield* factory.dispatch(
          { kind: "thread", threadId: integrated.lead },
          { ...request, commandId: CommandId.make("review-after-host-change") },
        );
        yield* factory.drain;
        const changed = yield* factory.mergeGroupGet({ groupId: fixture.groupId });
        assert.equal(changed.readiness.canApprove, false);
        assert.equal(changed.readiness.status, "waiting");
        assert.equal(
          changed.readiness.members.find((member) => member.projectId === api.project)?.hostEvidence
            ?.checks,
          "failed",
        );
        assert.notEqual(changed.readiness.reviewId, read.readiness.reviewId);
        assert.equal(
          (yield* store.snapshot).mergeGroupReviews.find(
            (review) => review.id === read.readiness.reviewId,
          )?.decision?.outcome,
          "approved",
        );
        const staleApproval = yield* factory
          .dispatch(
            { kind: "human" },
            { ...approval, commandId: CommandId.make("approve-old-combined") },
          )
          .pipe(Effect.flip);
        assert.equal(staleApproval.code, "stale-revision");
      }).pipe(Effect.provide(runtime), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(mergeEffectsBase)),
);
