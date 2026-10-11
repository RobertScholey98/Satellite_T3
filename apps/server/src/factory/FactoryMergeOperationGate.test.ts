import { assert, it } from "@effect/vitest";
import { FactoryControlId, type FactorySnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Gate from "./FactoryPullRequestGate.ts";
import { FactoryStore } from "./FactoryStore.ts";
import {
  frozenMergeOperationFixture,
  submitMergeMember,
  deliveryNow,
} from "./FactoryMergeOperation.testkit.ts";

it.effect(
  "admits only the current private shared attempt and rechecks every remaining owner's authority",
  () => {
    const fixture = frozenMergeOperationFixture();
    const submitted = submitMergeMember(fixture.state, fixture.operationId);
    let state: FactorySnapshot = submitted.state;
    const operation = state.mergeOperations[0]!;
    const member = operation.members[0]!;
    const permit = {
      groupId: operation.groupId,
      operationId: operation.id,
      assignmentId: member.reviewed.assignmentId,
      revisionId: member.reviewed.revisionId,
      attemptId: submitted.attemptId,
      expectedHeadSha: member.reviewed.headSha,
      frozenDigest: fixture.frozen.digest,
    };
    return Effect.gen(function* () {
      const gate = yield* Gate.FactoryPullRequestGate;
      const input = {
        action: "merge",
        expectedHeadSha: member.reviewed.headSha,
        targets: [
          {
            ref: member.reviewed.ref,
            headBranch: "factory/current",
            headSha: member.reviewed.headSha,
          },
        ],
      };
      assert.equal(
        (yield* gate.authorizeMutation(input).pipe(Effect.flip)).code,
        "permission-denied",
      );
      assert.deepEqual(
        yield* gate
          .authorizeMutation(input)
          .pipe(Effect.provideService(Gate.FactoryMergeGroupPermit, permit)),
        { managed: true, requireConditionalMerge: true },
      );
      assert.equal(
        (yield* gate.authorizeMutation(input).pipe(
          Effect.provideService(Gate.FactoryMergeGroupPermit, {
            ...permit,
            attemptId: "obsolete",
          }),
          Effect.flip,
        )).code,
        "permission-denied",
      );
      for (const action of ["enable-auto-merge", "revert"])
        assert.equal(
          (yield* gate
            .authorizeMutation({ ...input, action })
            .pipe(Effect.provideService(Gate.FactoryMergeGroupPermit, permit), Effect.flip)).code,
          "permission-denied",
        );
      const peer = operation.members[1]!;
      state = {
        ...submitted.state,
        controls: [
          {
            id: FactoryControlId.make("peer-pause"),
            kind: "project-pause",
            projectId: peer.reviewed.projectId,
            status: "active",
            generation: 1,
            requestedAt: deliveryNow,
            updatedAt: deliveryNow,
            stop: { status: "pending" },
          },
        ],
      };
      assert.equal(
        (yield* gate
          .authorizeMutation(input)
          .pipe(Effect.provideService(Gate.FactoryMergeGroupPermit, permit), Effect.flip)).code,
        "permission-denied",
      );
      state = {
        ...submitted.state,
        integrationGrants: submitted.state.integrationGrants.filter(
          (entry) => entry.id !== peer.authority.integrationGrantId,
        ),
      };
      assert.equal(
        (yield* gate
          .authorizeMutation(input)
          .pipe(Effect.provideService(Gate.FactoryMergeGroupPermit, permit), Effect.flip)).code,
        "permission-denied",
      );
      state = {
        ...submitted.state,
        assignments: submitted.state.assignments.map((entry) =>
          entry.id === peer.reviewed.assignmentId
            ? { ...entry, grant: { ...entry.grant!, epoch: entry.grant!.epoch + 1 } }
            : entry,
        ),
      };
      assert.equal(
        (yield* gate
          .authorizeMutation(input)
          .pipe(Effect.provideService(Gate.FactoryMergeGroupPermit, permit), Effect.flip)).code,
        "permission-denied",
      );
      state = submitted.state;
      assert.deepEqual(
        yield* gate
          .authorizeMutation(input)
          .pipe(Effect.provideService(Gate.FactoryMergeGroupPermit, permit)),
        { managed: true, requireConditionalMerge: true },
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
