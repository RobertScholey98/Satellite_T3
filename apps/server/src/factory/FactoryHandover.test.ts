import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import {
  FactoryExecution,
  layerThreadGovernance,
  type FactoryExecutionProfile,
} from "./FactoryExecution.ts";
import * as FactoryExecutionTestkit from "./FactoryExecution.testkit.ts";
import * as FactoryHandover from "./FactoryHandover.ts";

const projectId = ProjectId.make("handover-project");
const threadId = ThreadId.make("handover-thread");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const profile: FactoryExecutionProfile = {
  boundaryId: "managed-thread-boundary",
  dockerContext: "default",
  imageId: "sha256:qualified",
  projectSnapshotPath: "/captured",
  workflowSnapshotPath: "/workflow",
  runtimePath: "/runtime",
};

const create = (id = threadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId: id,
      projectId,
      title: "Existing work",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/existing",
      worktreePath: "/original-worktree",
      createdBy: "user",
      creationSource: "web",
    });
  });
const send = (text: string, id = threadId, queued = false) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${id}:${text}`),
      threadId: id,
      messageId: MessageId.make(`message:${id}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });
const terminalize = (id = threadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projection = yield* projections.getThreadProjection(id);
    const run = projection.runs.at(-1)!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`complete:${run.id}`),
      type: "run.updated",
      threadId: id,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", startedAt: now, completedAt: now },
    });
  });

