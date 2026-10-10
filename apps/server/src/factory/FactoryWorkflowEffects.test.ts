import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  FactoryError,
  FactorySnapshot,
  FactorySourceId,
  ThreadId,
  type FactoryCommand,
} from "@t3tools/contracts";
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
import * as WorkflowExecution from "./FactoryWorkflowExecution.ts";
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
    title: "Workflow restart",
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
    workflowReleases: [
      {
        id: "release",
        repositoryId: "owned-library",
        version: { repositoryRoot: "/owned-skills", revision: "c".repeat(40) },
        snapshotDigest: "d".repeat(64),
        proposalId: "proposal",
        proposalRevision: "v1",
        assignmentId: null,
        provenance: "owned-codex-library",
        baselineOrigin: "pstack-codex-adaptation",
        registeredAt: deliveryNow,
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
  let failPreparation = false;
  let loseAck = false;
  let failSend = false;
  const dependencies = Layer.mergeAll(
    Access.layer,
    Layer.mock(WorkflowExecution.FactoryWorkflowExecution)({}),
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
      captureMigration: () =>
        Effect.sync(() => {
          calls.push("capture");
          return {
            ...seed.assignments[0]!.startingSource!,
            id: FactorySourceId.make("preserved-source"),
            origin: "handover" as const,
            threadId: deliveryIds.lead,
            sourceDigest: "preserved-candidate",
            unstagedPaths: ["src/feature.ts"],
          };
        }),
      prepare: (input) =>
        Effect.gen(function* () {
          calls.push("prepare");
          assert.equal(input.startingSourceId, "preserved-source");
          assert.equal(input.grant.epoch, 2);
          assert.equal((yield* store.snapshot).assignments[0]!.workflow.revision, "c".repeat(40));
          return failPreparation
            ? { status: "unavailable" as const, reason: "Runtime unavailable" }
            : { status: "qualified" as const, profileId: "fresh-profile", checkedAt: deliveryNow };
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
  const restart = commit({
    type: "workflow.restart",
    commandId: CommandId.make("restart"),
    releaseId: "release",
    assignmentIds: [deliveryIds.assignment],
    kind: "migration",
    reason: "Explicit selection",
  });
  return {
    store,
    threads,
    effects,
    commit,
    step,
    restart,
    seed,
    root,
    calls,
    failPreparation: (value: boolean) => {
      failPreparation = value;
    },
    loseAck: () => {
      loseAck = true;
    },
    failSend: (value: boolean) => {
      failSend = value;
    },
  };
});

describe("workflow restart effects", () => {
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
          workflow: f.seed.managers[0]!.workflow,
        },
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
        assert.equal(state.workflowAdoptions.length, 0);
        const messages = (yield* f.threads.getThreadRecords(systemId, ["messages"])).messages;
        assert.equal(messages.length, 1);
        assert.include(messages[0]!.text, "workId shared-work");
        assert.include(messages[0]!.text, "revision v1");
      }).pipe(Effect.scoped, Effect.provide(base)),
  );
  it.effect(
    "stops before capture, retains the existing wait and resumes once after a lost acknowledgement",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.restart;
        yield* f.step("workflow.restart.stop");
        assert.deepEqual(f.calls, ["boundary-stop", "team-stop", "capture"]);
        yield* f.step("workflow.restart.prepare");
        const prepared = (yield* f.store.snapshot).assignments[0]!;
        assert.deepEqual(prepared.wait, f.seed.assignments[0]!.wait);
        assert.equal(prepared.threadId, deliveryIds.lead);
        f.loseAck();
        const pending = yield* f.step("workflow.restart.resume");
        yield* f.effects.handle(pending);
        assert.equal(f.calls.filter((call) => call === "resume").length, 1);
        const migration = (yield* f.store.snapshot).workflowMigrations[0]!;
        assert.equal(migration.lifecycle.phase, "ready");
        assert.isTrue(
          migration.lifecycle.phase === "ready" && migration.lifecycle.resume.phase === "delivered",
        );
        const records = yield* f.threads.getThreadRecords(deliveryIds.lead, ["messages"]);
        assert.equal(records.messages.length, 1);
        assert.include(records.messages[0]!.text, "c".repeat(40));
      }).pipe(Effect.scoped, Effect.provide(base)),
  );

  it.effect(
    "records a failed preparation and retries its step without recapturing or discarding work",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.restart;
        yield* f.step("workflow.restart.stop");
        f.failPreparation(true);
        yield* f.step("workflow.restart.prepare");
        const failed = (yield* f.store.snapshot).workflowMigrations[0]!;
        assert.equal(failed.lifecycle.phase, "failed");
        assert.equal(f.calls.includes("resume"), false);
        f.failPreparation(false);
        yield* f.commit({
          type: "workflow.restart.retry",
          commandId: CommandId.make("retry"),
          migrationId: failed.id,
        });
        yield* f.step("workflow.restart.prepare");
        yield* f.step("workflow.restart.resume");
        assert.equal(f.calls.filter((call) => call === "capture").length, 1);
        assert.equal(f.calls.filter((call) => call === "prepare").length, 2);
        assert.deepEqual(
          (yield* f.store.snapshot).assignments[0]!.wait,
          f.seed.assignments[0]!.wait,
        );
      }).pipe(Effect.scoped, Effect.provide(base)),
  );

  it.effect(
    "rejects a receipt for a different migration without consuming the pending operation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.restart;
        const pending = (yield* f.store.pending).find(
          (entry) => entry.intent.type === "workflow.restart.stop",
        )!;
        const rejected = yield* f.store
          .finishEffect({
            id: pending.id,
            now: deliveryNow,
            failed: true,
            command: {
              type: "workflow.restart.failed",
              commandId: CommandId.make("wrong-receipt"),
              migrationId: "other-operation",
              step: "stop",
              reason: "Wrong receipt",
            },
          })
          .pipe(Effect.flip);
        assert.instanceOf(rejected, FactoryError);
        assert.isTrue((yield* f.store.pending).some((entry) => entry.id === pending.id));
        yield* f.step("workflow.restart.stop");
        assert.equal((yield* f.store.snapshot).workflowMigrations[0]!.lifecycle.phase, "preparing");
      }).pipe(Effect.scoped, Effect.provide(base)),
  );
});
