import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  type FactoryCommand,
  type FactoryDiscoveryQualification,
  type FactoryPolicy,
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
import { resolveManagerPolicy } from "./FactoryPolicy.ts";
import * as FactoryStore from "./FactoryStore.ts";

const now = "2026-10-10T12:00:00.000Z";
const human = { kind: "human" } as const;
const supervised = {
  delivery: "human-approval",
  projectImprovements: "create-tickets",
  sharedWorkflow: "investigate-and-recommend",
  authorizeRuleWeakening: false,
  recoveryCycles: 1,
} satisfies FactoryPolicy;
const delegated = {
  delivery: "project-rule",
  projectImprovements: "project-rule",
  sharedWorkflow: "investigate-and-recommend",
  authorizeRuleWeakening: true,
  recoveryCycles: 3,
} satisfies FactoryPolicy;

const createManager = (
  name: string,
  qualification: FactoryDiscoveryQualification = {
    status: "unavailable",
    reason: "Start Docker before discovery can run.",
  },
) => ({
  actor: human,
  now,
  command: {
    type: "manager.create" as const,
    commandId: CommandId.make(`create-${name}`),
    projectId: ProjectId.make(name),
    name,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved-model" },
    workflow: { repositoryRoot: "/owned-skills", revision: "approved-commit" },
  },
  allocation: {
    managerThreadId: ThreadId.make(`manager-${name}`),
    leadThreadId: ThreadId.make(`lead-${name}`),
    assignmentId: FactoryAssignmentId.make(`assignment-${name}`),
  },
  qualification,
});
const web = createManager("web");
const api = createManager("api");
const openStore = FactoryStore.FactoryStore.pipe(Effect.provide(Layer.fresh(FactoryStore.layer)));
const setup = migrateFactory.pipe(Effect.andThen(migrateBoundaries), Effect.andThen(openStore));
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
const commit = (store: FactoryStore.FactoryStore["Service"], command: FactoryCommand) =>
  store.commit({ actor: human, now, command });

