import { assert, it } from "@effect/vitest";
import { type FactorySnapshot, type PullRequestRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Gate from "./FactoryPullRequestGate.ts";
import { FactoryStore } from "./FactoryStore.ts";
import { ready } from "./FactoryIntegration.testkit.ts";
import { factoryMergeGroupForAssignment } from "./FactoryMergeOwnership.ts";
import { deliveryIds } from "./FactoryDelivery.testkit.ts";

it.effect(
  "holds canonical historical and reserved-branch group ownership across all ordinary mutation routes",
  () => {
    const fixture = ready().state;
    const ref: PullRequestRef = {
      projectId: deliveryIds.project,
      repository: "OWNER/Repo",
      number: 20,
    };
    let state: FactorySnapshot = {
      ...fixture,
      mergeGroups: [],
      assignments: fixture.assignments.map((assignment) =>
        assignment.id === deliveryIds.assignment
          ? {
              ...assignment,
              delivery: {
                ...assignment.delivery!,
                revisions: assignment.delivery!.revisions.map((revision) => ({
                  ...revision,
                  publication: {
                    reservationId: "reserved",
                    host: "GITHUB.COM",
                    repository: "owner/repo",
                    branch: "factory/pending",
                    baseBranch: "main",
                    headSha: "head",
                    treeOid: "tree",
                    ref,
                  },
                })),
              },
            }
          : assignment,
      ),
    };
    return Effect.gen(function* () {
      const gate = yield* Gate.FactoryPullRequestGate;
      const target = {
        ref: { ...ref, host: "github.com", repository: "owner/repo" },
        headSha: "head",
        headBranch: "different-branch",
      };
      for (const action of ["merge", "enable-auto-merge", "close-as-delivered"]) {
        const error = yield* gate
          .authorizeMutation({ action, targets: [target], expectedHeadSha: "head" })
          .pipe(
            Effect.provideService(Gate.FactoryDeliveryPermit, {
              assignmentId: deliveryIds.assignment,
              revisionId: state.assignments[0]!.delivery!.currentRevisionId!,
              operationId: "forged-individual-permit",
            }),
            Effect.flip,
          );
        assert.equal(error.code, "permission-denied");
        assert.include(error.detail!, "merge group");
      }
      // Closing, reopening or withdrawing auto-merge merges nothing, and hosts accept a head
      // condition only on merges.
      for (const action of ["close", "reopen", "disable-auto-merge"])
        assert.deepEqual(
          yield* gate.authorizeMutation({ action, targets: [target], expectedHeadSha: "head" }),
          { managed: true, requireConditionalMerge: false },
        );
      assert.equal(
        (yield* gate
          .authorizeMutation({ action: "merge", targets: [target], stack: true })
          .pipe(Effect.flip)).code,
        "permission-denied",
      );
      assert.equal(
        (yield* gate
          .authorizeMutation({
            action: "merge",
            targets: [
              { ...target, ref: { ...target.ref, number: 99 }, headBranch: "factory/pending" },
            ],
          })
          .pipe(Effect.flip)).code,
        "permission-denied",
      );
      const group = factoryMergeGroupForAssignment(state, deliveryIds.assignment)!;
      state = {
        ...state,
        mergeGroups: [
          group,
          { ...group, id: "duplicate-owner", integrationId: "duplicate-integration" },
        ],
        assignments: [],
        integrations: [],
      };
      assert.isTrue(yield* gate.appliesToRepository("GitHub.Com", "OWNER/REPO"));
      assert.equal(
        (yield* gate.authorizeMutation({ action: "merge", targets: [target] }).pipe(Effect.flip))
          .code,
        "permission-denied",
      );
      assert.deepEqual(
        yield* gate.authorizeMutation({
          action: "merge",
          targets: [{ ...target, ref: { ...target.ref, number: 21 } }],
        }),
        { managed: false, requireConditionalMerge: false },
      );
    }).pipe(
      Effect.provide(
        Gate.layer.pipe(
          Layer.provide(Layer.mock(FactoryStore)({ snapshot: Effect.sync(() => state) })),
        ),
      ),
    );
  },
);
