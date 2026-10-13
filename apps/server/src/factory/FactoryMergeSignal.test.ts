// @effect-diagnostics nodeBuiltinImport:off -- runs the standalone gate script exactly as a workflow job does.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FACTORY_MERGE_GROUP_LABEL,
  FACTORY_MERGE_GROUP_STATUS_CONTEXT,
  FactoryError,
  factoryMergeDeploymentGate,
  type FactoryMergeOperation,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Access from "./FactoryControlAccess.ts";
import { mergeFixture } from "./FactoryMerge.testkit.ts";
import { verified } from "./FactoryIntegration.testkit.ts";
import * as MergeEffects from "./FactoryMergeEffects.ts";
import { mergeEffectsBase } from "./FactoryMergeEffects.testkit.ts";
import { factoryMergeSignal } from "./FactoryMergeOperation.ts";
import * as Effects from "./FactoryMergeOperationEffects.ts";
import { makeMergeOperationHarness } from "./FactoryMergeOperationEffects.testkit.ts";
import * as MergeSignal from "./FactoryMergeSignal.ts";
import { serveFakeGitHub } from "./FactoryMergeSignal.testkit.ts";
import * as Gate from "./FactoryPullRequestGate.ts";
import * as Store from "./FactoryStore.ts";

const base = Layer.mergeAll(Gate.layer, Access.layer).pipe(Layer.provideMerge(mergeEffectsBase));
const script = NodeURL.fileURLToPath(
  new URL("../../../../scripts/factory/merge-group-gate.mjs", import.meta.url),
);

/** Runs the shipped deployment gate script against the fake GitHub, as a workflow job would. */
const runGate = (api: string, repository: string, sha: string, timeout = "0.3") =>
  Effect.promise(
    () =>
      new Promise<{ code: number; output: string }>((resolve) => {
        NodeChildProcess.execFile(
          process.execPath,
          [script, "--timeout", timeout, "--interval", "0.05"],
          {
            env: {
              ...process.env,
              GITHUB_API_URL: api,
              GITHUB_TOKEN: "fake-token",
              GITHUB_REPOSITORY: repository,
              GITHUB_SHA: sha,
            },
          },
          (error, stdout, stderr) =>
            resolve({ code: error ? Number(error.code ?? 1) : 0, output: stdout + stderr }),
        );
      }),
  );

const receipt = (operation: FactoryMergeOperation, index: number) => {
  const outcome = operation.members[index]!.outcome;
  if (outcome.phase !== "confirmed") throw new Error(`Member ${index} has not merged`);
  return outcome.receipt;
};

const handleFirst = (type: string) =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryStore;
    const effects = yield* Effects.FactoryMergeOperationEffects;
    const pending = (yield* store.pending).find((entry) => entry.intent.type === type);
    if (pending) yield* effects.handle(pending);
    return pending !== undefined;
  });
const handleSignals = Effect.gen(function* () {
  while (yield* handleFirst("merge.operation.signal"));
});
const handleHolds = Effect.gen(function* () {
  const store = yield* Store.FactoryStore;
  const effects = yield* MergeEffects.FactoryMergeEffects;
  for (const pending of (yield* store.pending).filter(
    (entry) => entry.intent.type === "merge.group.hold",
  ))
    yield* effects.handle(pending);
});
/** Merge commits only; member heads carry the same context while the group holds them. */
const mergeCommitStatuses = <T extends { readonly sha: string }>(github: {
  readonly statuses: ReadonlyArray<T>;
}) => github.statuses.filter((entry) => entry.sha.startsWith("merge-"));

