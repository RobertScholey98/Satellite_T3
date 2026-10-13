import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  FactoryAssignmentId,
  type FactoryError,
  type FactoryHostCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import migration from "../persistence/Migrations/067_EngineeringFactory.ts";
import observationMigration from "../persistence/Migrations/069_FactoryObservation.ts";
import * as FactoryStore from "./FactoryStore.ts";

const now = "2026-10-10T12:00:00.000Z";
const managerId = ThreadId.make("manager-web");
const leadId = ThreadId.make("onboarding-web");
const assignmentId = FactoryAssignmentId.make("assignment-web");
const createInput = {
  actor: { kind: "human" } as const,
  command: {
    type: "manager.create" as const,
    commandId: CommandId.make("create-web"),
    projectId: ProjectId.make("web"),
    name: "Web engineering manager",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved-model" },
  },
  skills: { repositoryRoot: "C:/owned-skills", revision: "approved-commit" },
  allocation: { managerThreadId: managerId, leadThreadId: leadId, assignmentId },
  qualification: { status: "qualified" as const, profileId: "discovery-v1", checkedAt: now },
  now,
};

const openStore = FactoryStore.FactoryStore.pipe(Effect.provide(Layer.fresh(FactoryStore.layer)));
const setup = migration.pipe(Effect.andThen(observationMigration), Effect.andThen(openStore));
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
const inFile = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

const completion = (id: string, threadId: ThreadId) => ({
  id,
  command: {
    type: "thread.launch.recorded" as const,
    commandId: CommandId.make(`${id}:receipt`),
    threadId,
  },
  now,
});

function assertFailure(result: Result.Result<unknown, FactoryError>, code: FactoryError["code"]) {
  if (Result.isSuccess(result)) return assert.fail("Expected a rejected store operation.");
  assert.equal(result.failure.code, code);
  return result.failure;
}

