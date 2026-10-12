import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryBoundaryId,
  FactoryError,
  FactorySourceId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryAssignment,
  type FactoryBoundary,
  type FactoryStartingSource,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  layer as SatelliteTestLayer,
  recordProject,
} from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
import { FactoryExecution } from "./FactoryExecution.ts";
import { FactoryHandover } from "./FactoryHandover.ts";
import * as FactoryService from "./FactoryService.ts";
import { FactorySource } from "./FactorySource.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { layerTestDependencies } from "./FactoryService.testkit.ts";

const projectId = ProjectId.make("commission-web");
const human = { kind: "human" } as const;
const now = "2026-10-10T12:00:00.000Z";
const model = { instanceId: ProviderInstanceId.make("codex"), model: "approved-model" };
const workflow = { repositoryRoot: "/owned-workflow", revision: "approved-workflow" };
const configuration = {
  protectedPaths: ["AGENTS.md"],
  writablePaths: ["src/app.ts"],
  creatableDirectories: ["src/features"],
  gates: [],
};
const boundary: FactoryBoundary = {
  ...configuration,
  id: FactoryBoundaryId.make("web-boundary"),
  projectId,
  sourceRevision: "onboarding-source",
  workflow,
  profileId: "onboarding-profile",
  approvedAt: now,
};
const source = (threadId?: ThreadId): FactoryStartingSource => ({
  id: FactorySourceId.make(`source:${threadId ?? "new"}`),
  projectId,
  revision: "current-source",
  sourceDigest: "captured-digest",
  branch: "feature/existing",
  origin: threadId === undefined ? "project" : "handover",
  ...(threadId === undefined ? {} : { threadId }),
  capturedAt: now,
  fileCount: 2,
  stagedPaths: [],
  unstagedPaths: [],
  untrackedPaths: [],
  deletedPaths: [],
  excludedPaths: [],
});
const work = (managerId: ThreadId, key = "commission") => ({
  type: "assignment.commission" as const,
  commandId: CommandId.make(key),
  managerId,
  title: "Improve the app",
  scope: {
    description: "Improve the existing app module",
    completionCondition: "Behavior verified and PR merged",
    requiresPullRequest: true,
  },
  complexity: "standard" as const,
  kind: "implementation" as const,
  sourcePaths: ["src/app.ts"],
  creatableDirectories: ["src/features"],
});
const runtime = Layer.mergeAll(FactoryStore.layer, ThreadManagement.layer).pipe(
  Layer.provideMerge(SatelliteTestLayer),
);
const execution = Layer.succeed(FactoryExecution, {
  qualify: () =>
    Effect.succeed({ status: "qualified", profileId: "onboarding-profile", checkedAt: now }),
  runtimePolicyFor: () =>
    Effect.succeed({
      boundaryId: "onboarding-profile",
      dockerContext: "default",
      imageId: "image",
      projectSnapshotPath: "/confined/project",
      workflowSnapshotPath: "/confined/workflow",
      runtimePath: "/confined/runtime",
    }),
  assertSelectionFor: () => Effect.void,
  assertDelegationFor: () => Effect.void,
});
const start = Effect.gen(function* () {
  yield* recordProject({ projectId, title: "Web", workspaceRoot: "/project" });
  const factory = yield* FactoryService.FactoryService;
  yield* factory.dispatch(human, {
    type: "manager.create",
    commandId: CommandId.make("manager"),
    projectId,
    modelSelection: model,
    workflow,
  });
  yield* factory.drain;
  const first = yield* factory.snapshot({});
  const manager = first.managers[0]!;
  yield* factory.dispatch(
    { kind: "thread", threadId: first.assignments[0]!.threadId },
    {
      type: "onboarding.report",
      commandId: CommandId.make("report"),
      assignmentId: first.assignments[0]!.id,
      report: {
        summary: "Discovered controls",
        instructions: [],
        checks: [],
        tracker: { description: "Repository issues", evidence: [] },
        verificationTools: [],
        protectedControls: [],
        unresolvedDecisions: [],
      },
    },
  );
  yield* factory.dispatch(human, {
    type: "manager.approve-onboarding",
    commandId: CommandId.make("approve"),
    managerId: manager.id,
    configuration,
  });
  return { factory, manager };
});

