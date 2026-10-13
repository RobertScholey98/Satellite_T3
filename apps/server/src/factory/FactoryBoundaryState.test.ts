import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  type FactoryAssignment,
  type FactoryBoundary,
  type FactorySnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type * as SqlClient from "effect/sql/SqlClient";

import migrateFactory from "../persistence/Migrations/067_EngineeringFactory.ts";
import migrateBoundaries from "../persistence/Migrations/068_FactoryBoundaries.ts";
import { decide } from "./FactoryState.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { deliverySkills } from "./FactoryDelivery.testkit.ts";

const now = "2026-10-10T12:00:00.000Z";
const projectId = ProjectId.make("web");
const managerId = ThreadId.make("manager-web");
const leadId = ThreadId.make("lead-web");
const assignmentId = FactoryAssignmentId.make("onboarding-web");
const workflow = { repositoryRoot: "/owned-workflow", revision: "workflow-commit" };
const configuration = {
  protectedPaths: ["AGENTS.md", "package.json", "eslint.config.js"],
  writablePaths: ["src/app.ts"],
  creatableDirectories: ["src/features"],
  gates: [
    {
      id: "lint",
      label: "Lint",
      executable: "node",
      args: ["scripts/lint.mjs"],
      cwd: ".",
      timeoutMs: 30000,
      protectedInputs: ["scripts/lint.mjs", "eslint.config.js"],
    },
  ],
};
const boundary = {
  ...configuration,
  id: FactoryBoundaryId.make("boundary-web-v1"),
  projectId,
  sourceRevision: "project-commit",
  workflow,
  profileId: "qualified-profile",
  approvedAt: now,
} satisfies FactoryBoundary;
const approve = {
  type: "manager.approve-onboarding" as const,
  commandId: CommandId.make("approve-web"),
  managerId,
  configuration,
};
const human = { kind: "human" } as const;
const create = {
  actor: human,
  now,
  command: {
    type: "manager.create" as const,
    commandId: CommandId.make("create-web"),
    projectId,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved-model" },
  },
  skills: workflow,
  allocation: { managerThreadId: managerId, leadThreadId: leadId, assignmentId },
  qualification: { status: "qualified" as const, profileId: "qualified-profile", checkedAt: now },
};
const openStore = FactoryStore.FactoryStore.pipe(Effect.provide(Layer.fresh(FactoryStore.layer)));
const setup = migrateFactory.pipe(Effect.andThen(migrateBoundaries), Effect.andThen(openStore));
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
const reportedStore = Effect.gen(function* () {
  const store = yield* setup;
  yield* store.commit(create);
  for (const [index, threadId] of [managerId, leadId].entries()) {
    yield* store.finishEffect({
      id: `create-web:${index}`,
      now,
      command: {
        type: "thread.launch.recorded",
        commandId: CommandId.make(`launched-${index}`),
        threadId,
      },
    });
  }
  yield* store.commit({
    actor: { kind: "thread", threadId: leadId },
    now,
    command: {
      type: "onboarding.report",
      commandId: CommandId.make("report-web"),
      assignmentId,
      report: {
        summary: "Discovery identified the required protected inputs and source paths.",
        instructions: [],
        checks: [],
        verificationTools: [],
        protectedControls: [],
        unresolvedDecisions: [],
        tracker: { description: "Use repository issues.", evidence: [] },
        proposedBoundary: configuration,
      },
    },
  });
  return store;
});

