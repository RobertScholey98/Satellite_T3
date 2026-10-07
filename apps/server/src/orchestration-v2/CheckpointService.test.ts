import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as SatelliteTestRuntime from "./testkit/SatelliteTestRuntime.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
      threadId: ThreadId.make("thread:materialize-baseline"),
      runId: RunId.make("run:materialize-baseline:3"),
      nodeId: NodeId.make("node:materialize-baseline:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      lookupFails === "interrupt"
        ? Effect.interrupt
        : lookupFails
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test.ref",
                command: "git",
                cwd: "/repo",
                timeoutMs: 30000,
              }),
            )
          : Effect.succeed(true),
    );
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 2 }),
        );
        assert.isTrue(Exit.hasInterrupts(exit));
        const captureExit = yield* Effect.exit(
          checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          }),
        );
        assert.isTrue(Exit.hasInterrupts(captureExit));
        return;
      }
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 2,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.equal(
        baseline.ref,
        yield* CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 2,
        }),
      );
      assert.equal(baseline.status, lookupFails ? "missing" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("never checkpoints or restores the repository containing an owned idea workspace", () => {
  const isGitRepository = vi.fn(() => Effect.succeed(true));
  const captureCheckpoint = vi.fn(() => Effect.void);
  const restoreCheckpoint = vi.fn(() => Effect.succeed(true));
  const deleteCheckpointRefs = vi.fn(() => Effect.void);
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    IdAllocator.layer,
    Layer.mock(CheckpointStore.CheckpointStore)({
      isGitRepository,
      captureCheckpoint,
      restoreCheckpoint,
      deleteCheckpointRefs,
      hasCheckpointRef: () => Effect.die("An idea must not look up the project's checkpoint refs"),
    }),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const checkpoints = yield* CheckpointService.CheckpointServiceV2.pipe(
      Effect.provide(
        Layer.fresh(CheckpointService.layer).pipe(
          Layer.provide(
            Layer.mergeAll(dependencies, Layer.succeed(ProjectionStoreV2, projections)),
          ),
        ),
      ),
    );
    const projectId = ProjectId.make("project:idea-checkpoint");
    const threadId = ThreadId.make("thread:idea-checkpoint");
    const now = yield* DateTime.now;
    yield* SatelliteTestRuntime.recordProject({
      projectId,
      title: "Project",
      workspaceRoot: "/repo",
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:idea-checkpoint:create"),
      threadId,
      projectId,
      purpose: "idea",
      title: "Idea",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const scope = yield* checkpoints.prepareRootRunScope({
      threadId,
      runId: RunId.make("run:idea-checkpoint"),
      rootNodeId: NodeId.make("node:idea-checkpoint"),
      providerThreadId: ProviderThreadId.make("provider-thread:idea-checkpoint"),
      cwd: "/repo/.t3/userdata/ideas/owned",
      createdAt: now,
    });
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
    const baseline = yield* checkpoints.materializeBaselineCheckpoint({
      scope,
      ordinalWithinScope: 0,
    });
    assert.equal(baseline.status, "missing");
    const checkpoint = yield* checkpoints.capture({
      scope,
      runId: scope.runId,
      nodeId: NodeId.make("node:idea-checkpoint"),
      ordinalWithinScope: 1,
      appRunOrdinal: 1,
      capturedAt: now,
    });
    assert.equal(checkpoint.status, "missing");
    const failure = yield* checkpoints
      .restore({ scope, checkpoint: { ...checkpoint, status: "ready" } })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "CheckpointRestoreError");
    yield* checkpoints.deleteStaleRefs({ scope, checkpoints: [checkpoint] });
    assert.isEmpty(isGitRepository.mock.calls);
    assert.isEmpty(captureCheckpoint.mock.calls);
    assert.isEmpty(restoreCheckpoint.mock.calls);
    assert.isEmpty(deleteCheckpointRefs.mock.calls);
  }).pipe(Effect.provide(SatelliteTestRuntime.layer.pipe(Layer.provideMerge(NodeServices.layer))));
});
