import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, FactorySnapshot, ThreadId, type FactoryCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Boundaries from "./FactoryBoundaryExecution.ts";
import * as Execution from "./FactoryExecution.ts";
import * as Handover from "./FactoryHandover.ts";
import * as Workflows from "./FactoryWorkflowEffects.ts";
import * as Store from "./FactoryStore.ts";
import {
  deliveryFixture,
  deliveryIds,
  deliveryNow,
  deliverySelection,
} from "./FactoryDelivery.testkit.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const systemId = ThreadId.make("system-manager");
const base = Layer.mergeAll(Store.layer, Threads.layer).pipe(
  Layer.provideMerge(Satellite.layer),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.fn(function* () {
  const store = yield* Store.FactoryStore;
  const threads = yield* Threads.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  yield* Satellite.recordProject({
    projectId: deliveryIds.project,
    title: "Workflow effects",
    workspaceRoot: root,
  });
  const original = deliveryFixture();
  const seed: FactorySnapshot = {
    ...original,
    managers: [
      ...original.managers,
      {
        id: systemId,
        threadId: systemId,
        role: "system",
        projectId: null,
        workspaceProjectId: deliveryIds.project,
        name: "System",
        modelSelection: deliverySelection,
        workflow: original.managers[0]!.workflow,
        qualification: { status: "qualified", profileId: "system-profile", checkedAt: deliveryNow },
        overrides: {},
        status: "active",
        threadStatus: "created",
        launchStatus: "delivered",
        wait: null,
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
    sharedWorks: [
      {
        id: "shared-work",
        managerId: systemId,
        createdAt: deliveryNow,
        notification: null,
        lifecycle: { phase: "proposed" },
        plan: {
          proposalId: "proposal",
          proposalRevision: "v1",
          repositoryId: "owned-library",
          work: {
            title: "Clarify owned instructions",
            kind: "rule-change",
            complexity: "standard",
            sourcePaths: [],
            creatableDirectories: [],
            controlPaths: ["skills/example/SKILL.md"],
            scope: {
              description: "Clarify evidence guidance",
              completionCondition: "Reviewed PR merged",
              requiresPullRequest: true,
            },
          },
          expectedBenefit: "Fewer repeated corrections",
          assessmentApproach: "Observe later retros",
          changesSkills: true,
          weakensRules: false,
        },
      },
    ],
    assignments: original.assignments.map((assignment) => ({
      ...assignment,
      status: "waiting",
      wait: { kind: "human-decision", reason: "Review the existing PR" },
    })),
    improvementProposals: [
      {
        id: "proposal",
        revision: "v1",
        investigationId: "investigation",
        content: {
          problem: "Repeated corrections",
          scope: { kind: "workflow", components: ["skills"] },
          exclusions: "Application code",
          expectedBenefit: "Fewer corrections",
          tradeoffs: "Unknown",
          uncertainty: "Untested",
          requestedDecision: "Adopt",
          assessmentApproach: null,
        },
        phase: "decided",
        createdAt: deliveryNow,
        submittedAt: deliveryNow,
      },
    ],
    improvementDecisions: [
      {
        proposalId: "proposal",
        revision: "v1",
        outcome: "accepted",
        reason: "Human review",
        commandId: CommandId.make("approve"),
        decidedAt: deliveryNow,
      },
    ],
  };
  yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES(1,${seed.revision},${encode(seed)})`;
  for (const threadId of [deliveryIds.manager, deliveryIds.lead, systemId])
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: deliveryIds.project,
      title: threadId,
      modelSelection: deliverySelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: root,
      createdBy: "system",
      creationSource: "server",
    });
  const calls: string[] = [];
  let loseAck = false;
  let failSend = false;
  const dependencies = Layer.mergeAll(
    Access.layer,
    Layer.mock(Execution.FactoryExecution)({
      runtimePolicyFor: () =>
        Effect.succeed({
          boundaryId: "fresh-profile",
          dockerContext: "fixture",
          imageId: "fixture",
          projectSnapshotPath: root,
          workflowSnapshotPath: root,
          runtimePath: root,
        }),
      assertSelectionFor: () => Effect.void,
    }),
    Layer.mock(Handover.FactoryHandover)({
      stopTeam: () =>
        Effect.sync(() => {
          calls.push("team-stop");
        }),
    }),
    Layer.mock(Boundaries.FactoryBoundaryExecution)({
      stop: () =>
        Effect.sync(() => {
          calls.push("boundary-stop");
        }),
    }),
    Layer.succeed(Threads.ThreadManagementService, {
      ...threads,
      sendToThread: (input) =>
        Effect.gen(function* () {
          if (failSend)
            return yield* new Threads.ThreadManagementProjectionLoadError({
              projectId: input.projectId,
              threadId: input.threadId,
              cause: "Unavailable before acceptance",
            });
          calls.push("resume");
          const result = yield* threads.sendToThread(input);
          if (loseAck) {
            loseAck = false;
            return yield* new Threads.ThreadManagementProjectionLoadError({
              projectId: input.projectId,
              threadId: input.threadId,
              cause: "Lost acknowledgement",
            });
          }
          return result;
        }),
    }),
  );
  const effects = yield* Workflows.FactoryWorkflowEffects.pipe(
    Effect.provide(Workflows.layer.pipe(Layer.provide(dependencies))),
  );
  const commit = (command: FactoryCommand) =>
    store.commit({ actor: { kind: "human" }, command, now: deliveryNow });
  const step = Effect.fn(function* (kind: string) {
    const pending = (yield* store.pending).find((entry) => entry.intent.type === kind);
    assert.isDefined(pending);
    yield* effects.handle(pending!);
    return pending!;
  });
  return {
    store,
    threads,
    effects,
    commit,
    step,
    seed,
    root,
    calls,
    loseAck: () => {
      loseAck = true;
    },
    failSend: (value: boolean) => {
      failSend = value;
    },
  };
});

describe("workflow effects", () => {
  it.effect("resolves the real project root before checking shared repository ownership", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const context = yield* f.effects.context(
        { kind: "human" },
        {
          type: "manager.create",
          commandId: CommandId.make("create-project-manager"),
          projectId: deliveryIds.project,
          modelSelection: deliverySelection,
        },
        f.seed.managers[0]!.workflow,
      );
      assert.equal(context.projectRepositoryRoot, yield* fs.realPath(f.root));
    }).pipe(Effect.scoped, Effect.provide(base)),
  );
  it.effect(
    "wakes the system manager only for exact authorized work and retries notification without duplicate messages",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.equal((yield* f.store.pending).length, 0);
        yield* f.commit({
          type: "shared.work.authorize",
          commandId: CommandId.make("authorize-work"),
          workId: "shared-work",
        });
        f.failSend(true);
        yield* f.step("workflow.work.notify");
        assert.equal((yield* f.store.snapshot).sharedWorks[0]!.notification?.phase, "failed");
        f.failSend(false);
        f.loseAck();
        yield* f.commit({
          type: "shared.work.notify.retry",
          commandId: CommandId.make("retry-notification"),
          workId: "shared-work",
        });
        const pending = yield* f.step("workflow.work.notify");
        yield* f.effects.handle(pending);
        const state = yield* f.store.snapshot;
        assert.equal(state.sharedWorks[0]!.notification?.phase, "delivered");
        assert.equal(state.sharedWorks[0]!.lifecycle.phase, "authorized");
        const messages = (yield* f.threads.getThreadRecords(systemId, ["messages"])).messages;
        assert.equal(messages.length, 1);
        assert.include(messages[0]!.text, "workId shared-work");
        assert.include(messages[0]!.text, "revision v1");
      }).pipe(Effect.scoped, Effect.provide(base)),
  );
});