const scenario = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  options?: {
    readonly capture?: FactorySource["Service"]["capture"];
    readonly prepare?: FactoryBoundaryExecution["Service"]["prepare"];
    readonly stop?: FactoryHandover["Service"]["stop"];
    readonly revoke?: FactoryBoundaryExecution["Service"]["stop"];
    readonly mutate?: FactoryBoundaryExecution["Service"]["mutate"];
  },
) =>
  body.pipe(
    Effect.provide(
      FactoryService.layer.pipe(
        Layer.provideMerge(runtime),
        Layer.provide(
          Layer.mergeAll(
            layerTestDependencies,
            execution,
            Layer.mock(FactoryBoundaryExecution)({
              approve: () => Effect.succeed(boundary),
              prepare:
                options?.prepare ??
                (() =>
                  Effect.succeed({
                    status: "qualified",
                    profileId: "implementation-profile",
                    checkedAt: now,
                  })),
              stop: options?.revoke ?? (() => Effect.void),
              mutate: options?.mutate ?? (() => Effect.void),
            }),
            Layer.mock(FactorySource)({
              capture: options?.capture ?? ((input) => Effect.succeed(source(input.threadId))),
              validateCurrent: () => Effect.void,
            }),
            Layer.mock(FactoryHandover)({ stop: options?.stop ?? (() => Effect.void) }),
          ),
        ),
      ),
    ),
  );

it.effect("rejects a concurrent reused command before it can mutate another assignment", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const mutations = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* scenario(
      Effect.gen(function* () {
        const { factory, manager } = yield* start;
        const first = yield* factory.dispatch(human, work(manager.id, "first"));
        const second = yield* factory.dispatch(human, work(manager.id, "second"));
        yield* factory.drain;
        const mutation = (assignmentId: NonNullable<typeof first.assignmentId>) => ({
          type: "assignment.file.mutate" as const,
          commandId: CommandId.make("shared-mutation"),
          assignmentId,
          expectedEpoch: 0,
          operation: {
            kind: "create" as const,
            path: "src/features/new.ts",
            content: "export {};",
          },
        });
        const firstFiber = yield* factory
          .dispatch(human, mutation(first.assignmentId!))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const secondFiber = yield* factory
          .dispatch(human, mutation(second.assignmentId!))
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(firstFiber);
        const rejected = yield* Fiber.join(secondFiber);
        assert.isTrue(Result.isFailure(rejected));
        if (Result.isFailure(rejected)) assert.equal(rejected.failure.code, "command-conflict");
        assert.deepStrictEqual(yield* Ref.get(mutations), [first.assignmentId!]);
      }),
      {
        mutate: ({ assignmentId }) =>
          Ref.update(mutations, (ids) => [...ids, assignmentId]).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(finish)),
          ),
      },
    );
  }),
);

it.effect(
  "commissions one full thread with a pinned source, workflow, model decision and repeatable receipt",
  () =>
    scenario(
      Effect.gen(function* () {
        const { factory, manager } = yield* start;
        const command = work(manager.id);
        const accepted = yield* factory.dispatch(human, command);
        assert.deepStrictEqual(yield* factory.dispatch(human, command), accepted);
        yield* factory.drain;
        const snapshot = yield* factory.snapshot({});
        const assignment = snapshot.assignments.find(
          (entry) => entry.id === accepted.assignmentId,
        )!;
        assert.equal(snapshot.assignments.length, 2);
        assert.equal(snapshot.managers[0]!.status, "active");
        assert.equal(assignment.status, "running");
        assert.equal(assignment.preparation, "ready");
        assert.equal(assignment.startingSource?.revision, "current-source");
        assert.equal(assignment.workflow.revision, workflow.revision);
        assert.deepStrictEqual(assignment.modelSelection, model);
        assert.equal(assignment.modelChoice?.source, "approved-fallback");
        assert.deepStrictEqual(assignment.grant?.sourcePaths, ["src/app.ts"]);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const lead = yield* threads.getThreadProjection(assignment.threadId);
        assert.equal(lead.thread.title, command.title);
        assert.equal(lead.thread.lineage.parentThreadId, null);
        assert.equal(lead.messages.length, 1);
        assert.include(lead.messages[0]!.text, "You own implementation");
        assert.include(lead.messages[0]!.text, "delegate_task");
        assert.equal((yield* (yield* FactoryStore.FactoryStore).pending).length, 0);
      }),
    ),
);

