import { assert, it } from "@effect/vitest";
import { CommandId, FactoryError, FactorySnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Effects from "./FactoryMergeOperationEffects.ts";
import * as Gate from "./FactoryPullRequestGate.ts";
import * as Store from "./FactoryStore.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Models from "./FactoryModelAdmission.ts";
import { makeMergeOperationHarness } from "./FactoryMergeOperationEffects.testkit.ts";
import { mergeEffectsBase } from "./FactoryMergeEffects.testkit.ts";
import { factoryCompletionEligibility } from "./FactoryRetros.ts";
import { deliverySelection, deliveryNow } from "./FactoryDelivery.testkit.ts";
import { canonicalFactoryPullRequest } from "./FactoryMergeOwnership.ts";

const base = Layer.mergeAll(Gate.layer, Access.layer, Models.layer).pipe(
  Layer.provideMerge(mergeEffectsBase),
);
const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));

it.effect(
  "records externally merged reviewed heads before freeze without inventing combined completion",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeMergeOperationHarness();
      yield* Effect.gen(function* () {
        const operation = yield* harness.start;
        for (const member of operation.members)
          harness.merged.add(canonicalFactoryPullRequest(member.reviewed.ref));
        yield* harness.drain;
        assert.equal((yield* harness.current).lifecycle.phase, "attention");
        yield* harness.commit({
          type: "merge.operation.reconcile",
          operationId: operation.id,
          commandId: CommandId.make("external-before-freeze"),
        });
        yield* harness.drain;
        const current = yield* harness.current;
        assert.isTrue(current.members.every((member) => member.outcome.phase === "confirmed"));
        assert.equal(current.lifecycle.phase, "attention");
        if (current.lifecycle.phase === "attention") {
          assert.isNull(current.lifecycle.frozen);
          assert.equal(current.lifecycle.retry, "none");
        }
        assert.equal(harness.writes.length, 0);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect(
  "freezes the integration, confirms actual member merges and retains delivery proof after the first team concludes",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeMergeOperationHarness();
      yield* Effect.gen(function* () {
        const operation = yield* harness.start;
        const access = yield* Access.FactoryControlAccess;
        const models = yield* Models.FactoryModelAdmission;
        const state = yield* harness.store.snapshot;
        const lead = state.assignments.find(
          (entry) => entry.id === operation.integrationAssignmentId,
        )!;
        assert.equal(
          (yield* access.assertExecution(lead.threadId).pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.equal(
          (yield* models.assertDelegationFor(lead.threadId, deliverySelection).pipe(Effect.flip))
            .code,
          "permission-denied",
        );
        const effects = yield* Effects.FactoryMergeOperationEffects;
        yield* effects.handle(
          (yield* harness.store.pending).find(
            (entry) => entry.intent.type === "merge.operation.prepare",
          )!,
        );
        assert.deepEqual(harness.stages.slice(-3), ["physical-stop", "provider-stop", "capture"]);
        yield* effects.handle(
          (yield* harness.store.pending).find(
            (entry) => entry.intent.type === "merge.operation.advance",
          )!,
        );
        const partial = yield* harness.current;
        assert.equal(partial.members[0]!.outcome.phase, "confirmed");
        assert.equal(partial.members[1]!.outcome.phase, "pending");
        const updated = yield* harness.store.snapshot;
        const concluded = {
          ...updated,
          revision: updated.revision + 1,
          assignments: updated.assignments.map((entry) => {
            if (entry.id !== partial.members[0]!.reviewed.assignmentId) return entry;
            const { grant: _grant, ...rest } = entry;
            return {
              ...rest,
              status: "complete" as const,
              completion: { ...entry.completion!, phase: "concluded" as const },
            };
          }),
        };
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE factory_state SET revision=${concluded.revision}, payload_json=${encode(concluded)} WHERE id=1`;
        yield* harness.drain;
        const completed = yield* harness.current;
        assert.equal(completed.lifecycle.phase, "completed");
        assert.deepEqual(
          completed.members.map((entry) => entry.attempts),
          [1, 1],
        );
        assert.equal(harness.writes.length, 2);
        const final = yield* harness.store.snapshot;
        assert.equal(
          final.assignments.filter((entry) =>
            entry.completion?.deliveries.some(
              (delivery) => delivery.kind === "pull-request-merged",
            ),
          ).length,
          2,
        );
        const eligible = factoryCompletionEligibility(
          final,
          final.assignments.find((entry) => entry.id === lead.id)!,
        );
        assert.isTrue(eligible.eligible);
        if (eligible.eligible) assert.equal(eligible.disposition.kind, "shared-group-delivered");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect.each(["lost-ack", "unknown", "transient"] as const)(
  "reconciles %s without unbounded or duplicate writes",
  (behavior) =>
    Effect.gen(function* () {
      const harness = yield* makeMergeOperationHarness({
        behavior: (ref) => (ref.number === 20 ? behavior : "merge"),
      });
      yield* Effect.gen(function* () {
        yield* harness.start;
        yield* harness.drain;
        const current = yield* harness.current;
        if (behavior === "lost-ack") {
          assert.equal(current.lifecycle.phase, "completed");
          assert.equal(harness.writes.length, 2);
        } else if (behavior === "unknown") {
          assert.equal(current.lifecycle.phase, "attention");
          assert.equal(
            current.members.filter((entry) => entry.outcome.phase === "unknown").length,
            1,
          );
          const before = harness.writes.length;
          yield* harness.commit({
            type: "merge.operation.reconcile",
            commandId: CommandId.make("restart-reconcile"),
            operationId: current.id,
          });
          yield* harness.drain.pipe(Effect.provide(Layer.fresh(harness.layer)));
          assert.equal(harness.writes.length, before);
        } else {
          assert.equal(current.lifecycle.phase, "attention");
          assert.equal(
            current.members.find((entry) => entry.reviewed.ref.number === 20)!.attempts,
            3,
          );
          assert.equal(harness.writes.filter((entry) => entry.endsWith("#20")).length, 3);
          const retry = yield* harness
            .commit({
              type: "merge.operation.retry",
              commandId: CommandId.make("exhausted-retry"),
              operationId: current.id,
            })
            .pipe(Effect.flip);
          assert.equal(retry.code, "permission-denied");
        }
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect("refuses changed stopped test bytes without a host write", () =>
  Effect.gen(function* () {
    const harness = yield* makeMergeOperationHarness({ changedCapture: true });
    yield* Effect.gen(function* () {
      yield* harness.start;
      yield* harness.drain;
      assert.equal((yield* harness.current).lifecycle.phase, "attention");
      assert.equal(harness.writes.length, 0);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect("denies a queued group write when another participant project pauses", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryStore;
    let staged = false;
    const harness = yield* makeMergeOperationHarness({
      beforeWrite: () =>
        Effect.gen(function* () {
          if (staged) return;
          staged = true;
          const operation = (yield* store.snapshot).mergeOperations[0]!;
          yield* store
            .commit({
              actor: { kind: "human" },
              now: deliveryNow,
              command: {
                type: "project.pause",
                commandId: CommandId.make("late-merge-pause"),
                projectId: operation.members[1]!.reviewed.projectId,
              },
            })
            .pipe(Effect.orDie);
        }),
    });
    yield* Effect.gen(function* () {
      yield* harness.start;
      yield* harness.drain;
      assert.isTrue(staged);
      assert.equal(harness.writes.length, 0);
      assert.equal((yield* harness.current).lifecycle.phase, "attention");
      assert.isFalse(
        (yield* harness.current).members.some((entry) => entry.outcome.phase === "unknown"),
      );
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect(
  "recreates the worker after an unobserved actual merge and reconciles it before the remaining write",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeMergeOperationHarness({ failFirstMergedRead: true });
      yield* Effect.gen(function* () {
        yield* harness.start;
        const effects = yield* Effects.FactoryMergeOperationEffects;
        yield* effects.handle(
          (yield* harness.store.pending).find(
            (entry) => entry.intent.type === "merge.operation.prepare",
          )!,
        );
        yield* effects.handle(
          (yield* harness.store.pending).find(
            (entry) => entry.intent.type === "merge.operation.advance",
          )!,
        );
        assert.equal((yield* harness.current).members[0]!.outcome.phase, "unknown");
        assert.equal(harness.writes.length, 1);
        yield* Effect.gen(function* () {
          yield* harness.drain;
          const recovered = yield* harness.current;
          assert.equal(recovered.members[0]!.outcome.phase, "confirmed");
          assert.equal(recovered.lifecycle.phase, "attention");
          assert.equal(harness.writes.length, 1);
          yield* harness.commit({
            type: "merge.operation.retry",
            operationId: recovered.id,
            commandId: CommandId.make("retry-confirmed-remainder"),
          });
          yield* harness.drain;
          assert.equal((yield* harness.current).lifecycle.phase, "completed");
          assert.equal(harness.writes.length, 2);
          assert.equal(new Set(harness.writes).size, 2);
        }).pipe(
          Effect.provide(
            Layer.fresh(harness.layer).pipe(Layer.provideMerge(Layer.fresh(Store.layer))),
          ),
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect(
  "preserves a durable unknown when the submission receipt acknowledgement is lost before the host call",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeMergeOperationHarness();
      let loseAck = true;
      const facade = Layer.succeed(Store.FactoryStore, {
        ...harness.store,
        finishEffect: (input) =>
          harness.store.finishEffect(input).pipe(
            Effect.flatMap((receipt) => {
              if (input.command.type === "merge.operation.submitting" && loseAck) {
                loseAck = false;
                return Effect.fail(
                  new FactoryError({
                    code: "persistence",
                    detail: "The submission receipt acknowledgement was lost",
                  }),
                );
              }
              return Effect.succeed(receipt);
            }),
          ),
      });
      yield* Effect.gen(function* () {
        yield* harness.start;
        yield* harness.drain;
        const current = yield* harness.current;
        assert.equal(current.lifecycle.phase, "attention");
        assert.equal(current.members[0]!.outcome.phase, "unknown");
        assert.equal(current.members[0]!.attempts, 1);
        assert.equal(harness.writes.length, 0);
        yield* harness.commit({
          type: "merge.operation.reconcile",
          operationId: current.id,
          commandId: CommandId.make("unknown-receipt-reconcile"),
        });
        yield* harness.drain.pipe(Effect.provide(Layer.fresh(harness.layer)));
        assert.equal(harness.writes.length, 0);
        assert.equal((yield* harness.current).members[0]!.outcome.phase, "unknown");
      }).pipe(Effect.provide(harness.layer.pipe(Layer.provide(facade))));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect(
  "releases only the safe stopped operation hold before returning control to the integration team",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeMergeOperationHarness();
      yield* Effect.gen(function* () {
        const operation = yield* harness.start;
        const effects = yield* Effects.FactoryMergeOperationEffects;
        yield* effects.handle(
          (yield* harness.store.pending).find(
            (entry) => entry.intent.type === "merge.operation.prepare",
          )!,
        );
        yield* harness.commit({
          type: "merge.operation.stop",
          operationId: operation.id,
          commandId: CommandId.make("safe-stop"),
          reason: "Revise the integration journey before merging",
        });
        yield* harness.drain;
        assert.equal((yield* harness.current).lifecycle.phase, "stopped");
        assert.equal(harness.writes.length, 0);
        assert.equal(harness.stages.filter((entry) => entry === "release").length, 1);
        const state = yield* harness.store.snapshot;
        const lead = state.assignments.find(
          (entry) => entry.id === operation.integrationAssignmentId,
        )!;
        yield* (yield* Access.FactoryControlAccess).assertExecution(lead.threadId);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);