describe("FactoryStore", () => {
  it.effect(
    "advances observation only with the durable decision and ignores replayed sequences",
    () =>
      run(
        Effect.gen(function* () {
          const store = yield* setup;
          yield* store.commit(createInput);
          const command = {
            type: "thread.launch.started" as const,
            commandId: CommandId.make("observed-launch"),
            threadId: managerId,
          };
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER reject_observation BEFORE INSERT ON factory_observers
        BEGIN SELECT RAISE(ABORT, 'injected cursor failure'); END`;
          assertFailure(
            yield* store.observe({ sequence: 10, command, now }).pipe(Effect.result),
            "persistence",
          );
          assert.equal(yield* store.observationCursor, 0);
          assert.equal((yield* store.snapshot).revision, 1);
          assert.equal(yield* store.findReceipt({ actor: { kind: "system" }, command }), undefined);
          yield* sql`DROP TRIGGER reject_observation`;
          yield* store.observe({ sequence: 10, command, now });
          const saved = yield* store.snapshot;
          assert.equal(yield* store.observationCursor, 10);
          yield* store.observe({
            sequence: 10,
            command: { ...command, commandId: CommandId.make("duplicate-observation") },
            now,
          });
          yield* store.observe({ sequence: 9, now });
          const reopened = yield* openStore;
          assert.deepEqual(yield* reopened.snapshot, saved);
          assert.equal(yield* reopened.observationCursor, 10);
          yield* reopened.observe({ sequence: 12, now });
          assert.equal(yield* reopened.observationCursor, 12);
          assert.deepEqual(yield* reopened.snapshot, saved);
        }),
      ),
  );

  it.effect("publishes each revision to subscribers once, not again for a replayed command", () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const subscribed = yield* Deferred.make<void>();
        const revisions = yield* store.changes.pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.map((snapshot) => snapshot.revision),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        yield* store.commit(createInput);
        yield* store.commit(createInput);
        yield* store.observe({
          sequence: 1,
          command: {
            type: "thread.launch.started",
            commandId: CommandId.make("observed-after-replay"),
            threadId: managerId,
          },
          now,
        });
        assert.deepEqual(yield* Fiber.join(revisions), [0, 1, 2]);
      }),
    ),
  );

  it.effect("reads the payload only when the revision changes", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        let payloadReads = 0;
        const counting = new Proxy(sql, {
          apply: (target, thisArg, args) => {
            const strings: unknown = args[0];
            if (
              Array.isArray(strings) &&
              strings.join("?").includes("payload_json FROM factory_state")
            )
              payloadReads += 1;
            return Reflect.apply(target, thisArg, args);
          },
        });
        yield* migration;
        yield* observationMigration;
        const store = yield* openStore.pipe(Effect.provideService(SqlClient.SqlClient, counting));
        yield* store.commit(createInput);
        for (let read = 0; read < 5; read += 1) yield* store.snapshot;
        assert.equal(payloadReads, 0);
        yield* sql`UPDATE factory_state SET revision = revision + 1 WHERE id = 1`;
        yield* store.snapshot;
        yield* store.snapshot;
        assert.equal(payloadReads, 1);
      }),
    ),
  );

  it.effect("replays a command without changing identities, revision, or launch intent", () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const first = yield* store.commit(createInput);
        const repeated = yield* store.commit({
          ...createInput,
          allocation: {
            managerThreadId: ThreadId.make("unused-manager"),
            leadThreadId: ThreadId.make("unused-lead"),
            assignmentId: FactoryAssignmentId.make("unused-assignment"),
          },
          qualification: { status: "unavailable", reason: "The provider became unavailable." },
        });
        assert.deepEqual(first, {
          revision: 1,
          managerId,
          assignmentId,
        });
        assert.deepEqual(repeated, first);
        const snapshot = yield* store.snapshot;
        assert.equal(snapshot.revision, 1);
        assert.deepEqual(
          snapshot.managers.map((manager) => manager.id),
          ["manager-web"],
        );
        assert.deepEqual(
          snapshot.assignments.map((assignment) => assignment.threadId),
          ["onboarding-web"],
        );
        const pending = yield* store.pending;
        assert.deepEqual(
          pending.map((effect) => ({
            id: effect.id,
            threadId: "threadId" in effect.intent ? effect.intent.threadId : undefined,
          })),
          [
            { id: "create-web:0", threadId: ThreadId.make("manager-web") },
            { id: "create-web:1", threadId: ThreadId.make("onboarding-web") },
          ],
        );
      }),
    ),
  );

  it.effect(
    "finds a persisted receipt before provisioning and rejects changed input or actor",
    () =>
      run(
        Effect.gen(function* () {
          const store = yield* setup;
          assert.equal(yield* store.findReceipt(createInput), undefined);
          yield* store.commit(createInput);
          const reopened = yield* openStore;
          assert.deepEqual(yield* reopened.findReceipt(createInput), {
            revision: 1,
            managerId,
            assignmentId,
          });
          const altered = {
            ...createInput,
            command: { ...createInput.command, name: "Different manager" },
          };
          assertFailure(yield* Effect.result(reopened.findReceipt(altered)), "command-conflict");
          assertFailure(yield* Effect.result(reopened.commit(altered)), "command-conflict");
          assertFailure(
            yield* Effect.result(
              reopened.findReceipt({
                actor: { kind: "thread", threadId: managerId },
                command: createInput.command,
              }),
            ),
            "command-conflict",
          );
          assert.equal((yield* reopened.snapshot).managers[0]?.name, "Web engineering manager");
        }),
      ),
  );

  it.effect("serializes competing manager creation against the persisted project owner", () =>
    run(
      Effect.gen(function* () {
        const firstStore = yield* setup;
        const secondStore = yield* openStore;
        const secondInput = {
          ...createInput,
          command: { ...createInput.command, commandId: CommandId.make("create-competing") },
          allocation: {
            managerThreadId: ThreadId.make("manager-competing"),
            leadThreadId: ThreadId.make("lead-competing"),
            assignmentId: FactoryAssignmentId.make("assignment-competing"),
          },
        };
        const results = yield* Effect.all(
          [
            Effect.result(firstStore.commit(createInput)),
            Effect.result(secondStore.commit(secondInput)),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(results.filter(Result.isSuccess).length, 1);
        assert.deepEqual(
          results.filter(Result.isFailure).map((result) => result.failure.code),
          ["project-already-managed"],
        );
        const state = yield* firstStore.snapshot;
        assert.equal(state.managers.length, 1);
        assert.equal(state.assignments.length, 1);
        assert.equal((yield* secondStore.pending).length, 2);
      }),
    ),
  );

  it.effect("rolls back manager state and its receipt when launch intent cannot be saved", () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER fail_factory_intent BEFORE INSERT ON factory_outbox
        BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END`;
        const failure = assertFailure(
          yield* Effect.result(store.commit(createInput)),
          "persistence",
        );
        assert.isDefined(failure?.cause);
        assert.equal(failure?.message, "Could not read or save engineering-management state.");
        assert.equal((yield* store.snapshot).revision, 0);
        assert.equal(yield* store.findReceipt(createInput), undefined);
        assert.deepEqual(yield* store.pending, []);
        yield* sql`DROP TRIGGER fail_factory_intent`;
        assert.deepEqual(yield* store.commit(createInput), {
          revision: 1,
          managerId,
          assignmentId,
        });
        assert.equal((yield* store.pending).length, 2);
      }),
    ),
  );

  it.effect("keeps acknowledgement, state, and effect outcome in one transaction", () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* store.commit(createInput);
        yield* store.beginEffect("create-web:0");
        const acknowledged = completion("create-web:0", managerId);
        yield* sql`CREATE TRIGGER fail_factory_finish BEFORE UPDATE OF status ON factory_outbox
        WHEN NEW.status = 'completed'
        BEGIN SELECT RAISE(ABORT, 'injected finish failure'); END`;
        assertFailure(yield* Effect.result(store.finishEffect(acknowledged)), "persistence");
        assert.equal((yield* store.snapshot).revision, 1);
        assert.equal((yield* store.snapshot).managers[0]?.threadStatus, "pending");
        assert.equal(
          yield* store.findReceipt({ actor: { kind: "system" }, command: acknowledged.command }),
          undefined,
        );
        assert.deepEqual(
          (yield* store.pending).map((effect) => ({ id: effect.id, attempts: effect.attempts })),
          [
            { id: "create-web:0", attempts: 1 },
            { id: "create-web:1", attempts: 0 },
          ],
        );
        yield* sql`DROP TRIGGER fail_factory_finish`;
        yield* store.finishEffect(acknowledged);
        const fresh = yield* openStore;
        assert.equal((yield* fresh.snapshot).managers[0]?.threadStatus, "created");
        assert.deepEqual(
          (yield* fresh.pending).map((effect) => effect.id),
          ["create-web:1"],
        );
        yield* fresh.finishEffect(acknowledged);
        assert.equal((yield* fresh.snapshot).revision, 2);
        assert.deepEqual(
          yield* fresh.findReceipt({ actor: { kind: "system" }, command: acknowledged.command }),
          {
            revision: 2,
            managerId,
          },
        );
      }),
    ),
  );

  it.effect("refuses unknown, mismatched, and inconsistent effect acknowledgements", () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        yield* store.commit(createInput);
        const unknown = completion("unknown-effect", managerId);
        assertFailure(yield* Effect.result(store.finishEffect(unknown)), "invalid-state");
        assertFailure(yield* Effect.result(store.beginEffect("unknown-effect")), "invalid-state");
        assert.equal(
          yield* store.findReceipt({ actor: { kind: "system" }, command: unknown.command }),
          undefined,
        );
        assertFailure(
          yield* Effect.result(store.finishEffect(completion("create-web:0", leadId))),
          "invalid-state",
        );
        const inconsistent = { ...completion("create-web:0", managerId), failed: true };
        assertFailure(yield* Effect.result(store.finishEffect(inconsistent)), "invalid-state");
        assert.equal((yield* store.snapshot).revision, 1);
        assert.equal((yield* store.snapshot).managers[0]?.threadStatus, "pending");
        yield* store.finishEffect(completion("create-web:0", managerId));
        assert.equal((yield* store.snapshot).managers[0]?.threadStatus, "created");
        assertFailure(yield* Effect.result(store.beginEffect("create-web:0")), "invalid-state");
      }),
    ),
  );

  it.effect("preserves the confirmed effect outcome when a conflicting result arrives", () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        yield* store.commit(createInput);
        yield* store.finishEffect(completion("create-web:0", managerId));
        const command: FactoryHostCommand = {
          type: "thread.launch.failed",
          commandId: CommandId.make("late-failure"),
          threadId: managerId,
          reason: "A stale worker reported failure.",
        };
        assertFailure(
          yield* Effect.result(
            store.finishEffect({
              id: "create-web:0",
              command,
              failed: true,
              now,
            }),
          ),
          "invalid-state",
        );
        assert.equal((yield* store.snapshot).revision, 2);
        assert.equal((yield* store.snapshot).managers[0]?.threadStatus, "created");
        assert.equal(yield* store.findReceipt({ actor: { kind: "system" }, command }), undefined);
        assert.deepEqual(
          (yield* store.pending).map((effect) => effect.id),
          ["create-web:1"],
        );
      }),
    ),
  );

  it.effect("retires stale launch intent without pretending a thread was created", () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        yield* store.commit(createInput);
        yield* store.retireEffect("create-web:0");
        yield* store.retireEffect("create-web:0");
        const fresh = yield* openStore;
        assert.deepEqual(
          (yield* fresh.pending).map((effect) => effect.id),
          ["create-web:1"],
        );
        assert.equal((yield* fresh.snapshot).revision, 1);
        assert.equal((yield* fresh.snapshot).managers[0]?.threadStatus, "pending");
        assertFailure(
          yield* Effect.result(fresh.finishEffect(completion("create-web:0", managerId))),
          "invalid-state",
        );
        assertFailure(yield* Effect.result(fresh.retireEffect("unknown-effect")), "invalid-state");
        yield* fresh.finishEffect(completion("create-web:1", leadId));
        assert.equal((yield* fresh.snapshot).assignments[0]?.threadStatus, "created");
      }),
    ),
  );

  it.effect(
    "recovers saved failures and an interrupted retry after closing and reopening SQLite",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "satellite-factory-store-" });
        const filename = path.join(directory, "state.sqlite");
        yield* inFile(
          filename,
          Effect.gen(function* () {
            const store = yield* setup;
            yield* store.commit(createInput);
            yield* store.beginEffect("create-web:0");
            yield* store.finishEffect(completion("create-web:0", managerId));
            yield* store.beginEffect("create-web:1");
            yield* store.finishEffect({
              id: "create-web:1",
              failed: true,
              now,
              command: {
                type: "thread.launch.failed",
                commandId: CommandId.make("create-web:1:receipt"),
                threadId: leadId,
                reason: "The restricted provider could not start.",
              },
            });
          }),
        );
        yield* inFile(
          filename,
          Effect.gen(function* () {
            const store = yield* openStore;
            const before = yield* store.snapshot;
            assert.equal(before.managers[0]?.threadStatus, "created");
            assert.equal(before.managers[0]?.status, "blocked");
            assert.equal(
              before.assignments[0]?.wait?.reason,
              "The restricted provider could not start.",
            );
            assert.deepEqual(yield* store.pending, []);
            const retry = {
              actor: { kind: "human" },
              now,
              command: {
                type: "manager.retry-onboarding",
                commandId: CommandId.make("retry-web"),
                managerId,
              },
              qualification: { status: "qualified", profileId: "discovery-v2", checkedAt: now },
            } as const;
            assertFailure(yield* Effect.result(store.commit(retry)), "invalid-state");
            yield* store.commit({ ...retry, qualification: createInput.qualification });
            assert.deepEqual(
              (yield* store.pending).map((effect) => ({
                id: effect.id,
                threadId: "threadId" in effect.intent ? effect.intent.threadId : undefined,
                profileId:
                  effect.intent.type === "thread.launch" ? effect.intent.profileId : undefined,
              })),
              [
                {
                  id: "retry-web:0",
                  threadId: ThreadId.make("onboarding-web"),
                  profileId: "discovery-v1",
                },
              ],
            );
            yield* store.beginEffect("retry-web:0");
          }),
        );
        yield* inFile(
          filename,
          Effect.gen(function* () {
            const store = yield* openStore;
            assert.deepEqual(
              (yield* store.pending).map((effect) => ({
                id: effect.id,
                attempts: effect.attempts,
              })),
              [{ id: "retry-web:0", attempts: 1 }],
            );
            yield* store.finishEffect(completion("retry-web:0", leadId));
            const recovered = yield* store.snapshot;
            assert.equal(recovered.managers.length, 1);
            assert.equal(recovered.assignments.length, 1);
            assert.equal(recovered.assignments[0]?.threadId, "onboarding-web");
            assert.equal(recovered.assignments[0]?.status, "running");
            assert.deepEqual(yield* store.pending, []);
            assert.deepEqual(yield* store.findReceipt(createInput), {
              revision: 1,
              managerId,
              assignmentId,
            });
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "fails the outbox read on an undecodable intent that is not a removed restart step",
    () =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = yield* setup;
          yield* store.commit(createInput);
          yield* sql`INSERT INTO factory_outbox
          (effect_id, command_id, payload_json, status, created_at)
          VALUES ('broken:0', 'create-web', ${JSON.stringify({
            type: "thread.launch",
            threadId: "missing-required-fields",
          })}, 'pending', ${now})`;
          assertFailure(yield* store.pending.pipe(Effect.result), "persistence");
          const [outbox] = yield* sql<{ readonly status: string }>`
          SELECT status FROM factory_outbox WHERE effect_id = 'broken:0'`;
          assert.equal(outbox?.status, "pending");
        }),
      ),
  );

  it.effect(
    "loads state, receipts and outbox rows stored by the removed workflow release and restart features",
    () =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = yield* setup;
          yield* store.commit(createInput);
          const pinned = (yield* store.snapshot).assignments[0]!.workflow;
          const [row] = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json FROM factory_state WHERE id = 1`;
          const stored = JSON.parse(row!.payload_json);
          const release = {
            id: "workflow-release:old",
            repositoryId: "shared-repository:old",
            version: { repositoryRoot: "C:/owned-skills", revision: "b".repeat(40) },
            snapshotDigest: "c".repeat(64),
            proposalId: "proposal",
            proposalRevision: "v1",
            assignmentId: null,
            provenance: "owned-codex-library",
            baselineOrigin: "pstack-codex-adaptation",
            registeredAt: now,
          };
          const legacy = {
            ...stored,
            revision: stored.revision + 1,
            workflowReleases: [release],
            workflowAdoptions: [
              {
                id: "workflow-adoption:old",
                releaseId: release.id,
                scope: { kind: "default" },
                commandId: "adopt-old",
                adoptedAt: now,
              },
            ],
            workflowOverrides: [{ managerId, adoptionId: "workflow-adoption:old" }],
            workflowMigrations: [
              {
                id: "workflow-migration:old",
                assignmentId,
                releaseId: release.id,
                previousVersion: pinned,
                previousEpoch: 0,
                preparedEpoch: null,
                retainedAuthorityReason: null,
                previousState: { status: "running", wait: null },
                kind: "migration",
                reason: "Adopt the release",
                commandId: "restart-old",
                createdAt: now,
                lifecycle: { phase: "stopping" },
              },
            ],
            improvementValidations: [
              {
                id: "validation:old",
                proposalId: "proposal",
                proposalRevision: "v1",
                assignmentId: null,
                releaseId: release.id,
                outcome: "success",
                evidence: [],
                assessment: "Fewer corrections",
                recommendedNextStep: "Keep it",
                recordedAt: now,
              },
            ],
          };
          yield* sql`UPDATE factory_state SET revision = ${legacy.revision},
            payload_json = ${JSON.stringify(legacy)} WHERE id = 1`;
          const adopt = {
            type: "workflow.adopt",
            commandId: "adopt-old",
            releaseId: release.id,
            scope: { kind: "default" },
          };
          yield* sql`INSERT INTO factory_commands (command_id, request_json, result_json)
            VALUES ('adopt-old', ${stableStringify({ actor: { kind: "human" }, command: adopt })},
              ${JSON.stringify({ revision: 2, adoptionId: "workflow-adoption:old" })})`;
          yield* sql`INSERT INTO factory_commands (command_id, request_json, result_json)
            VALUES ('restart-old', '{}', ${JSON.stringify({
              revision: 3,
              migrationIds: ["workflow-migration:old"],
              releaseId: release.id,
            })})`;
          yield* sql`INSERT INTO factory_outbox
            (effect_id, command_id, payload_json, status, created_at)
            VALUES ('restart-old:0', 'restart-old', ${JSON.stringify({
              type: "workflow.restart.stop",
              migrationId: "workflow-migration:old",
              assignmentId,
            })}, 'pending', ${now})`;

          const reopened = yield* openStore;
          const state = yield* reopened.snapshot;
          assert.equal(state.revision, legacy.revision);
          assert.deepEqual(state.managers[0]?.workflow, pinned);
          assert.deepEqual(state.assignments[0]?.workflow, pinned);
          assert.equal(state.improvementValidations[0]?.outcome, "success");
          assert.notInclude(
            (yield* reopened.pending).map((effect) => effect.id),
            "restart-old:0",
          );
          const [outbox] = yield* sql<{ readonly status: string }>`
            SELECT status FROM factory_outbox WHERE effect_id = 'restart-old:0'`;
          assert.equal(outbox?.status, "superseded");
          // New work records the current skills commit while the old team keeps its own.
          const skills = { repositoryRoot: "C:/skills", revision: "d".repeat(40) };
          const created = yield* reopened.commit({
            ...createInput,
            command: {
              ...createInput.command,
              commandId: CommandId.make("create-api-after-upgrade"),
              projectId: ProjectId.make("api"),
            },
            skills,
            allocation: {
              managerThreadId: ThreadId.make("manager-api"),
              leadThreadId: ThreadId.make("onboarding-api"),
              assignmentId: FactoryAssignmentId.make("assignment-api"),
            },
          });
          const after = yield* reopened.snapshot;
          assert.deepEqual(
            after.assignments.find((entry) => entry.id === created.assignmentId)?.workflow,
            skills,
          );
          assert.deepEqual(
            after.managers.find((entry) => entry.id === ThreadId.make("manager-api"))?.workflow,
            skills,
          );
          assert.deepEqual(after.assignments[0]?.workflow, pinned);
          // An old receipt still owns its command id, so reusing it is a conflict, not a crash.
          assertFailure(
            yield* reopened
              .commit({
                actor: { kind: "human" },
                now,
                command: {
                  type: "policy.defaults.configure",
                  commandId: CommandId.make("adopt-old"),
                  defaults: state.defaults,
                },
              })
              .pipe(Effect.result),
            "command-conflict",
          );
          // The next command builds on the decoded state and writes it without the removed arrays.
          yield* reopened.commit({
            actor: { kind: "human" },
            now,
            command: {
              type: "policy.defaults.configure",
              commandId: CommandId.make("defaults-after-upgrade"),
              defaults: state.defaults,
            },
          });
          const [rewritten] = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json FROM factory_state WHERE id = 1`;
          assert.equal(JSON.parse(rewritten!.payload_json).revision, legacy.revision + 2);
          assert.notInclude(rewritten!.payload_json, "workflowReleases");
          assert.notInclude(rewritten!.payload_json, "workflowMigrations");
        }),
      ),
  );
});
