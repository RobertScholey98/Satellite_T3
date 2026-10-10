import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, FactoryError, FactorySnapshot, MessageId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Store from "./FactoryStore.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Execution from "./FactoryExecution.ts";
import * as Handover from "./FactoryHandover.ts";
import * as IntegrationExecution from "./FactoryIntegrationExecution.ts";
import * as IntegrationEffects from "./FactoryIntegrationEffects.ts";
import { api, integrated, ready, preparationReceipt } from "./FactoryIntegration.testkit.ts";
import { deliveryIds, deliveryNow, deliverySelection } from "./FactoryDelivery.testkit.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const base = Layer.mergeAll(Store.layer, Threads.layer).pipe(
  Layer.provideMerge(Satellite.layer),
  Layer.provideMerge(NodeServices.layer),
);
const seed = (state: FactorySnapshot) =>
  Effect.gen(function* () {
    yield* (yield* SqlClient.SqlClient)`INSERT INTO factory_state(id,revision,payload_json) VALUES(1,${state.revision},${encode(state)})`;
    const threads = yield* Threads.ThreadManagementService;
    for (const projectId of [deliveryIds.project, api.project])
      yield* Satellite.recordProject({
        projectId,
        title: projectId,
        workspaceRoot: `/fixture/${projectId}`,
      });
    for (const [threadId, projectId] of [
      [deliveryIds.lead, deliveryIds.project],
      [api.lead, api.project],
      [integrated.lead, deliveryIds.project],
      [deliveryIds.manager, deliveryIds.project],
      [api.manager, api.project],
    ] as const)
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId,
        title: threadId,
        modelSelection: deliverySelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
  });
const profile = {
  boundaryId: "integration",
  dockerContext: "test",
  imageId: "test",
  projectSnapshotPath: "/isolated/integration",
  workflowSnapshotPath: "/isolated/workflow",
  runtimePath: "/runtime",
};
const external = Layer.mergeAll(
  Layer.mock(Execution.FactoryExecution)({ runtimePolicyFor: () => Effect.succeed(profile) }),
  Layer.mock(Handover.FactoryHandover)({ stopTeam: () => Effect.void }),
  Layer.mock(IntegrationExecution.FactoryIntegrationExecution)({
    stop: () => Effect.void,
    release: () => Effect.void,
  }),
);
const runtime = IntegrationEffects.layer.pipe(Layer.provide(Access.layer), Layer.provide(external));