it.effect(
  "keeps one merged member from deploying, releases both projects once the group completes, and leaves approval in charge",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeMergeOperationHarness();
      const api = yield* serveFakeGitHub(harness.github);
      yield* Effect.gen(function* () {
        yield* harness.start;
        yield* handleFirst("merge.operation.prepare");
        yield* handleFirst("merge.operation.advance");
        yield* handleSignals;
        const partial = yield* harness.current;
        assert.deepEqual(
          partial.members.map((entry) => entry.outcome.phase),
          ["confirmed", "pending"],
        );
        const first = receipt(partial, 0);
        assert.equal(partial.signal?.state, "pending");
        const waiting = yield* runGate(api, first.ref.repository, first.mergeCommitSha);
        assert.equal(waiting.code, 1);
        assert.include(waiting.output, "1 of 2 merges confirmed");
        assert.include(waiting.output, "Re-run this job");

        yield* harness.drain;
        const completed = yield* harness.current;
        assert.equal(completed.lifecycle.phase, "completed");
        assert.equal(completed.signal?.state, "success");
        for (const index of [0, 1]) {
          const merged = receipt(completed, index);
          const released = yield* runGate(api, merged.ref.repository, merged.mergeCommitSha);
          assert.equal(released.code, 0, released.output);
          assert.include(released.output, completed.groupId);
        }
        // The gate only reads, so it cannot grant a deployment, approve an environment or post a
        // status. The deploy job's own `environment:` approval stays in charge.
        assert.isNotEmpty(harness.github.served);
        assert.deepEqual(
          harness.github.served.filter((entry) => !entry.startsWith("GET ")),
          [],
        );

        harness.github.associate(first.ref.repository, "ordinary-commit", 99);
        const ordinary = yield* runGate(api, first.ref.repository, "ordinary-commit");
        assert.equal(ordinary.code, 0);
        assert.include(ordinary.output, "not part of a Satellite merge group");

        const writes = harness.github.writes;
        assert.deepEqual(
          writes.filter((entry) => !entry.startsWith("status")),
          [
            `create-label ${first.ref.repository}`,
            `add-label ${first.ref.repository}#${first.ref.number}`,
            `create-label ${receipt(completed, 1).ref.repository}`,
            `add-label ${receipt(completed, 1).ref.repository}#${receipt(completed, 1).ref.number}`,
          ],
        );
        assert.isTrue(completed.members.every((entry) => entry.labeled === true));
        // Each write moved the state on; none repeats the one before it on the same commit.
        const posted = mergeCommitStatuses(harness.github).map(
          (entry) => `${entry.repository}@${entry.sha} ${entry.state} ${entry.description}`,
        );
        assert.equal(new Set(posted).size, posted.length);
        assert.isTrue(
          harness.github.statuses.every(
            (entry) => entry.context === FACTORY_MERGE_GROUP_STATUS_CONTEXT,
          ),
        );

        // With every receipt present, nothing short of a completed operation reads as success.
        if (completed.lifecycle.phase !== "completed") return;
        const frozen = completed.lifecycle.frozen;
        const unfinished: FactoryMergeOperation["lifecycle"][] = [
          { phase: "running", frozen },
          {
            phase: "attention",
            frozen,
            reason: "Unresolved member failure",
            recommendation: "Reconcile actual outcomes",
            retry: "reconcile",
          },
        ];
        for (const lifecycle of unfinished)
          assert.equal(factoryMergeSignal({ ...completed, lifecycle })?.state, "pending");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect("publishes failure on merged members when the human stops a partial merge", () =>
  Effect.gen(function* () {
    const harness = yield* makeMergeOperationHarness();
    const api = yield* serveFakeGitHub(harness.github);
    yield* Effect.gen(function* () {
      const operation = yield* harness.start;
      yield* handleFirst("merge.operation.prepare");
      yield* handleFirst("merge.operation.advance");
      yield* harness.commit({
        type: "merge.operation.stop",
        operationId: operation.id,
        commandId: CommandId.make("stop-partial"),
        reason: "The API change must ship separately",
      });
      yield* handleSignals;
      const stopped = yield* harness.current;
      assert.equal(stopped.signal?.state, "failure");
      const first = receipt(stopped, 0);
      const gate = yield* runGate(api, first.ref.repository, first.mergeCommitSha);
      assert.equal(gate.code, 1);
      assert.include(gate.output, "did not complete");
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect(
  "replays readiness after a lost receipt and a restart without duplicate statuses or labels",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeMergeOperationHarness();
      // The process stops after GitHub accepts each readiness write, before its receipt lands.
      const crashing = Layer.succeed(Store.FactoryStore, {
        ...harness.store,
        finishEffect: (input) =>
          input.command.type === "merge.operation.signaled"
            ? Effect.fail(new FactoryError({ code: "persistence", detail: "Process stopped" }))
            : harness.store.finishEffect(input),
      });
      yield* Effect.gen(function* () {
        const operation = yield* harness.start;
        const effects = yield* Effects.FactoryMergeOperationEffects;
        for (let turn = 0; turn < 30; turn++) {
          const next = (yield* harness.store.pending).find(
            (entry) =>
              entry.intent.type.startsWith("merge.operation.") &&
              entry.intent.type !== "merge.operation.signal",
          );
          if (!next) break;
          yield* effects.handle(next);
        }
        const signals = (yield* harness.store.pending).filter(
          (entry) => entry.intent.type === "merge.operation.signal",
        );
        for (const pending of signals) yield* effects.handle(pending);
        assert.equal((yield* harness.current).lifecycle.phase, "completed");
        assert.isUndefined((yield* harness.current).signal);
        const statuses = mergeCommitStatuses(harness.github).length;
        assert.equal(statuses, 2);
        assert.equal(
          (yield* harness.store.pending).filter(
            (entry) => entry.intent.type === "merge.operation.signal",
          ).length,
          signals.length,
        );

        yield* harness.commit({
          type: "merge.operation.reconcile",
          operationId: operation.id,
          commandId: CommandId.make("reconcile-unconfirmed-readiness"),
        });
        assert.equal(
          (yield* harness.store.pending).filter(
            (entry) => entry.intent.type === "merge.operation.signal",
          ).length,
          signals.length + 1,
        );

        yield* Effect.gen(function* () {
          yield* harness.drain;
          const recovered = yield* harness.current;
          assert.equal(recovered.signal?.state, "success");
          assert.equal(mergeCommitStatuses(harness.github).length, statuses);
          const labels = harness.github.writes.filter((entry) => !entry.startsWith("status"));
          yield* MergeSignal.FactoryMergeSignal.use((host) =>
            host.label(receipt(recovered, 0).ref),
          ).pipe(Effect.provide(MergeSignal.layer.pipe(Layer.provide(harness.github.layer))));
          assert.deepEqual(
            harness.github.writes.filter((entry) => !entry.startsWith("status")),
            labels,
          );
        }).pipe(
          Effect.provide(
            Layer.fresh(harness.layer).pipe(Layer.provideMerge(Layer.fresh(Store.layer))),
          ),
        );
      }).pipe(Effect.provide(harness.layer.pipe(Layer.provide(crashing))));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it("shows the deployment gate as unavailable from setup until every member publishes a GitHub PR", () => {
  // A freshly commissioned integration: its members have not published pull requests yet, which
  // stays true for a project whose remote Satellite cannot publish to.
  const setup = verified().state;
  const group = setup.mergeGroups[0]!;
  const unavailable = factoryMergeDeploymentGate(group.memberAssignmentIds, setup.assignments);
  assert.isFalse(unavailable.supported);
  for (const id of group.memberAssignmentIds)
    assert.include(
      unavailable.detail,
      setup.assignments.find((entry) => entry.id === id)!.projectId,
    );
  const { state, groupId } = mergeFixture();
  const published = state.mergeGroups.find((entry) => entry.id === groupId)!;
  const available = factoryMergeDeploymentGate(published.memberAssignmentIds, state.assignments);
  assert.isTrue(available.supported);
  // Available is not enforced: only a pipeline running the gate job holds its deployment.
  assert.include(available.detail, "pipeline runs the merge group gate");
});

it.effect(
  "labels member PRs and holds their heads pending as soon as the group forms, until the shared merge runs",
  () =>
    Effect.gen(function* () {
      let headStatus: (ref: PullRequestRef) => string | undefined = () => undefined;
      const harness = yield* makeMergeOperationHarness({
        newGroup: true,
        // GitHub refuses a merge while a required head status is pending.
        beforeWrite: (ref) =>
          headStatus(ref) === "success"
            ? Effect.void
            : Effect.fail(
                new FactoryError({ code: "permission-denied", detail: "Required status" }),
              ),
      });
      headStatus = (ref) =>
        harness.github.status(
          harness.fixture.state.assignments
            .flatMap((entry) => entry.delivery?.revisions ?? [])
            .find((revision) => revision.publication?.ref?.number === ref.number)!.publication!
            .headSha,
          FACTORY_MERGE_GROUP_STATUS_CONTEXT,
        )?.state;
      yield* Effect.gen(function* () {
        const operation = yield* harness.start;
        yield* handleHolds;
        const members = operation.members.map((entry) => entry.reviewed);
        assert.lengthOf(harness.writes, 0);
        for (const member of members) {
          assert.include(
            harness.github.labels(member.ref.repository, member.ref.number),
            FACTORY_MERGE_GROUP_LABEL,
          );
          assert.equal(
            harness.github.status(member.headSha, FACTORY_MERGE_GROUP_STATUS_CONTEXT)?.state,
            "pending",
          );
        }
        yield* harness.drain;
        assert.equal((yield* harness.current).lifecycle.phase, "completed");
        assert.lengthOf(harness.writes, 2);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect(
  "keeps waiting while GitHub has not yet associated a grouped merge commit with its PR",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeMergeOperationHarness();
      const api = yield* serveFakeGitHub(harness.github);
      yield* Effect.gen(function* () {
        yield* harness.start;
        yield* handleFirst("merge.operation.prepare");
        yield* handleFirst("merge.operation.advance");
        const first = receipt(yield* harness.current, 0);
        harness.github.lagAssociation(first.ref.repository, first.mergeCommitSha, 2);
        const gate = yield* runGate(api, first.ref.repository, first.mergeCommitSha);
        assert.equal(gate.code, 1);
        assert.notInclude(gate.output, "not part of a Satellite merge group");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(base), Effect.scoped),
);

it.effect("returns released members to their own merge and deployment on GitHub", () =>
  Effect.gen(function* () {
    const harness = yield* makeMergeOperationHarness();
    yield* Effect.gen(function* () {
      const operation = yield* harness.start;
      yield* handleFirst("merge.operation.prepare");
      yield* handleFirst("merge.operation.advance");
      yield* harness.commit({
        type: "merge.operation.stop",
        operationId: operation.id,
        commandId: CommandId.make("stop-before-release"),
        reason: "Ship the API change on its own",
      });
      yield* handleHolds;
      const unmerged = (yield* harness.current).members.find(
        (entry) => entry.outcome.phase === "pending",
      )!.reviewed;
      assert.equal(
        harness.github.status(unmerged.headSha, FACTORY_MERGE_GROUP_STATUS_CONTEXT)?.state,
        "pending",
      );
      yield* harness.commit({
        type: "merge.group.release",
        groupId: operation.groupId,
        commandId: CommandId.make("release-group"),
        reason: "Ship the API change on its own",
      });
      yield* handleHolds;
      assert.notInclude(
        harness.github.labels(unmerged.ref.repository, unmerged.ref.number),
        FACTORY_MERGE_GROUP_LABEL,
      );
      assert.equal(
        harness.github.status(unmerged.headSha, FACTORY_MERGE_GROUP_STATUS_CONTEXT)?.state,
        "success",
      );
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(base), Effect.scoped),
);