it.effect(
  "keeps failed preparation visible and retries the same captured work without blocking its manager",
  () =>
    Effect.gen(function* () {
      const captures = yield* Ref.make(0);
      const attempts = yield* Ref.make(0);
      yield* scenario(
        Effect.gen(function* () {
          const { factory, manager } = yield* start;
          const accepted = yield* factory.dispatch(human, work(manager.id));
          yield* factory.drain;
          const first = yield* factory.snapshot({});
          const assignment = first.assignments.find((entry) => entry.id === accepted.assignmentId)!;
          assert.equal(assignment.status, "waiting");
          assert.equal(assignment.wait?.reason, "Image temporarily unavailable");
          assert.equal(first.managers[0]!.status, "active");
          assert.equal(assignment.threadStatus, "pending");
          yield* factory.dispatch(human, {
            type: "assignment.retry",
            commandId: CommandId.make("retry"),
            assignmentId: assignment.id,
          });
          yield* factory.drain;
          const final = (yield* factory.snapshot({})).assignments.find(
            (entry) => entry.id === assignment.id,
          )!;
          assert.equal(final.status, "running");
          assert.equal(final.threadId, assignment.threadId);
          assert.deepStrictEqual(final.startingSource, assignment.startingSource);
          assert.equal(yield* Ref.get(captures), 1);
          assert.equal(yield* Ref.get(attempts), 2);
        }),
        {
          capture: (input) =>
            Ref.update(captures, (count) => count + 1).pipe(Effect.as(source(input.threadId))),
          prepare: () =>
            Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 0
                  ? Effect.fail(
                      new FactoryError({
                        code: "execution-unavailable",
                        detail: "Image temporarily unavailable",
                      }),
                    )
                  : Effect.succeed({
                      status: "qualified",
                      profileId: "implementation-profile",
                      checkedAt: now,
                    }),
              ),
            ),
        },
      );
    }),
);