it.effect(
  "settles a queued verification whose grant was revoked before execution and permits a later refresh",
  () =>
    Effect.gen(function* () {
      const prepared = ready();
      yield* seed(prepared.state);
      const store = yield* Store.FactoryStore;
      const requested = yield* store.commit({
        actor: { kind: "thread", threadId: integrated.lead },
        command: {
          type: "integration.verify",
          commandId: CommandId.make("verify-before-revoke"),
          integrationId: prepared.integrationId,
          preparationId: prepared.preparationId,
        },
        now: deliveryNow,
      });
      const pending = (yield* store.pending).find(
        (entry) => entry.intent.type === "integration.verify",
      )!;
      const grant = prepared.state.integrationGrants.find(
        (entry) => entry.projectId === api.project,
      )!;
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "integration.grant.revoke",
          commandId: CommandId.make("revoke-before-start"),
          grantId: grant.id,
          reason: "Renew API access",
        },
        now: deliveryNow,
      });
      let verifications = 0;
      const adapters = Layer.mergeAll(
        Layer.mock(Execution.FactoryExecution)({}),
        Layer.mock(Handover.FactoryHandover)({ stopTeam: () => Effect.void }),
        Layer.mock(IntegrationExecution.FactoryIntegrationExecution)({
          verify: () =>
            Effect.gen(function* () {
              verifications++;
              return yield* new FactoryError({
                code: "execution-unavailable",
                detail: "The obsolete verification must not run.",
              });
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const effects = yield* IntegrationEffects.FactoryIntegrationEffects;
        yield* effects.handle(pending);
        yield* effects.handle(pending);
      }).pipe(
        Effect.provide(
          IntegrationEffects.layer.pipe(Layer.provide(Access.layer), Layer.provide(adapters)),
        ),
      );
      const state = yield* store.snapshot;
      const verification = state.integrationVerifications.find(
        (entry) => entry.id === requested.integrationVerificationId,
      )!;
      assert.equal(verification.lifecycle.phase, "failed");
      if (verification.lifecycle.phase === "failed")
        assert.isNotEmpty(verification.lifecycle.reason);
      assert.equal(verifications, 0);
      assert.isFalse((yield* store.pending).some((entry) => entry.id === pending.id));
      const integration = state.integrations.find((entry) => entry.id === prepared.integrationId)!;
      yield* store.commit({
        actor: { kind: "system" },
        command: {
          type: "integration.stopped",
          commandId: CommandId.make("revocation-stopped"),
          integrationId: prepared.integrationId,
          holdId: integration.hold!.id,
        },
        now: deliveryNow,
      });
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "integration.grant",
          commandId: CommandId.make("restore-grant"),
          integrationId: prepared.integrationId,
          projectId: api.project,
          capabilityId: grant.capabilityId,
          paths: grant.paths,
        },
        now: deliveryNow,
      });
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "integration.refresh",
          commandId: CommandId.make("refresh-after-obsolete-verification"),
          integrationId: prepared.integrationId,
          expectedPreparationId: prepared.preparationId,
        },
        now: deliveryNow,
      });
      const refreshed = (yield* store.snapshot).integrations.find(
        (entry) => entry.id === prepared.integrationId,
      )!;
      assert.equal(refreshed.phase, "preparing");
      assert.notEqual(refreshed.currentPreparationId, prepared.preparationId);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "reconciles a lost integration peer ACK after owner revocation without duplicate delivery",
  () =>
    Effect.gen(function* () {
      const prepared = ready();
      yield* seed(prepared.state);
      const store = yield* Store.FactoryStore;
      const threads = yield* Threads.ThreadManagementService;
      yield* store.commit({
        actor: { kind: "thread", threadId: integrated.lead },
        command: {
          type: "integration.message.send",
          commandId: CommandId.make("message"),
          integrationId: prepared.integrationId,
          fromAssignmentId: integrated.assignment,
          toAssignmentId: api.assignment,
          text: "Please incorporate the fixture patch",
        },
        now: deliveryNow,
      });
      const pending = (yield* store.pending).find(
        (entry) => entry.intent.type === "integration.message.deliver",
      )!;
      let sends = 0;
      const intercepted = Layer.succeed(Threads.ThreadManagementService, {
        ...threads,
        sendToThread: (input) =>
          Effect.gen(function* () {
            sends++;
            yield* threads.sendToThread(input);
            yield* store
              .commit({
                actor: { kind: "human" },
                command: {
                  type: "integration.grant.revoke",
                  commandId: CommandId.make("withdraw-grant"),
                  grantId: prepared.state.integrationGrants.find(
                    (entry) => entry.projectId === api.project,
                  )!.id,
                  reason: "Production incident",
                },
                now: deliveryNow,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new Threads.ThreadManagementProjectionLoadError({
                      projectId: input.projectId,
                      threadId: input.threadId,
                      cause,
                    }),
                ),
              );
            return yield* new Threads.ThreadManagementProjectionLoadError({
              projectId: input.projectId,
              threadId: input.threadId,
              cause: "Lost ACK",
            });
          }),
      });
      yield* Effect.gen(function* () {
        const effects = yield* IntegrationEffects.FactoryIntegrationEffects;
        yield* effects.handle(pending);
        yield* effects.handle(pending);
      }).pipe(Effect.provide(runtime.pipe(Layer.provide(intercepted))));
      assert.equal((yield* store.snapshot).integrationMessages[0]!.delivery.phase, "delivered");
      assert.equal(sends, 1);
      assert.equal(
        (yield* threads.getThreadRecords(api.lead, ["messages"])).messages.filter(
          (entry) => entry.text === "Please incorporate the fixture patch",
        ).length,
        1,
      );
      assert.isFalse((yield* store.pending).some((entry) => entry.id === pending.id));
    }).pipe(Effect.provide(base)),
);

