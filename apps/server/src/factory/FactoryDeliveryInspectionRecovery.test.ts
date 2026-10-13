import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { CommandId, FactoryError, FactorySnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import type { ProviderMergeEvidence } from "../pullRequest/pullRequestMergeEvidence.ts";
import * as Store from "./FactoryStore.ts";
import * as Inspection from "./FactoryDeliveryInspection.ts";
import { deliveryRevisionCommand, reviewedDeliveryFixture } from "./FactoryDelivery.testkit.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const evidence: ProviderMergeEvidence = {
  headSha: "head",
  baseSha: "base",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  mergeState: "CLEAN",
  reviewDecision: "approved",
  autoMergeEnabled: false,
  mergeQueueEnabled: false,
  checks: [{ id: "required", name: "test", headSha: "head", required: true, status: "success" }],
  reviews: [],
  complete: true,
  issues: [],
};
const base = Store.layer.pipe(
  Layer.provideMerge(Satellite.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.effect(
  "persists a fresh changed host observation after a lost seal acknowledgement with the same caller request",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.FactoryStore;
      const sql = yield* SqlClient.SqlClient;
      const state = reviewedDeliveryFixture();
      yield* sql`INSERT INTO factory_state(id,revision,payload_json) VALUES(1,${state.revision},${encode(state)})`;
      let observed = evidence;
      let loseAck = true;
      let reads = 0;
      const fixtures = Layer.mergeAll(
        Layer.mock(PullRequests.PullRequestService)({
          inspectForMerge: () =>
            Effect.sync(() => {
              reads++;
              return observed;
            }),
        }),
        Layer.succeed(Store.FactoryStore, {
          ...store,
          commit: (input) =>
            store.commit(input).pipe(
              Effect.flatMap((receipt) => {
                if (loseAck && input.command.type === "delivery.inspected") {
                  loseAck = false;
                  return Effect.fail(
                    new FactoryError({
                      code: "persistence",
                      detail: "Lost local receipt acknowledgement",
                    }),
                  );
                }
                return Effect.succeed(receipt);
              }),
            ),
        }),
      );
      yield* Effect.gen(function* () {
        const inspection = yield* Inspection.FactoryDeliveryInspection;
        const request = {
          ...deliveryRevisionCommand,
          commandId: CommandId.make("same-refresh-request"),
        };
        yield* inspection.refresh(request).pipe(Effect.flip);
        const first = (yield* store.snapshot).assignments[0]!.delivery!.revisions[0]!;
        assert.equal(first.hostEvidence?.checks, "passed");
        observed = { ...evidence, checks: [{ ...evidence.checks[0]!, status: "failure" }] };
        yield* inspection.refresh(request);
        const changed = (yield* store.snapshot).assignments[0]!.delivery!.revisions[0]!;
        assert.equal(changed.hostEvidence?.checks, "failed");
        assert.notEqual(changed.bundleDigest, first.bundleDigest);
        const same = yield* inspection.inspect(request);
        assert.equal(same.bundleDigest, changed.bundleDigest);
        observed = { ...evidence, complete: false };
        assert.equal((yield* inspection.inspect(request)).evidence.checks, "unknown");
        observed = { ...evidence, checks: [{ ...evidence.checks[0]!, headSha: "stale-head" }] };
        assert.equal((yield* inspection.inspect(request)).evidence.checks, "unknown");
        assert.equal(reads, 5);
      }).pipe(Effect.provide(Inspection.layer.pipe(Layer.provide(fixtures))));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect("reports why a superseded revision cannot refresh instead of retrying it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const state = reviewedDeliveryFixture();
    yield* sql`INSERT INTO factory_state(id,revision,payload_json) VALUES(1,${state.revision},${encode(state)})`;
    const fixtures = Layer.mock(PullRequests.PullRequestService)({
      inspectForMerge: () => Effect.succeed(evidence),
    });
    const error = yield* Effect.gen(function* () {
      return yield* (yield* Inspection.FactoryDeliveryInspection).refresh({
        ...deliveryRevisionCommand,
        revisionId: "superseded-revision",
        commandId: CommandId.make("superseded-refresh"),
      });
    }).pipe(Effect.provide(Inspection.layer.pipe(Layer.provide(fixtures))), Effect.flip);
    assert.equal(error.code, "stale-revision");
    assert.equal(
      error.detail,
      "This delivery revision no longer matches its current execution grant and source.",
    );
  }).pipe(Effect.provide(base), Effect.scoped),
);
