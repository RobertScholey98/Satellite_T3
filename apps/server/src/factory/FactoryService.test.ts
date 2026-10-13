import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  FactoryError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as SatelliteTestRuntime from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryStore from "./FactoryStore.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryBoundaryExecutionTestkit from "./FactoryBoundaryExecution.testkit.ts";
import * as FactorySourceTestkit from "./FactorySource.testkit.ts";
import * as FactoryHandoverTestkit from "./FactoryHandover.testkit.ts";
import * as FactoryServiceTestkit from "./FactoryService.testkit.ts";

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
  FactoryBoundaryExecutionTestkit.layerUnavailable,
  FactorySourceTestkit.layerUnused,
  FactoryHandoverTestkit.layerUnused,
  FactoryServiceTestkit.layerTestDependencies,
).pipe(Layer.provideMerge(SatelliteTestRuntime.layer));
const layer = FactoryService.layer.pipe(Layer.provideMerge(runtime));

it.effect("checkpoints deleted ordinary history and still observes later managed guidance", () =>
  Effect.gen(function* () {
    yield* SatelliteTestRuntime.recordProject({
      projectId,
      title: "Project",
      workspaceRoot: "/project",
    });
    const factory = yield* FactoryService.FactoryService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const store = yield* FactoryStore.FactoryStore;
    const deletedId = ThreadId.make("deleted-ordinary");
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("ordinary-create"),
      threadId: deletedId,
      projectId,
      title: "Ordinary",
      modelSelection: create.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* threads.sendToThread({
      projectId,
      threadId: deletedId,
      commandId: CommandId.make("ordinary-send"),
      messageId: MessageId.make("ordinary-message"),
      text: "Read project",
      attachments: [],
      mode: "auto",
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* threads.getThreadProjection(deletedId)).runs[0]!;
    yield* threads.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("ordinary-delete"),
      threadId: deletedId,
    });
    yield* factory.observe({
      sequence: 100,
      commandId: null,
      event: {
        id: EventId.make("historical-terminal"),
        type: "run.updated",
        threadId: deletedId,
        occurredAt: DateTime.makeUnsafe(qualification.checkedAt),
        payload: { ...run, status: "completed" },
      },
    });
    assert.equal(yield* store.observationCursor, 100);
    yield* factory.dispatch(human, create);
    yield* factory.drain;
    const assignment = (yield* store.snapshot).assignments[0]!;
    yield* threads.sendToThread({
      projectId,
      threadId: assignment.threadId,
      commandId: CommandId.make("human-guidance"),
      messageId: MessageId.make("human-guidance"),
      text: "Consider the existing pattern",
      attachments: [],
      mode: "auto",
      createdBy: "user",
      creationSource: "web",
    });
    const message = (yield* threads.getThreadProjection(assignment.threadId)).messages.find(
      (entry) => entry.id === "human-guidance",
    )!;
    yield* factory.observe({
      sequence: 101,
      commandId: null,
      event: {
        id: EventId.make("guidance-event"),
        type: "message.updated",
        threadId: assignment.threadId,
        occurredAt: DateTime.makeUnsafe(qualification.checkedAt),
        payload: message,
      },
    });
    assert.equal(yield* store.observationCursor, 101);
    assert.equal((yield* store.snapshot).guidance[0]!.messageId, message.id);
  }).pipe(
    Effect.provide(layer),
    Effect.provide(
      Layer.mock(FactoryExecution.FactoryExecution)({
        qualify: () => Effect.succeed(qualification),
        assertSelectionFor: () => Effect.void,
        assertDelegationFor: () => Effect.void,
        runtimePolicyFor: () => Effect.succeed(profile),
      }),
    ),
  ),
);