it.effect("captures pre-verification queues and keeps them held during human takeover", () =>
  Effect.gen(function* () {
    const prepared = ready();
    yield* seed(prepared.state);
    const store = yield* Store.FactoryStore;
    const threads = yield* Threads.ThreadManagementService;
    yield* threads.sendToThread({
      projectId: deliveryIds.project,
      threadId: integrated.lead,
      text: "Active QA",
      commandId: CommandId.make("active"),
      messageId: MessageId.make("active"),
      attachments: [],
      mode: "queue",
      createdBy: "system",
      creationSource: "server",
    });
    const sent = yield* threads.sendToThread({
      projectId: deliveryIds.project,
      threadId: integrated.lead,
      text: "Continue QA after verification",
      commandId: CommandId.make("queued"),
      messageId: MessageId.make("queued"),
      attachments: [],
      mode: "queue",
      createdBy: "system",
      creationSource: "server",
    });
    yield* store.commit({
      actor: { kind: "thread", threadId: integrated.lead },
      command: {
        type: "integration.verify",
        commandId: CommandId.make("verify"),
        integrationId: prepared.integrationId,
        preparationId: prepared.preparationId,
      },
      now: deliveryNow,
    });
    const pending = (yield* store.pending).find(
      (entry) => entry.intent.type === "integration.verify",
    )!;
    const adapters = Layer.mergeAll(
      Layer.mock(Execution.FactoryExecution)({ runtimePolicyFor: () => Effect.succeed(profile) }),
      Layer.mock(Handover.FactoryHandover)({
        stopTeam: () =>
          threads
            .dispatch({
              type: "thread.stop",
              commandId: CommandId.make("hold-queue"),
              threadId: integrated.lead,
              reason: "Pause for combined verification",
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) => new FactoryError({ code: "execution-unavailable", cause }),
              ),
            ),
      }),
      Layer.mock(IntegrationExecution.FactoryIntegrationExecution)({
        stop: () => Effect.void,
        release: () => Effect.void,
        verify: ({ verificationId }) =>
          Effect.succeed({
            verificationId,
            result: "passed",
            testArtifact: { ...prepared.artifact, id: "verified-tests" },
            hostArtifactId: "host",
            checks: [
              { id: "combined", status: "passed", exitCode: 0, output: "Both projects work" },
            ],
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const effects = yield* IntegrationEffects.FactoryIntegrationEffects;
      yield* effects.handle(pending);
      const verification = (yield* store.snapshot).integrationVerifications[0]!;
      assert.isTrue(
        verification.resumeQueues?.some((entry) => entry.runIds.includes(sent.run.id)) ||
          verification.resumeThreadIds?.includes(integrated.lead),
      );
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "thread.takeover",
          commandId: CommandId.make("takeover"),
          threadId: integrated.lead,
        },
        controlTarget: {
          threadId: integrated.lead,
          assignmentId: integrated.assignment,
          managerId: deliveryIds.manager,
          projectId: deliveryIds.project,
          ancestorThreadIds: [],
        },
        now: deliveryNow,
      });
      const resume = (yield* store.pending).find(
        (entry) => entry.intent.type === "integration.resume",
      )!;
      yield* effects.handle(resume);
      assert.isTrue((yield* store.pending).some((entry) => entry.id === resume.id));
      assert.equal(
        (yield* threads.getThreadRecords(integrated.lead, ["runs"])).runs.find(
          (entry) => entry.id === sent.run.id,
        )?.queueHeld,
        true,
      );
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "thread.handback",
          commandId: CommandId.make("handback"),
          threadId: integrated.lead,
        },
        now: deliveryNow,
      });
      yield* effects.handle(resume);
      assert.isFalse((yield* store.pending).some((entry) => entry.id === resume.id));
      assert.equal(
        (yield* threads.getThreadRecords(integrated.lead, ["runs"])).runs.find(
          (entry) => entry.id === sent.run.id,
        )?.queueHeld,
        false,
      );
      assert.isDefined(
        (yield* store.snapshot).integrationVerifications.find(
          (entry) => entry.id === verification.id,
        )?.resumedAt,
      );
      yield* effects.handle(resume);
      assert.isAtMost(
        (yield* threads.getThreadRecords(integrated.lead, ["messages"])).messages.filter((entry) =>
          entry.text.startsWith("Integration verification"),
        ).length,
        1,
      );
    }).pipe(
      Effect.provide(
        IntegrationEffects.layer.pipe(Layer.provide(Access.layer), Layer.provide(adapters)),
      ),
    );
  }).pipe(Effect.provide(base)),
);

