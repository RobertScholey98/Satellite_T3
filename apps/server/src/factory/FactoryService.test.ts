import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import {
  layer as SatelliteTestLayer,
  recordProject,
} from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { FactoryExecution } from "./FactoryExecution.ts";
import { layerUnavailable as boundaryUnavailable } from "./FactoryBoundaryExecution.testkit.ts";

const projectId = ProjectId.make("factory-service-project");
const human = { kind: "human" } as const;
const create = {
  type: "manager.create" as const,
  commandId: CommandId.make("factory-service-create"),
  projectId,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved-model" },
  workflow: { repositoryRoot: "/owned-workflow", revision: "pinned-commit" },
};
const qualification = {
  status: "qualified" as const,
  profileId: "verified-profile",
  checkedAt: "2026-10-10T12:00:00.000Z",
};
const profile = {
  boundaryId: "verified-profile",
  dockerContext: "default",
  imageId: "sha256:verified-image",
  projectSnapshotPath: "/state/factory/project-snapshot",
  workflowSnapshotPath: "/state/factory/workflow-snapshot",
  runtimePath: "/state/factory/thread-runtime",
};

const runtime = Layer.mergeAll(
  FactoryStore.layer,
  ThreadManagement.layer,
  CommandReceipts.layer,
  boundaryUnavailable,
).pipe(Layer.provideMerge(SatelliteTestLayer));
const layer = FactoryService.layer.pipe(Layer.provideMerge(runtime));

it.effect("creates ordinary durable threads once and records the owning lead's report", () =>
  Effect.gen(function* () {
    const qualifications = yield* Ref.make(0);
    const execution = Layer.succeed(FactoryExecution, {
      qualify: () =>
        Ref.update(qualifications, (count) => count + 1).pipe(Effect.as(qualification)),
      runtimePolicyFor: () => Effect.succeed(profile),
    });
    yield* Effect.gen(function* () {
      yield* recordProject({ projectId, title: "Web", workspaceRoot: "/project" });
      const factory = yield* FactoryService.FactoryService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const first = yield* factory.dispatch(human, create);
      const retried = yield* factory.dispatch(human, create);
      assert.deepStrictEqual(retried, first);
      yield* factory.drain;
      assert.equal(yield* Ref.get(qualifications), 1);
      const snapshot = yield* factory.snapshot({ projectId });
      assert.equal(snapshot.managers.length, 1);
      assert.equal(snapshot.assignments.length, 1);
      const manager = snapshot.managers[0]!;
      const assignment = snapshot.assignments[0]!;
      assert.equal(manager.threadStatus, "created");
      assert.equal(assignment.threadStatus, "created");
      for (const threadId of [manager.threadId, assignment.threadId]) {
        const thread = yield* threads.getThreadProjection(threadId);
        assert.equal(thread.thread.lineage.parentThreadId, null);
        assert.equal(thread.thread.worktreePath, profile.projectSnapshotPath);
        assert.equal(thread.messages.length, 1);
      }
      const duplicate = yield* factory
        .dispatch(human, { ...create, commandId: CommandId.make("second-manager") })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(duplicate));
      if (Result.isFailure(duplicate))
        assert.equal(duplicate.failure.code, "project-already-managed");
      const report = {
        type: "onboarding.report" as const,
        commandId: CommandId.make("onboarding-report"),
        assignmentId: assignment.id,
        report: {
          summary: "Project inventory completed.",
          instructions: [
            {
              description: "Use existing project instructions.",
              evidence: [{ label: "Agent instructions", location: "AGENTS.md" }],
            },
          ],
          checks: [],
          tracker: { description: "Repository issues are configured.", evidence: [] },
          verificationTools: [],
          protectedControls: [],
          unresolvedDecisions: [],
        },
      };
      const spoofed = yield* factory
        .dispatch({ kind: "thread", threadId: ThreadId.make("unrelated-thread") }, report)
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(spoofed));
      yield* factory.dispatch({ kind: "thread", threadId: assignment.threadId }, report);
      const completed = yield* factory.snapshot({});
      assert.equal(completed.assignments[0]!.status, "complete");
      assert.equal(completed.managers[0]!.status, "blocked");
      assert.equal(completed.managers[0]!.wait?.kind, "execution-boundary");
    }).pipe(Effect.provide(layer), Effect.provide(execution));
  }),
);