it.effect("accepts manager commissioning only against an actual direct human request", () =>
  scenario(
    Effect.gen(function* () {
      const { factory, manager } = yield* start;
      const actor = { kind: "thread", threadId: manager.id } as const;
      const command = work(manager.id);
      assert.isTrue(Result.isFailure(yield* factory.dispatch(actor, command).pipe(Effect.result)));
      const threads = yield* ThreadManagement.ThreadManagementService;
      const request = MessageId.make("human-request");
      yield* threads.sendToThread({
        projectId,
        threadId: manager.id,
        commandId: CommandId.make("request"),
        messageId: request,
        text: "Improve the app module and bring me the PR.",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      const accepted = yield* factory.dispatch(actor, command);
      yield* factory.drain;
      const assignment = (yield* factory.snapshot({})).assignments.find(
        (entry) => entry.id === accepted.assignmentId,
      )!;
      assert.equal(assignment.authorization?.kind, "manager");
      if (assignment.authorization?.kind === "manager")
        assert.equal(assignment.authorization.messageId, request);
      const forged = yield* factory
        .dispatch({ kind: "thread", threadId: assignment.threadId }, work(manager.id, "forged"))
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(forged));
    }),
  ),
);

it.effect("consumes a direct human request on its first commission", () =>
  scenario(
    Effect.gen(function* () {
      const { factory, manager } = yield* start;
      const actor = { kind: "thread", threadId: manager.id } as const;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const ask = (key: string) =>
        threads.sendToThread({
          projectId,
          threadId: manager.id,
          commandId: CommandId.make(`ask-${key}`),
          messageId: MessageId.make(`request-${key}`),
          text: "Improve the app module.",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
      yield* ask("first");
      yield* factory.dispatch(actor, work(manager.id, "first"));
      const repeated = yield* factory.dispatch(actor, work(manager.id, "second")).pipe(Effect.flip);
      assert.equal(repeated.code, "permission-denied");
      const named = yield* factory
        .dispatch(actor, {
          ...work(manager.id, "named"),
          authorizationMessageId: MessageId.make("request-first"),
        })
        .pipe(Effect.flip);
      assert.equal(named.code, "permission-denied");
      yield* ask("second");
      const accepted = yield* factory.dispatch(actor, work(manager.id, "second"));
      yield* factory.drain;
      const assignment = (yield* factory.snapshot({})).assignments.find(
        (entry) => entry.id === accepted.assignmentId,
      );
      assert.deepEqual(
        assignment?.authorization?.kind === "manager"
          ? assignment.authorization.messageId
          : undefined,
        MessageId.make("request-second"),
      );
    }),
  ),
);

it.effect("keeps a policy-reduction wait when a late preparation failure arrives", () =>
  Effect.gen(function* () {
    const preparing = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    yield* scenario(
      Effect.gen(function* () {
        const { factory, manager } = yield* start;
        const other = { ...model, model: "approved-reviewer" };
        yield* factory.dispatch(human, {
          type: "models.defaults.configure",
          commandId: CommandId.make("pool"),
          policy: { approvedModels: [model, other], preferences: [] },
        });
        const accepted = yield* factory.dispatch(human, work(manager.id));
        yield* Deferred.await(preparing);
        yield* factory.dispatch(human, {
          type: "models.defaults.configure",
          commandId: CommandId.make("reduce"),
          policy: { approvedModels: [model], preferences: [] },
        });
        yield* Deferred.succeed(finish, undefined);
        yield* factory.drain;
        const assignment = (yield* factory.snapshot({})).assignments.find(
          (entry) => entry.id === accepted.assignmentId,
        )!;
        assert.equal(assignment.wait?.kind, "authority");
        assert.equal(assignment.grant?.epoch, 1);
        assert.equal(assignment.threadStatus, "pending");
        assert.isTrue(
          Result.isFailure(
            yield* factory
              .dispatch(human, {
                type: "assignment.retry",
                commandId: CommandId.make("retry"),
                assignmentId: assignment.id,
              })
              .pipe(Effect.result),
          ),
        );
        assert.equal((yield* (yield* FactoryStore.FactoryStore).pending).length, 0);
      }),
      {
        prepare: () =>
          Deferred.succeed(preparing, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.andThen(
              Effect.fail(
                new FactoryError({ code: "execution-unavailable", detail: "Late failure" }),
              ),
            ),
          ),
      },
    );
  }),
);

it.effect(
  "stops active execution when an approved model is removed and does not restore its pinned grant on a later increase",
  () =>
    Effect.gen(function* () {
      const stops = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* scenario(
        Effect.gen(function* () {
          const { factory, manager } = yield* start;
          const other = { ...model, model: "approved-reviewer" };
          yield* factory.dispatch(human, {
            type: "models.defaults.configure",
            commandId: CommandId.make("pool"),
            policy: { approvedModels: [model, other], preferences: [] },
          });
          const accepted = yield* factory.dispatch(human, work(manager.id));
          yield* factory.drain;
          yield* factory.dispatch(human, {
            type: "models.defaults.configure",
            commandId: CommandId.make("reduce"),
            policy: { approvedModels: [model], preferences: [] },
          });
          const reduced = (yield* factory.snapshot({})).assignments.find(
            (entry) => entry.id === accepted.assignmentId,
          )!;
          assert.equal(reduced.status, "waiting");
          assert.equal(reduced.wait?.kind, "authority");
          assert.equal(reduced.grant?.epoch, 1);
          assert.deepStrictEqual(yield* Ref.get(stops), [reduced.id]);
          yield* factory.dispatch(human, {
            type: "models.defaults.configure",
            commandId: CommandId.make("increase"),
            policy: { approvedModels: [model, other], preferences: [] },
          });
          const final = (yield* factory.snapshot({})).assignments.find(
            (entry) => entry.id === reduced.id,
          )!;
          assert.deepStrictEqual(final.modelPolicy?.approvedModels, [model]);
          assert.equal(final.grant?.epoch, 1);
          assert.deepStrictEqual(final.wait, reduced.wait);
        }),
        { revoke: (id) => Ref.update(stops, (previous) => [...previous, id]) },
      );
    }),
);

it.effect(
  "reserves handover, waits for actual stop, then preserves its existing thread identity and metadata",
  () =>
    Effect.gen(function* () {
      const stopping = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const captures = yield* Ref.make(0);
      const existingId = ThreadId.make("existing-thread");
      yield* scenario(
        Effect.gen(function* () {
          const { factory, manager } = yield* start;
          const threads = yield* ThreadManagement.ThreadManagementService;
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make("existing"),
            threadId: existingId,
            projectId,
            title: "Existing feature",
            modelSelection: model,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: "feature/existing",
            worktreePath: "/original/worktree",
            createdBy: "user",
            creationSource: "web",
          });
          const { type: _type, ...request } = work(manager.id);
          const accepted = yield* factory.dispatch(human, {
            ...request,
            type: "assignment.handover",
            threadId: existingId,
          });
          yield* Deferred.await(stopping);
          assert.equal(yield* Ref.get(captures), 0);
          let assignment: FactoryAssignment = (yield* factory.snapshot({})).assignments.find(
            (entry) => entry.id === accepted.assignmentId,
          )!;
          assert.equal(assignment.preparation, "stopping");
          assert.equal(assignment.qualification.status, "unavailable");
          yield* Deferred.succeed(stopped, undefined);
          yield* factory.drain;
          assignment = (yield* factory.snapshot({})).assignments.find(
            (entry) => entry.id === assignment.id,
          )!;
          assert.equal(assignment.status, "running");
          assert.equal(assignment.threadId, existingId);
          assert.equal(assignment.startingSource?.threadId, existingId);
          const thread = yield* threads.getThreadProjection(existingId);
          assert.equal(thread.thread.title, "Existing feature");
          assert.equal(thread.thread.branch, "feature/existing");
          assert.equal(thread.thread.worktreePath, "/original/worktree");
          assert.equal(yield* Ref.get(captures), 1);
        }),
        {
          stop: () =>
            Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Deferred.await(stopped))),
          capture: (input) =>
            Ref.update(captures, (count) => count + 1).pipe(Effect.as(source(input.threadId))),
        },
      );
    }),
);