describe("factory boundary adoption", () => {
  it.effect(
    "activates a reported manager only with a human-approved host baseline and preserves it after reopen",
    () =>
      run(
        Effect.gen(function* () {
          const store = yield* reportedStore;
          const receipt = yield* store.commit({ actor: human, command: approve, now, boundary });
          const reopened = yield* openStore;
          const state = yield* reopened.snapshot;
          assert.equal(state.revision, receipt.revision);
          assert.equal(state.managers[0]!.status, "active");
          assert.equal(state.managers[0]!.boundaryId, boundary.id);
          assert.equal(state.managers[0]!.wait, null);
          assert.deepStrictEqual(state.boundaries, [boundary]);
          assert.equal(state.assignments[0]!.status, "complete");
          assert.equal(state.assignments[0]!.grantedPolicy.delivery, "human-approval");
          const replay = yield* reopened.commit({
            actor: human,
            command: approve,
            now,
            boundary: {
              ...boundary,
              id: FactoryBoundaryId.make("replacement"),
              sourceRevision: "changed-project",
            },
          });
          assert.deepStrictEqual(replay, receipt);
          assert.deepStrictEqual((yield* reopened.snapshot).boundaries, [boundary]);
          const replacement = yield* reopened
            .commit({
              actor: human,
              command: { ...approve, commandId: CommandId.make("replace-baseline") },
              now,
              boundary: { ...boundary, id: FactoryBoundaryId.make("replacement") },
            })
            .pipe(Effect.result);
          assert.isTrue(Result.isFailure(replacement));
          if (Result.isFailure(replacement))
            assert.equal(replacement.failure.code, "invalid-state");
          assert.equal((yield* reopened.snapshot).revision, receipt.revision);
        }),
      ),
  );

  it.effect("keeps the manager blocked when approval has no captured host baseline", () =>
    run(
      Effect.gen(function* () {
        const store = yield* reportedStore;
        const before = yield* store.snapshot;
        yield* store.commit({ actor: human, command: approve, now });
        const state = yield* (yield* openStore).snapshot;
        assert.equal(state.managers[0]!.status, "blocked");
        assert.equal(state.managers[0]!.wait?.kind, "execution-boundary");
        assert.deepStrictEqual(state.managers[0]!.wait, before.managers[0]!.wait);
        assert.equal(state.managers[0]!.boundaryId, undefined);
        assert.equal(state.boundaries.length, 0);
        assert.equal(state.assignments[0]!.status, "complete");
      }),
    ),
  );

  it.effect("rejects approval before the onboarding report is recorded", () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        yield* store.commit(create);
        const result = yield* store
          .commit({ actor: human, command: approve, now, boundary })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.equal(result.failure.code, "invalid-state");
        const state = yield* store.snapshot;
        assert.equal(state.managers[0]!.status, "onboarding");
        assert.equal(state.revision, 1);
        assert.equal(state.boundaries.length, 0);
      }),
    ),
  );

  it.effect("does not let a manager, lead, or host approve its own baseline", () =>
    run(
      Effect.gen(function* () {
        const store = yield* reportedStore;
        const before = yield* store.snapshot;
        const actors = [
          { kind: "thread", threadId: managerId },
          { kind: "thread", threadId: leadId },
          { kind: "system" },
        ] as const;
        for (const [index, actor] of actors.entries()) {
          const result = yield* store
            .commit({
              actor,
              command: { ...approve, commandId: CommandId.make(`self-approve-${index}`) },
              now,
              boundary,
            })
            .pipe(Effect.result);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) assert.equal(result.failure.code, "permission-denied");
        }
        assert.equal((yield* store.snapshot).revision, before.revision);
        yield* store.commit({ actor: human, command: approve, now, boundary });
        assert.equal((yield* store.snapshot).managers[0]!.status, "active");
      }),
    ),
  );

  it.effect.each([
    { name: "another project", candidate: { ...boundary, projectId: ProjectId.make("api") } },
    {
      name: "another workflow revision",
      candidate: { ...boundary, workflow: { ...workflow, revision: "unapproved-workflow" } },
    },
    {
      name: "another workflow repository",
      candidate: { ...boundary, workflow: { ...workflow, repositoryRoot: "/different-workflow" } },
    },
  ])("rejects a captured baseline for $name", ({ candidate }) =>
    run(
      Effect.gen(function* () {
        const store = yield* reportedStore;
        const before = yield* store.snapshot;
        const result = yield* store
          .commit({ actor: human, command: approve, now, boundary: candidate })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.equal(result.failure.code, "invalid-state");
        const after = yield* store.snapshot;
        assert.equal(after.revision, before.revision);
        assert.equal(after.managers[0]!.status, "blocked");
        assert.equal(after.boundaries.length, 0);
      }),
    ),
  );
});