it.effect("persists an actionable wait without launching when confinement is unavailable", () =>
  Effect.gen(function* () {
    yield* recordProject({ projectId, title: "Web", workspaceRoot: "/project" });
    const factory = yield* FactoryService.FactoryService;
    yield* factory.dispatch(human, create);
    yield* factory.drain;
    const snapshot = yield* factory.snapshot({});
    assert.equal(snapshot.managers[0]!.threadStatus, "pending");
    assert.equal(snapshot.assignments[0]!.status, "waiting");
    assert.equal(snapshot.managers[0]!.wait?.reason, "Start the local Docker engine.");
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(FactoryExecution, {
      qualify: () =>
        Effect.succeed({ status: "unavailable", reason: "Start the local Docker engine." }),
      runtimePolicyFor: () => Effect.die("An unavailable assignment must not launch."),
    }),
  ),
);

it.effect("a failed launch remains recoverable and its receipt does not claim success", () =>
  Effect.gen(function* () {
    const available = yield* Ref.make(false);
    yield* Effect.gen(function* () {
      yield* recordProject({ projectId, title: "API", workspaceRoot: "/project" });
      const factory = yield* FactoryService.FactoryService;
      yield* factory.dispatch(human, create);
      yield* factory.drain;
      const failed = yield* factory.snapshot({});
      assert.equal(failed.managers[0]!.status, "blocked");
      assert.equal(failed.managers[0]!.threadStatus, "pending");
      yield* Ref.set(available, true);
      yield* factory.dispatch(human, {
        type: "manager.retry-onboarding",
        commandId: CommandId.make("recover-onboarding"),
        managerId: failed.managers[0]!.id,
      });
      yield* factory.drain;
      const recovered = yield* factory.snapshot({});
      assert.equal(recovered.managers[0]!.threadStatus, "created");
      assert.equal(recovered.assignments[0]!.threadStatus, "created");
      assert.equal(recovered.assignments[0]!.id, failed.assignments[0]!.id);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(FactoryExecution, {
        qualify: () => Effect.succeed(qualification),
        runtimePolicyFor: () =>
          Ref.get(available).pipe(
            Effect.flatMap((ready) =>
              ready
                ? Effect.succeed(profile)
                : Effect.fail(new FactoryError({ code: "execution-unavailable" })),
            ),
          ),
      }),
    );
  }),
);

it.effect(
  "recovers a rejected lead message without replacing the profile or resending the manager",
  () =>
    Effect.gen(function* () {
      yield* recordProject({ projectId, title: "Web", workspaceRoot: "/project" });
      const threads = yield* ThreadManagement.ThreadManagementService;
      const orchestrator = yield* OrchestratorV2;
      const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
      const qualifications = yield* Ref.make(0);
      const sends = yield* Ref.make<ReadonlyArray<ThreadManagement.ThreadManagementSendInput>>([]);
      const rejectLead = yield* Ref.make(true);
      const interceptedThreads = {
        ...threads,
        sendToThread: (input: ThreadManagement.ThreadManagementSendInput) =>
          Effect.gen(function* () {
            yield* Ref.update(sends, (attempts) => [...attempts, input]);
            if (input.senderThreadId !== undefined && (yield* Ref.getAndSet(rejectLead, false))) {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: input.commandId,
                threadId: input.threadId,
                messageId: input.messageId,
                text: input.text,
                attachments: input.attachments,
                dispatchMode: { type: "restart_active", targetRunId: RunId.make("missing-run") },
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              });
            }
            return yield* threads.sendToThread(input);
          }),
      } satisfies ThreadManagement.ThreadManagementServiceShape;

      yield* Effect.gen(function* () {
        const factory = yield* FactoryService.FactoryService;
        yield* factory.drain;
        yield* factory.dispatch(human, create);
        yield* factory.drain;
        const failed = yield* factory.snapshot({});
        const manager = failed.managers[0]!;
        const assignment = failed.assignments[0]!;
        assert.equal(manager.threadStatus, "created");
        assert.equal(manager.launchStatus, "delivered");
        assert.equal(manager.status, "blocked");
        assert.equal(assignment.threadStatus, "created");
        assert.equal(assignment.launchStatus, "pending");
        assert.equal((yield* threads.getThreadProjection(assignment.threadId)).messages.length, 0);
        const rejected = (yield* Ref.get(sends))[1]!;
        const receipt = yield* receipts.getByCommandId(rejected.commandId);
        assert.isTrue(Option.isSome(receipt));
        if (Option.isSome(receipt)) assert.equal(receipt.value.status, "rejected");

        const replacement = yield* factory
          .dispatch(human, {
            type: "manager.retry-onboarding",
            commandId: CommandId.make("replace-after-partial-launch"),
            managerId: manager.id,
            workflow: { ...create.workflow, revision: "different-commit" },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(replacement));
        if (Result.isFailure(replacement)) assert.equal(replacement.failure.code, "invalid-state");

        const retry = {
          type: "manager.retry-onboarding" as const,
          commandId: CommandId.make("retry-rejected-lead"),
          managerId: manager.id,
        };
        const acceptedRetry = yield* factory.dispatch(human, retry);
        yield* factory.drain;
        assert.deepStrictEqual(yield* factory.dispatch(human, retry), acceptedRetry);
        yield* factory.drain;
        const recovered = yield* factory.snapshot({});
        assert.equal(recovered.managers[0]!.id, manager.id);
        assert.equal(recovered.assignments[0]!.id, assignment.id);
        assert.equal(recovered.assignments[0]!.launchStatus, "delivered");
        assert.deepStrictEqual(recovered.assignments[0]!.qualification, qualification);
        assert.equal(yield* Ref.get(qualifications), 1);
        const attempts = yield* Ref.get(sends);
        assert.equal(attempts.filter((attempt) => attempt.threadId === manager.threadId).length, 1);
        assert.equal(attempts.length, 3);
        assert.equal(attempts[2]!.messageId, rejected.messageId);
        assert.notEqual(attempts[2]!.commandId, rejected.commandId);
        const accepted = yield* receipts.getByCommandId(attempts[2]!.commandId);
        assert.isTrue(Option.isSome(accepted));
        if (Option.isSome(accepted)) assert.equal(accepted.value.status, "accepted");
        for (const threadId of [manager.threadId, assignment.threadId]) {
          const projection = yield* threads.getThreadProjection(threadId);
          assert.equal(projection.thread.worktreePath, profile.projectSnapshotPath);
          assert.equal(projection.messages.length, 1);
          assert.equal(projection.runs.length, 1);
        }
      }).pipe(
        Effect.provide(FactoryService.layer),
        Effect.provideService(ThreadManagement.ThreadManagementService, interceptedThreads),
        Effect.provideService(FactoryExecution, {
          qualify: () =>
            Ref.update(qualifications, (count) => count + 1).pipe(Effect.as(qualification)),
          runtimePolicyFor: () => Effect.succeed(profile),
        }),
      );
    }).pipe(Effect.provide(runtime)),
);

it.effect("reconciles an accepted message after losing its factory acknowledgement", () =>
  Effect.gen(function* () {
    yield* recordProject({ projectId, title: "Web", workspaceRoot: "/project" });
    const store = yield* FactoryStore.FactoryStore;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
    const failAcknowledgement = yield* Ref.make(true);
    const sends = yield* Ref.make<ReadonlyArray<ThreadManagement.ThreadManagementSendInput>>([]);
    const qualifications = yield* Ref.make(0);
    const interceptedStore = {
      ...store,
      finishEffect: (input: Parameters<typeof store.finishEffect>[0]) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(failAcknowledgement, false)) {
            return yield* new FactoryError({ code: "persistence" });
          }
          yield* store.finishEffect(input);
        }),
    };
    const execution = {
      qualify: () =>
        Ref.update(qualifications, (count) => count + 1).pipe(Effect.as(qualification)),
      runtimePolicyFor: () => Effect.succeed(profile),
    };
    const interceptedThreads = {
      ...threads,
      sendToThread: (input: ThreadManagement.ThreadManagementSendInput) =>
        Ref.update(sends, (attempts) => [...attempts, input]).pipe(
          Effect.andThen(threads.sendToThread(input)),
        ),
    };
    const first = yield* Effect.gen(function* () {
      const factory = yield* FactoryService.FactoryService;
      yield* factory.drain;
      yield* factory.dispatch(human, create);
      yield* factory.drain;
      const snapshot = yield* factory.snapshot({});
      const manager = snapshot.managers[0]!;
      assert.equal(manager.threadStatus, "created");
      assert.equal(manager.launchStatus, "pending");
      const attempted = (yield* Ref.get(sends))[0]!;
      const receipt = yield* receipts.getByCommandId(attempted.commandId);
      assert.isTrue(Option.isSome(receipt));
      if (Option.isSome(receipt)) assert.equal(receipt.value.status, "accepted");
      const projection = yield* threads.getThreadProjection(manager.threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(
        projection.messages[0]!.id,
        MessageId.make(`factory:${manager.threadId}:initial-message`),
      );
      assert.equal(projection.runs.length, 1);
      assert.equal((yield* store.pending).length, 2);
      return snapshot;
    }).pipe(
      Effect.provide(FactoryService.layer),
      Effect.provideService(FactoryStore.FactoryStore, interceptedStore),
      Effect.provideService(ThreadManagement.ThreadManagementService, interceptedThreads),
      Effect.provideService(FactoryExecution, execution),
    );

    yield* Effect.gen(function* () {
      const factory = yield* FactoryService.FactoryService;
      yield* factory.drain;
      const recovered = yield* factory.snapshot({});
      assert.equal(recovered.managers[0]!.id, first.managers[0]!.id);
      assert.equal(recovered.managers[0]!.launchStatus, "delivered");
      assert.equal(recovered.assignments[0]!.id, first.assignments[0]!.id);
      assert.equal(recovered.assignments[0]!.launchStatus, "delivered");
      assert.deepStrictEqual(recovered.assignments[0]!.qualification, qualification);
      assert.equal(yield* Ref.get(qualifications), 1);
      assert.equal((yield* Ref.get(sends)).length, 2);
      assert.equal((yield* store.pending).length, 0);
      for (const threadId of [
        recovered.managers[0]!.threadId,
        recovered.assignments[0]!.threadId,
      ]) {
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.messages.length, 1);
        assert.equal(projection.runs.length, 1);
      }
    }).pipe(
      Effect.provide(Layer.fresh(FactoryService.layer)),
      Effect.provideService(ThreadManagement.ThreadManagementService, interceptedThreads),
      Effect.provideService(FactoryExecution, execution),
    );
  }).pipe(Effect.provide(runtime)),
);