it.effect("creates ordinary durable threads once and records the owning lead's report", () =>
  Effect.gen(function* () {
    const qualifications = yield* Ref.make(0);
    const execution = Layer.succeed(FactoryExecution.FactoryExecution, {
      qualify: () =>
        Ref.update(qualifications, (count) => count + 1).pipe(Effect.as(qualification)),
      assertSelectionFor: () => Effect.void,
      assertDelegationFor: () => Effect.void,
      runtimePolicyFor: () => Effect.succeed(profile),
    });
    yield* Effect.gen(function* () {
      yield* SatelliteTestRuntime.recordProject({
        projectId,
        title: "Web",
        workspaceRoot: "/project",
      });
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

it.effect("refuses the first manager while the beta is off and never strands existing ones", () =>
  Effect.gen(function* () {
    const secondProjectId = ProjectId.make("factory-service-second-project");
    yield* SatelliteTestRuntime.recordProject({
      projectId,
      title: "Web",
      workspaceRoot: "/project",
    });
    yield* SatelliteTestRuntime.recordProject({
      projectId: secondProjectId,
      title: "Api",
      workspaceRoot: "/api",
    });
    const factory = yield* FactoryService.FactoryService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const refused = yield* factory.dispatch(human, create).pipe(Effect.result);
    assert.isTrue(Result.isFailure(refused));
    if (Result.isFailure(refused))
      assert.equal(
        refused.failure.message,
        "Engineering managers are off. Turn on Engineering managers in Settings → General.",
      );
    assert.deepEqual((yield* factory.snapshot({})).managers, []);

    yield* settings.updateSettings({ engineeringManagersEnabled: true });
    yield* factory.dispatch(human, create);
    yield* settings.updateSettings({ engineeringManagersEnabled: false });
    yield* factory.dispatch(human, {
      ...create,
      commandId: CommandId.make("factory-service-second-create"),
      projectId: secondProjectId,
    });
    assert.sameMembers(
      (yield* factory.snapshot({})).managers.map((manager) => manager.projectId),
      [projectId, secondProjectId],
    );
  }).pipe(
    Effect.provide(
      FactoryService.layer.pipe(
        Layer.provideMerge(
          ServerSettings.layerTest({ engineeringManagersEnabled: false }).pipe(Layer.orDie),
        ),
        Layer.provideMerge(runtime),
      ),
    ),
    Effect.provideService(FactoryExecution.FactoryExecution, {
      qualify: () =>
        Effect.succeed({ status: "unavailable", reason: "Start the local Docker engine." }),
      assertSelectionFor: () => Effect.void,
      assertDelegationFor: () => Effect.void,
      runtimePolicyFor: () => Effect.die("An unavailable assignment must not launch."),
    }),
  ),
);

it.effect("refuses a model policy or system manager on a provider it cannot confine", () =>
  Effect.gen(function* () {
    const factory = yield* FactoryService.FactoryService;
    const grok = { instanceId: ProviderInstanceId.make("grok"), model: "grok-4" };
    const claude = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    };
    const refusals: Array<string> = [];
    for (const command of [
      {
        type: "models.defaults.configure",
        commandId: CommandId.make("defaults-grok"),
        policy: { approvedModels: [claude, grok], preferences: [] },
      },
      {
        type: "manager.models.configure",
        commandId: CommandId.make("manager-grok"),
        managerId: ThreadId.make("manager"),
        overrides: {
          preferences: [{ role: "worker", complexity: "small", selection: grok }],
        },
      },
      {
        type: "system.create",
        commandId: CommandId.make("system-grok"),
        workspaceProjectId: projectId,
        modelSelection: grok,
        workflow: create.workflow,
      },
      {
        type: "system.retry",
        commandId: CommandId.make("system-retry-grok"),
        managerId: ThreadId.make("system"),
        modelSelection: grok,
      },
    ] as const)
      refusals.push((yield* factory.dispatch(human, command).pipe(Effect.flip)).message);
    assert.deepEqual(
      refusals,
      Array.from(
        { length: 4 },
        () => "Managed execution requires a provider with a confined runtime (Codex or Claude).",
      ),
    );
    yield* factory.dispatch(human, {
      type: "models.defaults.configure",
      commandId: CommandId.make("defaults-claude"),
      policy: { approvedModels: [claude], preferences: [] },
    });
    assert.deepEqual((yield* factory.snapshot({})).modelDefaults?.approvedModels, [claude]);
  }).pipe(
    Effect.provide(
      FactoryService.layer.pipe(
        Layer.provideMerge(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: (instanceId) =>
              Effect.succeed({
                driverKind: ProviderDriverKind.make(instanceId === "grok" ? "grok" : "claudeAgent"),
              } as ProviderInstance),
          }),
        ),
        Layer.provideMerge(runtime),
      ),
    ),
    Effect.provideService(FactoryExecution.FactoryExecution, {
      qualify: () => Effect.die("A refused policy must not qualify."),
      assertSelectionFor: () => Effect.void,
      assertDelegationFor: () => Effect.void,
      runtimePolicyFor: () => Effect.die("A refused policy must not launch."),
    }),
  ),
);

it.effect("persists an actionable wait without launching when confinement is unavailable", () =>
  Effect.gen(function* () {
    yield* SatelliteTestRuntime.recordProject({
      projectId,
      title: "Web",
      workspaceRoot: "/project",
    });
    const factory = yield* FactoryService.FactoryService;
    yield* factory.dispatch(human, create);
    yield* factory.drain;
    const snapshot = yield* factory.snapshot({});
    assert.equal(snapshot.managers[0]!.threadStatus, "pending");
    assert.equal(snapshot.assignments[0]!.status, "waiting");
    assert.equal(snapshot.managers[0]!.wait?.reason, "Start the local Docker engine.");
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(FactoryExecution.FactoryExecution, {
      qualify: () =>
        Effect.succeed({ status: "unavailable", reason: "Start the local Docker engine." }),
      assertSelectionFor: () => Effect.void,
      assertDelegationFor: () => Effect.void,
      runtimePolicyFor: () => Effect.die("An unavailable assignment must not launch."),
    }),
  ),
);

it.effect("a failed launch remains recoverable and its receipt does not claim success", () =>
  Effect.gen(function* () {
    const available = yield* Ref.make(false);
    yield* Effect.gen(function* () {
      yield* SatelliteTestRuntime.recordProject({
        projectId,
        title: "API",
        workspaceRoot: "/project",
      });
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
      Effect.provideService(FactoryExecution.FactoryExecution, {
        qualify: () => Effect.succeed(qualification),
        assertSelectionFor: () => Effect.void,
        assertDelegationFor: () => Effect.void,
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
      yield* SatelliteTestRuntime.recordProject({
        projectId,
        title: "Web",
        workspaceRoot: "/project",
      });
      const threads = yield* ThreadManagement.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
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
        Effect.provideService(FactoryExecution.FactoryExecution, {
          qualify: () =>
            Ref.update(qualifications, (count) => count + 1).pipe(Effect.as(qualification)),
          assertSelectionFor: () => Effect.void,
          assertDelegationFor: () => Effect.void,
          runtimePolicyFor: () => Effect.succeed(profile),
        }),
      );
    }).pipe(Effect.provide(runtime)),
);

it.effect("reconciles an accepted message after losing its factory acknowledgement", () =>
  Effect.gen(function* () {
    yield* SatelliteTestRuntime.recordProject({
      projectId,
      title: "Web",
      workspaceRoot: "/project",
    });
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
      assertSelectionFor: () => Effect.void,
      assertDelegationFor: () => Effect.void,
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
      Effect.provideService(FactoryExecution.FactoryExecution, execution),
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
      Effect.provideService(FactoryExecution.FactoryExecution, execution),
    );
  }).pipe(Effect.provide(runtime)),
);