describe("persisted factory authority", () => {
  it.effect(
    "resolves defaults per manager dimension and resumes inheritance when overrides clear",
    () =>
      run(
        Effect.gen(function* () {
          const store = yield* setup;
          yield* store.commit(web);
          yield* store.commit(api);
          yield* commit(store, {
            type: "manager.configure",
            commandId: CommandId.make("web-overrides"),
            managerId: web.allocation.managerThreadId,
            overrides: {
              delivery: "human-approval",
              authorizeRuleWeakening: false,
              recoveryCycles: 0,
            },
          });
          yield* commit(store, {
            type: "policy.defaults.configure",
            commandId: CommandId.make("increase-defaults"),
            defaults: delegated,
          });
          const reopened = yield* openStore;
          const before = yield* reopened.snapshot;
          assert.deepStrictEqual(
            before.managers.map((manager) => ({
              id: manager.id,
              policy: resolveManagerPolicy(before.defaults, manager.overrides),
            })),
            [
              {
                id: web.allocation.managerThreadId,
                policy: {
                  ...delegated,
                  delivery: "human-approval",
                  authorizeRuleWeakening: false,
                  recoveryCycles: 0,
                },
              },
              { id: api.allocation.managerThreadId, policy: delegated },
            ],
          );
          yield* commit(reopened, {
            type: "manager.configure",
            commandId: CommandId.make("clear-web-overrides"),
            managerId: web.allocation.managerThreadId,
            overrides: {},
          });
          const inherited = yield* store.snapshot;
          assert.deepStrictEqual(
            resolveManagerPolicy(inherited.defaults, inherited.managers[0]!.overrides),
            {
              delivery: "project-rule",
              projectImprovements: "project-rule",
              sharedWorkflow: "investigate-and-recommend",
              authorizeRuleWeakening: true,
              recoveryCycles: 3,
            },
          );
          assert.deepStrictEqual(inherited.assignments[0]!.grantedPolicy, {
            ...supervised,
            recoveryCycles: 0,
          });
        }),
      ),
  );

  it.effect("extends only selected active grants and preserves their execution waits", () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        yield* store.commit(web);
        yield* store.commit(api);
        yield* commit(store, {
          type: "policy.defaults.configure",
          commandId: CommandId.make("increase-defaults"),
          defaults: delegated,
        });
        assert.deepStrictEqual(
          (yield* store.snapshot).assignments.map((assignment) => assignment.grantedPolicy),
          [supervised, supervised],
        );
        yield* store.commit(createManager("desktop"));
        const extend = {
          type: "assignments.extend-grant" as const,
          commandId: CommandId.make("extend-web"),
          assignmentIds: [web.allocation.assignmentId],
        };
        const receipt = yield* commit(store, extend);
        const reopened = yield* openStore;
        assert.deepStrictEqual(yield* commit(reopened, extend), receipt);
        const after = yield* reopened.snapshot;
        assert.equal(after.revision, receipt.revision);
        assert.deepStrictEqual(
          after.assignments.map((assignment) => ({
            id: assignment.id,
            grantedPolicy: assignment.grantedPolicy,
            status: assignment.status,
            wait: assignment.wait,
          })),
          [
            {
              id: web.allocation.assignmentId,
              grantedPolicy: delegated,
              status: "waiting",
              wait: {
                kind: "execution-boundary",
                reason: "Start Docker before discovery can run.",
              },
            },
            {
              id: api.allocation.assignmentId,
              grantedPolicy: supervised,
              status: "waiting",
              wait: {
                kind: "execution-boundary",
                reason: "Start Docker before discovery can run.",
              },
            },
            {
              id: FactoryAssignmentId.make("assignment-desktop"),
              grantedPolicy: delegated,
              status: "waiting",
              wait: {
                kind: "execution-boundary",
                reason: "Start Docker before discovery can run.",
              },
            },
          ],
        );
        assert.deepStrictEqual(
          after.managers.map((manager) => manager.status),
          ["blocked", "blocked", "blocked"],
        );
      }),
    ),
  );

  it.effect("persists default and manager revocations through subsequent increases", () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        yield* commit(store, {
          type: "policy.defaults.configure",
          commandId: CommandId.make("initial-high-defaults"),
          defaults: delegated,
        });
        yield* store.commit(web);
        yield* store.commit(api);
        yield* commit(store, {
          type: "policy.defaults.configure",
          commandId: CommandId.make("reduce-defaults"),
          defaults: { ...supervised, projectImprovements: "project-rule" },
        });
        yield* commit(store, {
          type: "policy.defaults.configure",
          commandId: CommandId.make("restore-high-defaults"),
          defaults: delegated,
        });
        yield* commit(store, {
          type: "manager.configure",
          commandId: CommandId.make("reduce-api"),
          managerId: api.allocation.managerThreadId,
          overrides: { projectImprovements: "create-tickets", recoveryCycles: 0 },
        });
        yield* commit(store, {
          type: "manager.configure",
          commandId: CommandId.make("clear-api-reduction"),
          managerId: api.allocation.managerThreadId,
          overrides: {},
        });
        const reopened = yield* openStore;
        const after = yield* reopened.snapshot;
        assert.deepStrictEqual(
          after.assignments.map((assignment) => assignment.grantedPolicy),
          [
            {
              delivery: "human-approval",
              projectImprovements: "project-rule",
              sharedWorkflow: "investigate-and-recommend",
              authorizeRuleWeakening: false,
              recoveryCycles: 1,
            },
            {
              delivery: "human-approval",
              projectImprovements: "create-tickets",
              sharedWorkflow: "investigate-and-recommend",
              authorizeRuleWeakening: false,
              recoveryCycles: 0,
            },
          ],
        );
        assert.deepStrictEqual(
          after.managers.map((manager) => resolveManagerPolicy(after.defaults, manager.overrides)),
          [delegated, delegated],
        );
      }),
    ),
  );

  it.effect("retains the human onboarding decision when authority increases", () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        yield* store.commit(
          createManager("web", {
            status: "qualified",
            profileId: "read-only-profile",
            checkedAt: now,
          }),
        );
        for (const [index, threadId] of [
          web.allocation.managerThreadId,
          web.allocation.leadThreadId,
        ].entries()) {
          yield* store.finishEffect({
            id: `create-web:${index}`,
            now,
            command: {
              type: "thread.launch.recorded",
              commandId: CommandId.make(`launch-${index}`),
              threadId,
            },
          });
        }
        yield* store.commit({
          actor: { kind: "thread", threadId: web.allocation.leadThreadId },
          now,
          command: {
            type: "onboarding.report",
            commandId: CommandId.make("report-onboarding"),
            assignmentId: web.allocation.assignmentId,
            report: {
              summary: "The project needs a human decision about protected controls.",
              instructions: [],
              checks: [],
              tracker: { description: "Use repository issues.", evidence: [] },
              verificationTools: [],
              protectedControls: [],
              unresolvedDecisions: [
                { description: "Choose the required UI review gate.", evidence: [] },
              ],
            },
          },
        });
        const waiting = yield* store.snapshot;
        assert.equal(waiting.managers[0]!.wait?.kind, "human-decision");
        yield* commit(store, {
          type: "policy.defaults.configure",
          commandId: CommandId.make("increase-after-report"),
          defaults: delegated,
        });
        yield* commit(store, {
          type: "manager.configure",
          commandId: CommandId.make("manager-increase-after-report"),
          managerId: web.allocation.managerThreadId,
          overrides: delegated,
        });
        const after = yield* store.snapshot;
        assert.equal(after.managers[0]!.status, "blocked");
        assert.deepStrictEqual(after.managers[0]!.wait, waiting.managers[0]!.wait);
        assert.equal(after.assignments[0]!.status, "complete");
        assert.deepStrictEqual(after.assignments[0]!.grantedPolicy, supervised);
        const extension = yield* commit(store, {
          type: "assignments.extend-grant",
          commandId: CommandId.make("extend-completed"),
          assignmentIds: [web.allocation.assignmentId],
        }).pipe(Effect.result);
        assert.isTrue(Result.isFailure(extension));
        if (Result.isFailure(extension)) assert.equal(extension.failure.code, "invalid-state");
        assert.equal((yield* store.snapshot).revision, after.revision);
      }),
    ),
  );

  it.effect(
    "rejects manager, lead, and host self-escalation without changing saved authority",
    () =>
      run(
        Effect.gen(function* () {
          const store = yield* setup;
          yield* store.commit(web);
          const actors = [
            { kind: "thread", threadId: web.allocation.managerThreadId },
            { kind: "thread", threadId: web.allocation.leadThreadId },
            { kind: "system" },
          ] as const;
          for (const [index, actor] of actors.entries()) {
            const commands: FactoryCommand[] = [
              {
                type: "policy.defaults.configure",
                commandId: CommandId.make(`agent-defaults-${index}`),
                defaults: delegated,
              },
              {
                type: "manager.configure",
                commandId: CommandId.make(`agent-manager-${index}`),
                managerId: web.allocation.managerThreadId,
                overrides: delegated,
              },
              {
                type: "assignments.extend-grant",
                commandId: CommandId.make(`agent-extension-${index}`),
                assignmentIds: [web.allocation.assignmentId],
              },
            ];
            for (const command of commands) {
              const result = yield* store.commit({ actor, command, now }).pipe(Effect.result);
              assert.isTrue(Result.isFailure(result));
              if (Result.isFailure(result)) assert.equal(result.failure.code, "permission-denied");
            }
          }
          const after = yield* (yield* openStore).snapshot;
          assert.equal(after.revision, 1);
          assert.deepStrictEqual(after.defaults, supervised);
          assert.deepStrictEqual(after.assignments[0]!.grantedPolicy, supervised);
          assert.equal(after.managers[0]!.id, web.allocation.managerThreadId);
        }),
      ),
  );

  it.effect(
    "rejects an invalid selection atomically instead of partially extending valid assignments",
    () =>
      run(
        Effect.gen(function* () {
          const store = yield* setup;
          yield* store.commit(web);
          yield* commit(store, {
            type: "policy.defaults.configure",
            commandId: CommandId.make("increase-defaults"),
            defaults: delegated,
          });
          const before = yield* store.snapshot;
          const result = yield* commit(store, {
            type: "assignments.extend-grant",
            commandId: CommandId.make("mixed-selection"),
            assignmentIds: [
              web.allocation.assignmentId,
              FactoryAssignmentId.make("missing-assignment"),
            ],
          }).pipe(Effect.result);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) assert.equal(result.failure.code, "assignment-not-found");
          const after = yield* store.snapshot;
          assert.equal(after.revision, before.revision);
          assert.deepStrictEqual(after.assignments[0]!.grantedPolicy, supervised);
        }),
      ),
  );
});