describe("factory control baseline refresh", () => {
  const refreshed = {
    ...boundary,
    id: FactoryBoundaryId.make("boundary-web-v2"),
    sourceRevision: "project-commit-2",
    controlPaths: ["AGENTS.md", "package.json", "eslint.config.js"],
  } satisfies FactoryBoundary;
  const refresh = {
    type: "manager.refresh-boundary" as const,
    commandId: CommandId.make("refresh-web"),
    managerId,
  };
  const approvedStore = Effect.gen(function* () {
    const store = yield* reportedStore;
    yield* store.commit({ actor: human, command: approve, now, boundary });
    return store;
  });
  const withAssignments = (state: FactorySnapshot) => {
    const onboarding = state.assignments[0]!;
    const work = (id: string, preparation: "preparing" | "ready", waiting: boolean) =>
      ({
        ...onboarding,
        id: FactoryAssignmentId.make(id),
        threadId: ThreadId.make(`${id}-lead`),
        kind: "implementation",
        status: waiting ? "waiting" : "running",
        preparation,
        wait: waiting
          ? { kind: "execution-boundary", reason: "The starting source changes protected control" }
          : null,
        grant: {
          boundaryId: boundary.id,
          epoch: 0,
          sourcePaths: ["src/app.ts"],
          creatableDirectories: [],
          controlChange: null,
        },
      }) satisfies FactoryAssignment;
    return {
      ...state,
      assignments: [
        onboarding,
        work("blocked", "preparing", true),
        work("running", "ready", false),
      ],
    };
  };

  it.effect(
    "lets only a human adopt a new baseline and re-prepares work blocked on the old one",
    () =>
      run(
        Effect.gen(function* () {
          const state = withAssignments(yield* (yield* approvedStore).snapshot);
          for (const actor of [
            { kind: "thread", threadId: managerId },
            { kind: "system" },
          ] as const) {
            const denied = decide({
              skills: deliverySkills,
              state,
              actor,
              command: refresh,
              now,
              boundary: refreshed,
            });
            assert.isTrue(Result.isFailure(denied));
            if (Result.isFailure(denied)) assert.equal(denied.failure.code, "permission-denied");
          }
          for (const candidate of [
            undefined,
            boundary,
            { ...refreshed, projectId: ProjectId.make("api") },
            { ...refreshed, workflow: { ...workflow, revision: "other-workflow" } },
          ]) {
            const rejected = decide({
              skills: deliverySkills,
              state,
              actor: human,
              command: refresh,
              now,
              ...(candidate === undefined ? {} : { boundary: candidate }),
            });
            assert.isTrue(Result.isFailure(rejected));
            if (Result.isFailure(rejected)) assert.equal(rejected.failure.code, "invalid-state");
          }
          const decision = decide({
            skills: deliverySkills,
            state,
            actor: human,
            command: refresh,
            now,
            boundary: refreshed,
          });
          assert.isTrue(Result.isSuccess(decision));
          if (!Result.isSuccess(decision)) return;
          const next = decision.success.state;
          assert.equal(next.managers[0]!.boundaryId, refreshed.id);
          assert.deepStrictEqual(
            next.boundaries.map((entry) => entry.id),
            [boundary.id, refreshed.id],
          );
          const blocked = next.assignments.find((entry) => entry.id === "blocked")!;
          assert.equal(blocked.status, "pending");
          assert.equal(blocked.wait, null);
          assert.equal(blocked.grant?.boundaryId, refreshed.id);
          assert.equal(
            next.assignments.find((entry) => entry.id === "running")!.grant?.boundaryId,
            boundary.id,
          );
          assert.deepStrictEqual(
            decision.success.effects.map((effect) =>
              effect.type === "assignment.prepare" ? effect.assignmentId : effect.type,
            ),
            ["blocked"],
          );
        }),
      ),
  );

  it.effect("persists the refreshed baseline and replays the same refresh command", () =>
    run(
      Effect.gen(function* () {
        const store = yield* approvedStore;
        const receipt = yield* store.commit({
          actor: human,
          command: refresh,
          now,
          boundary: refreshed,
        });
        const reopened = yield* openStore;
        const state = yield* reopened.snapshot;
        assert.equal(state.managers[0]!.boundaryId, refreshed.id);
        assert.deepStrictEqual(state.boundaries, [boundary, refreshed]);
        assert.deepStrictEqual(
          yield* reopened.commit({ actor: human, command: refresh, now, boundary: refreshed }),
          receipt,
        );
      }),
    ),
  );
});