it.effect(
  "handover stops the delegated team and waits for every runtime before capturing work",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const detached = yield* Ref.make<ThreadId[]>([]);
      const captured = yield* Ref.make(false);
      const provider = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        detach: (input) =>
          Effect.gen(function* () {
            assert.equal(input.awaitQuiescence, true);
            yield* Ref.update(detached, (ids) => [...ids, input.threadId]);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
      });
      const layer = FactoryHandover.layer.pipe(
        Layer.provideMerge(
          Layer.merge(ThreadManagement.layer.pipe(Layer.provideMerge(Satellite.layer)), provider),
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const handover = yield* FactoryHandover.FactoryHandover;
        const sink = yield* EventSink.EventSinkV2;
        yield* create();
        yield* send("Original task");
        const parent = yield* projections.getThreadProjection(threadId);
        const run = parent.runs[0]!;
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate-before-handover"),
          parentThreadId: threadId,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: "Investigate existing behavior",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const child = (yield* projections.getThreadProjection(threadId)).subagents[0]!
          .childThreadId!;
        yield* send("Queued follow-up", child, true);
        yield* projections.apply({
          id: EventId.make("parent-awaiting-checkpoint"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: yield* DateTime.now,
          payload: { ...run, status: "waiting" },
        });
        const fiber = yield* handover
          .stop({ threadId, projectId, commandId: CommandId.make("handover") })
          .pipe(Effect.andThen(Ref.set(captured, true)), Effect.forkScoped);
        yield* Deferred.await(entered);
        assert.deepEqual(
          (yield* projections.getThreadProjection(child)).runs.map((entry) => [
            entry.status,
            entry.queueHeld ?? false,
          ]),
          [
            ["interrupted", false],
            ["queued", true],
          ],
        );
        assert.equal(yield* Ref.get(captured), false);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(captured), false);
        yield* sink.write({
          events: [
            {
              id: EventId.make("parent-stop-settled"),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: yield* DateTime.now,
              payload: { ...run, status: "interrupted", completedAt: yield* DateTime.now },
            },
          ],
        });
        yield* Fiber.join(fiber);
        assert.equal(yield* Ref.get(captured), true);
        assert.deepEqual((yield* Ref.get(detached)).toSorted(), [threadId, child].toSorted());
        const after = yield* projections.getThreadProjection(threadId);
        assert.equal(after.thread.worktreePath, "/original-worktree");
        assert.equal(after.thread.branch, "feature/existing");
        assert.equal(after.messages[0]?.text, "Original task");
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
);

it.effect("same-model handover keeps conversation history in a fresh confined native context", () =>
  Effect.gen(function* () {
    const boundary = yield* Ref.make<FactoryExecutionProfile | undefined>(undefined);
    const execution = Layer.mock(FactoryExecution)({
      runtimePolicyFor: () => Ref.get(boundary),
      assertSelectionFor: () => Effect.void,
      assertDelegationFor: () => Effect.void,
    });
    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* create();
      yield* send("Keep the existing accessible navigation behavior");
      yield* terminalize();
      const before = yield* projections.getThreadProjection(threadId);
      const previous = before.providerThreads[0]!;
      yield* projections.apply({
        id: EventId.make("host-native-context"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: {
          ...previous,
          nativeThreadRef: {
            driver: ProviderDriverKind.make("codex"),
            nativeId: "host-native-history",
            strength: "strong",
          },
        },
      });
      yield* Ref.set(boundary, profile);
      yield* send("Continue under the approved manager");
      const after = yield* projections.getThreadProjection(threadId);
      const current = after.providerThreads.find(
        (entry) => entry.id === after.runs.at(-1)?.providerThreadId,
      )!;
      assert.equal(current.executionBoundaryId, "managed-thread-boundary");
      assert.notEqual(current.id, previous.id);
      assert.equal(current.nativeThreadRef, null);
      assert.notEqual(current.providerSessionId, previous.providerSessionId);
      assert.deepEqual(
        after.messages.map((entry) => entry.text),
        ["Keep the existing accessible navigation behavior", "Continue under the approved manager"],
      );
      assert.equal(after.contextHandoffs.at(-1)?.strategy, "full_thread_summary");
      assert.include(
        JSON.stringify(after.contextHandoffs),
        "Keep the existing accessible navigation behavior",
      );
      yield* terminalize();
      yield* send("Continue the managed task");
      const continued = yield* projections.getThreadProjection(threadId);
      assert.equal(continued.runs.at(-1)?.providerThreadId, current.id);
      assert.equal(continued.contextHandoffs.length, 1);
    }).pipe(
      Effect.provide(
        Satellite.layerWithGovernance(
          layerThreadGovernance.pipe(
            Layer.provide(Layer.merge(execution, FactoryExecutionTestkit.layerUnmanagedControls)),
          ),
        ),
      ),
    );
  }),
);

it.effect("a strict worker stop preserves its parent and independent implementation teams", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const handover = yield* FactoryHandover.FactoryHandover;
    yield* create();
    yield* send("Coordinate the project");
    const independent = ThreadId.make("independent-implementation-team");
    yield* create(independent);
    yield* send("Continue authorized implementation", independent);
    const parent = yield* projections.getThreadProjection(threadId);
    const run = parent.runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-for-shared-stop"),
      parentThreadId: threadId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: "Inspect one scoped concern",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const child = (yield* projections.getThreadProjection(threadId)).subagents[0]!.childThreadId!;
    assert.equal(
      (yield* handover
        .stop({ threadId: child, projectId, commandId: CommandId.make("invalid-worker-handover") })
        .pipe(Effect.flip)).code,
      "invalid-state",
    );
    yield* handover.stopTeam({
      threadId: child,
      projectId,
      commandId: CommandId.make("stop-worker"),
    });
    assert.equal((yield* projections.getThreadProjection(child)).runs[0]?.status, "interrupted");
    assert.equal((yield* projections.getThreadProjection(threadId)).runs[0]?.status, "starting");
    assert.equal((yield* projections.getThreadProjection(independent)).runs[0]?.status, "starting");
    yield* handover.stopTeam({ threadId, projectId, commandId: CommandId.make("pause-manager") });
    assert.equal((yield* projections.getThreadProjection(threadId)).runs[0]?.status, "interrupted");
    assert.equal((yield* projections.getThreadProjection(independent)).runs[0]?.status, "starting");
  }).pipe(
    Effect.provide(
      FactoryHandover.layer.pipe(
        Layer.provideMerge(
          Layer.merge(
            ThreadManagement.layer.pipe(Layer.provideMerge(Satellite.layer)),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              detach: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect(
  "a held host queue fails visibly instead of resuming its old context after handover",
  () =>
    Effect.gen(function* () {
      const boundary = yield* Ref.make<FactoryExecutionProfile | undefined>(undefined);
      const execution = Layer.mock(FactoryExecution)({
        runtimePolicyFor: () => Ref.get(boundary),
        assertSelectionFor: () => Effect.void,
        assertDelegationFor: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* create();
        yield* send("Host work");
        yield* send("Queued before handover", threadId, true);
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-host-queue"),
          threadId,
        });
        yield* Ref.set(boundary, profile);
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("resume-host-queue"),
          threadId,
        });
        const after = yield* projections.getThreadProjection(threadId);
        assert.equal(after.runs.at(-1)?.status, "failed");
        assert.include(JSON.stringify(after.turnItems), "previous execution boundary");
        assert.deepEqual(
          after.messages.map((message) => message.text),
          ["Host work", "Queued before handover"],
        );
      }).pipe(
        Effect.provide(
          Satellite.layerWithGovernance(
            layerThreadGovernance.pipe(
              Layer.provide(Layer.merge(execution, FactoryExecutionTestkit.layerUnmanagedControls)),
            ),
          ),
        ),
      );
    }),
);

// Forks are independent human threads, so stopping a team leaves them running.
it.effect("strict stop leaves ordinary forks running while reporting a failed detach", () =>
  Effect.gen(function* () {
    const detached = yield* Ref.make<ThreadId[]>([]);
    const provider = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      detach: (input) =>
        Ref.update(detached, (ids) => [...ids, input.threadId]).pipe(
          Effect.andThen(
            input.threadId === threadId
              ? Effect.fail(
                  new ProviderSessionManager.ProviderSessionCloseError({
                    providerSessionId: input.providerSessionId,
                  }),
                )
              : Effect.void,
          ),
        ),
    });
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const handover = yield* FactoryHandover.FactoryHandover;
      yield* create();
      yield* send("Original completed turn");
      yield* terminalize();
      const sourceRunId = (yield* projections.getThreadProjection(threadId)).runs[0]!.id;
      const children = [ThreadId.make("ordinary-fork-one"), ThreadId.make("ordinary-fork-two")];
      for (const child of children) {
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`create:${child}`),
          sourceThreadId: threadId,
          targetThreadId: child,
          sourcePoint: { type: "run", runId: sourceRunId },
          title: "Forked managed work",
          createdBy: "user",
          creationSource: "web",
        });
        yield* send("Continue scoped work", child);
      }
      const failure = yield* handover
        .stopTeam({ threadId, projectId, commandId: CommandId.make("cancel-forked-team") })
        .pipe(Effect.flip);
      assert.equal(failure.code, "execution-unavailable");
      assert.deepEqual(yield* Ref.get(detached), [threadId]);
      for (const child of children) {
        const projection = yield* projections.getThreadProjection(child);
        assert.notEqual(projection.runs.at(-1)?.status, "interrupted");
        assert.equal(projection.thread.lineage.relationshipToParent, "fork");
        assert.equal(projection.messages.at(-1)?.text, "Continue scoped work");
      }
    }).pipe(
      Effect.provide(
        FactoryHandover.layer.pipe(
          Layer.provideMerge(
            Layer.merge(ThreadManagement.layer.pipe(Layer.provideMerge(Satellite.layer)), provider),
          ),
        ),
      ),
      Effect.scoped,
    );
  }),
);
