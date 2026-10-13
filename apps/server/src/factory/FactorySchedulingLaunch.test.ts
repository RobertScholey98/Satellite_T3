import { assert, it } from "@effect/vitest";
import { CommandId, EnvironmentId, FactoryError, FactorySnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SatelliteTestRuntime from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import { deliveryFixture, deliveryIds, deliverySelection } from "./FactoryDelivery.testkit.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryHandover from "./FactoryHandover.ts";
import * as FactorySchedulingEffects from "./FactorySchedulingEffects.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySource from "./FactorySource.ts";
import * as FactoryStore from "./FactoryStore.ts";
import * as FactoryServiceTestkit from "./FactoryService.testkit.ts";

const runtime = Layer.mergeAll(FactoryStore.layer, ThreadManagement.layer).pipe(
  Layer.provideMerge(SatelliteTestRuntime.layer),
);
const human = { kind: "human" } as const;
const reason = "The ticket is no longer in the configured Ready column.";
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));

const scenario = (pauseBeforeRestoring: boolean) =>
  Effect.gen(function* () {
    let allowed = false;
    let wake = Effect.die("Scheduling watch was not installed.") as Effect.Effect<void>;
    const base = deliveryFixture();
    const assignment = {
      ...base.assignments[0]!,
      status: "waiting" as const,
      threadStatus: "pending" as const,
      launchStatus: "pending" as const,
      modelChoice: {
        source: "explicit" as const,
        selection: deliverySelection,
        reason: "Approved implementation model",
      },
      wait: { kind: "execution-boundary" as const, reason: "Awaiting launch" },
      scheduling: {
        candidateId: "candidate",
        authority: {
          kind: "tracker-ready" as const,
          boardId: "board",
          itemId: "item",
          observedAt: base.assignments[0]!.createdAt,
        },
        issueAttempt: {
          attemptId: "attempt",
          reservationId: "reservation",
          sourceEnvironmentId: EnvironmentId.make("environment"),
          destinationEnvironmentId: EnvironmentId.make("environment"),
          sourceProjectId: deliveryIds.project,
          boardId: "board",
          sourceGeneration: 0,
          issue: {
            hostKind: "github" as const,
            host: "github.com",
            repository: "owner/repo",
            id: "I_1",
            number: 1,
            url: "https://github.com/owner/repo/issues/1",
          },
        },
      },
    };
    yield* SatelliteTestRuntime.recordProject({
      projectId: deliveryIds.project,
      title: "Scheduling launch",
      workspaceRoot: "/project",
    });
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-manager"),
      threadId: deliveryIds.manager,
      projectId: deliveryIds.project,
      title: "Manager",
      modelSelection: deliverySelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const sql = yield* SqlClient.SqlClient;
    const payload = encodeSnapshot({
      ...base,
      assignments: [assignment],
    });
    yield* sql`INSERT INTO factory_state (id, revision, payload_json) VALUES (1, 0, ${payload})`;
    yield* Effect.gen(function* () {
      const factory = yield* FactoryService.FactoryService;
      const store = yield* FactoryStore.FactoryStore;
      yield* factory.drain;
      yield* factory.dispatch(human, {
        type: "assignment.retry",
        commandId: CommandId.make("retry"),
        assignmentId: assignment.id,
      });
      yield* factory.drain;
      const held = yield* store.snapshot;
      assert.equal(held.assignments[0]!.status, "waiting");
      assert.deepStrictEqual(held.assignments[0]!.wait, { kind: "execution-boundary", reason });
      const pending = (yield* store.pending).filter(
        (entry) => entry.intent.type === "thread.launch",
      );
      assert.equal(pending.length, 1);
      const assertUnstarted = Effect.gen(function* () {
        const projection = yield* threads.getThreadProjection(assignment.threadId);
        assert.equal(projection.messages.length, 0);
        assert.equal(projection.runs.length, 0);
        assert.deepStrictEqual(
          (yield* store.pending)
            .filter((entry) => entry.intent.type === "thread.launch")
            .map((entry) => entry.id),
          pending.map((entry) => entry.id),
        );
      });
      yield* assertUnstarted;
      yield* wake;
      yield* factory.drain;
      yield* assertUnstarted;
      assert.equal((yield* store.snapshot).revision, held.revision);
      if (pauseBeforeRestoring) {
        yield* factory.dispatch(human, {
          type: "project.pause",
          commandId: CommandId.make("pause"),
          projectId: deliveryIds.project,
        });
        yield* factory.drain;
      }
      allowed = true;
      yield* wake;
      yield* factory.drain;
      if (pauseBeforeRestoring) {
        yield* assertUnstarted;
        yield* factory.dispatch(human, {
          type: "project.resume",
          commandId: CommandId.make("resume"),
          projectId: deliveryIds.project,
        });
        yield* factory.drain;
      }
      const launched = (yield* store.snapshot).assignments[0]!;
      assert.equal(launched.threadId, assignment.threadId);
      assert.equal(launched.status, "running");
      assert.equal(launched.launchStatus, "delivered");
      assert.equal(launched.wait, null);
      assert.equal(
        (yield* store.pending).filter((entry) => entry.intent.type === "thread.launch").length,
        0,
      );
      yield* wake;
      yield* factory.drain;
      const projection = yield* threads.getThreadProjection(assignment.threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.runs.length, 1);
      assert.equal(projection.messages[0]!.id, `factory:${assignment.threadId}:initial-message`);
    }).pipe(
      Effect.provide(
        FactoryService.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              FactoryServiceTestkit.layerTestDependencies,
              Layer.mock(FactoryExecution.FactoryExecution)({
                assertSelectionFor: () => Effect.void,
                assertDelegationFor: () => Effect.void,
                runtimePolicyFor: () =>
                  Effect.succeed({
                    boundaryId: "profile",
                    dockerContext: "default",
                    imageId: "image",
                    projectSnapshotPath: "/confined/project",
                    workflowSnapshotPath: "/confined/workflow",
                    runtimePath: "/confined/runtime",
                  }),
              }),
              Layer.mock(FactoryBoundaryExecution.FactoryBoundaryExecution)({
                suspend: () => Effect.void,
                resume: () => Effect.void,
                stop: () => Effect.void,
              }),
              Layer.mock(FactoryHandover.FactoryHandover)({ stopTeam: () => Effect.void }),
              Layer.mock(FactorySource.FactorySource)({}),
              Layer.mock(FactorySchedulingEffects.FactorySchedulingEffects)({
                context: () => Effect.succeed({}),
                reconcile: Effect.void,
                handle: () => Effect.void,
                beforeLaunch: () =>
                  Effect.suspend(() =>
                    allowed
                      ? Effect.void
                      : Effect.fail(
                          new FactoryError({ code: "execution-unavailable", detail: reason }),
                        ),
                  ),
                watch: (callback) =>
                  Effect.sync(() => {
                    wake = callback;
                  }),
              }),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(runtime), Effect.scoped);

it.effect(
  "retains a denied tracker launch and automatically delivers the same team once after readiness returns",
  () => scenario(false),
);
it.effect("keeps a restored tracker launch stopped until the human resumes its project", () =>
  scenario(true),
);