it.effect(
  "a late physical stop receipt cannot stop the provider team after a refreshed preparation",
  () =>
    Effect.gen(function* () {
      const prepared = ready();
      yield* seed(prepared.state);
      const store = yield* Store.FactoryStore;
      const grant = prepared.state.integrationGrants.find(
        (entry) => entry.projectId === api.project,
      )!;
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "integration.grant.revoke",
          commandId: CommandId.make("revoke"),
          grantId: grant.id,
          reason: "Renew access",
        },
        now: deliveryNow,
      });
      const stale = (yield* store.pending).find(
        (entry) => entry.intent.type === "integration.stop",
      )!;
      if (stale.intent.type !== "integration.stop") throw new Error("Expected integration stop");
      const stopStarted = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      const stoppedPreparations: Array<string | null | undefined> = [];
      let providerStops = 0;
      const adapters = Layer.mergeAll(
        Layer.mock(Execution.FactoryExecution)({}),
        Layer.mock(Handover.FactoryHandover)({
          stopTeam: () =>
            Effect.sync(() => {
              providerStops++;
            }),
        }),
        Layer.mock(IntegrationExecution.FactoryIntegrationExecution)({
          stop: (input) =>
            Effect.gen(function* () {
              stoppedPreparations.push(input.preparationId);
              yield* Deferred.succeed(stopStarted, undefined);
              yield* Deferred.await(releaseStop);
            }),
        }),
      );
      const stopping = yield* Effect.gen(function* () {
        yield* (yield* IntegrationEffects.FactoryIntegrationEffects).handle(stale);
      }).pipe(
        Effect.provide(
          IntegrationEffects.layer.pipe(Layer.provide(Access.layer), Layer.provide(adapters)),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(stopStarted);
      yield* store.commit({
        actor: { kind: "system" },
        command: {
          type: "integration.stopped",
          commandId: CommandId.make("confirmed"),
          integrationId: prepared.integrationId,
          holdId: stale.intent.holdId,
        },
        now: deliveryNow,
      });
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "integration.grant",
          commandId: CommandId.make("regrant"),
          integrationId: prepared.integrationId,
          projectId: api.project,
          capabilityId: grant.capabilityId,
          paths: grant.paths,
        },
        now: deliveryNow,
      });
      yield* store.commit({
        actor: { kind: "human" },
        command: {
          type: "integration.refresh",
          commandId: CommandId.make("refresh"),
          integrationId: prepared.integrationId,
          expectedPreparationId: prepared.preparationId,
        },
        now: deliveryNow,
      });
      const refreshed = preparationReceipt(yield* store.snapshot, prepared.integrationId);
      yield* store.commit({
        actor: { kind: "system" },
        command: {
          type: "integration.prepared",
          commandId: CommandId.make("new-preparation"),
          integrationId: prepared.integrationId,
          preparationId: refreshed.preparationId,
          manifest: refreshed.manifest,
          profileId: "new-profile",
          testArtifact: refreshed.artifact,
        },
        now: deliveryNow,
      });
      yield* Deferred.succeed(releaseStop, undefined);
      yield* Fiber.join(stopping);
      assert.deepEqual(stoppedPreparations, [prepared.preparationId]);
      assert.equal(providerStops, 0);
      assert.equal(
        (yield* store.snapshot).integrations[0]!.currentPreparationId,
        refreshed.preparationId,
      );
      assert.isFalse((yield* store.pending).some((entry) => entry.id === stale.id));
    }).pipe(Effect.provide(base)),
);

it.effect(
  "an urgent grant revocation physically stops a verification before its serialized work completes",
  () =>
    Effect.gen(function* () {
      const prepared = ready();
      yield* seed(prepared.state);
      const store = yield* Store.FactoryStore;
      const started = yield* Deferred.make<void>();
      const physicallyStopped = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      yield* store.commit({
        actor: { kind: "thread", threadId: integrated.lead },
        command: {
          type: "integration.verify",
          commandId: CommandId.make("verify"),
          integrationId: prepared.integrationId,
          preparationId: prepared.preparationId,
        },
        now: deliveryNow,
      });
      const pending = (yield* store.pending).find(
        (entry) => entry.intent.type === "integration.verify",
      )!;
      const adapters = Layer.mergeAll(
        Layer.mock(Execution.FactoryExecution)({}),
        Layer.mock(Handover.FactoryHandover)({ stopTeam: () => Effect.void }),
        Layer.mock(IntegrationExecution.FactoryIntegrationExecution)({
          stop: (input) =>
            input.holdId.startsWith("integration-hold:")
              ? Deferred.succeed(physicallyStopped, undefined).pipe(Effect.asVoid)
              : Effect.void,
          verify: ({ verificationId }) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(finish);
              return {
                verificationId,
                result: "stopped" as const,
                testArtifact: prepared.artifact,
                hostArtifactId: "stopped-host",
                checks: [],
              };
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const effects = yield* IntegrationEffects.FactoryIntegrationEffects;
        const verification = yield* effects.handle(pending).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        yield* store.commit({
          actor: { kind: "human" },
          command: {
            type: "integration.grant.revoke",
            commandId: CommandId.make("urgent-revoke"),
            grantId: prepared.state.integrationGrants.find(
              (entry) => entry.projectId === api.project,
            )!.id,
            reason: "Production incident",
          },
          now: deliveryNow,
        });
        const stop = (yield* store.pending).find(
          (entry) => entry.intent.type === "integration.stop",
        )!;
        const stopping = yield* effects.handle(stop).pipe(Effect.forkChild);
        yield* Deferred.await(physicallyStopped);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(verification);
        yield* Fiber.join(stopping);
        assert.equal((yield* store.snapshot).integrations[0]!.hold?.status, "confirmed");
        assert.equal((yield* store.snapshot).integrations[0]!.phase, "blocked");
      }).pipe(
        Effect.provide(
          IntegrationEffects.layer.pipe(Layer.provide(Access.layer), Layer.provide(adapters)),
        ),
      );
    }).pipe(Effect.provide(base)),
);
