import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  IssueOperationError,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { IssueService, makeIssueService } from "./IssueService.ts";
import { make, recoverStartedIssueAttempts } from "./IssueLifecycleReactor.ts";
import { OrchestrationEngineService } from "../orchestration-v2/SatelliteOrchestration.ts";
import { ProjectionSnapshotQuery } from "../orchestration-v2/SatelliteOrchestration.ts";

describe("issue launch recovery", () => {
  it.effect(
    "records work acceptance without issuing lifecycle receipts for background agents",
    () =>
      Effect.gen(function* () {
        const sourceEnvironmentId = EnvironmentId.make("source");
        const destinationEnvironmentId = EnvironmentId.make("destination");
        const projectId = ProjectId.make("destination-project");
        const unavailable = Effect.fail(
          new IssueOperationError({
            reason: "unavailable",
            message: "The destination must not contact the issue host.",
          }),
        );
        const service = yield* makeIssueService({
          environmentId: destinationEnvironmentId,
          getProject: () => Effect.succeed(null),
          host: {
            list: () => unavailable,
            get: () => unavailable,
            listBoards: () => unavailable,
            board: () => unavailable,
            move: () => unavailable,
          },
        });
        const now = "2026-09-30T12:00:00Z";
        const threads: OrchestrationThreadShell[] = [];
        const events: OrchestrationEvent[] = [];
        for (const purpose of ["idea", "revdoc", "work"] as const) {
          const threadId = ThreadId.make(purpose);
          threads.push({
            id: threadId,
            purpose,
            projectId,
            title: purpose,
            modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            pullRequests: [],
            latestTurn: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            session: null,
            latestUserMessageAt: now,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
          });
          yield* service.attachAttempt({
            link: {
              attemptId: purpose,
              reservationId: `reservation-${purpose}`,
              boardId: "board",
              sourceEnvironmentId,
              destinationEnvironmentId,
              sourceProjectId: projectId,
              sourceGeneration: 0,
              issue: {
                hostKind: "github",
                host: "github.com",
                repository: "owner/repo",
                id: purpose,
                number: 1,
                url: "https://github.com/owner/repo/issues/1",
              },
            },
            threadId,
            projectId,
            worktreePath: `/work/${purpose}`,
          });
          events.push({
            type: "thread.session-set",
            sequence: events.length + 1,
            eventId: EventId.make(purpose),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            payload: {
              threadId,
              providerAccepted: true,
              session: {
                threadId,
                status: "running",
                activeTurnId: TurnId.make(purpose),
                lastError: null,
                updatedAt: now,
              },
            },
          });
        }
        const enqueued = yield* Deferred.make<void>();
        const reactor = yield* make.pipe(
          Effect.provideService(IssueService, service),
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(OrchestrationEngineService, {
                subscribeDomainEvents: Effect.succeed(
                  Stream.fromIterable(events).pipe(
                    Stream.ensuring(Deferred.succeed(enqueued, undefined)),
                  ),
                ),
              }),
              Layer.mock(ProjectionSnapshotQuery, {
                getThreadShellById: (id) =>
                  Effect.succeed(
                    Option.fromUndefinedOr(threads.find((thread) => thread.id === id)),
                  ),
                listThreadsWithPullRequests: () => Effect.succeed([]),
              }),
            ),
          ),
        );
        yield* reactor.start();
        yield* Deferred.await(enqueued);
        yield* reactor.drain;
        const receipts = yield* service.listReceipts({});
        assert.deepEqual(
          receipts.receipts.map((receipt) => [receipt.kind, receipt.threadId]),
          [["started", ThreadId.make("work")]],
        );
        const attempts = yield* service.listAttempts({});
        assert.equal(attempts.find((attempt) => attempt.threadId === "idea")?.status, "attached");
        assert.equal(attempts.find((attempt) => attempt.threadId === "work")?.status, "started");
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "recovers a lost post-send hook from durable provider acceptance, excludes queued work, and emits once across restart",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sourceEnvironmentId = EnvironmentId.make("source");
        const destinationEnvironmentId = EnvironmentId.make("destination");
        const projectId = ProjectId.make("destination-project");
        const unavailable = Effect.fail(
          new IssueOperationError({
            reason: "unavailable",
            message: "Host should not run during destination recovery.",
          }),
        );
        const options = {
          environmentId: destinationEnvironmentId,
          getProject: () => Effect.succeed(null),
          host: {
            list: () => unavailable,
            get: () => unavailable,
            listBoards: () => unavailable,
            board: () => unavailable,
            move: () => unavailable,
          },
        };
        const service = yield* makeIssueService(options);
        for (const id of ["accepted", "queued", "id-without-start", "start-without-id"]) {
          yield* service.attachAttempt({
            link: {
              attemptId: id,
              reservationId: `reservation-${id}`,
              boardId: "board",
              sourceEnvironmentId,
              destinationEnvironmentId,
              sourceProjectId: ProjectId.make("source-project"),
              sourceGeneration: 0,
              issue: {
                hostKind: "github",
                host: "github.com",
                repository: "owner/repo",
                id: id,
                number: 1,
                url: "https://github.com/owner/repo/issues/1",
              },
            },
            threadId: ThreadId.make(id),
            projectId,
            worktreePath: `/work/${id}`,
          });
          yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,payload_json,created_at,updated_at)
            VALUES(${id},${projectId},${id},'claude','approval-required','default','{"purpose":"work"}','2026-09-30T12:00:00Z','2026-09-30T12:00:00Z')`;
          if (id !== "start-without-id")
            yield* sql`INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,ordinal,status,started_at,payload_json)
            VALUES(${`provider-${id}`},${id},${`native-${id}`},${`node-${id}`},1,${id === "queued" ? "pending" : "running"},${id === "queued" || id === "id-without-start" ? null : "2026-09-30T12:00:01Z"},'{}')`;
        }
        const restarted = yield* makeIssueService(options);
        yield* recoverStartedIssueAttempts(restarted.firstPromptSent);
        const receipts = yield* restarted.listReceipts({});
        assert.deepEqual(
          receipts.receipts.map((receipt) => [receipt.kind, receipt.threadId]),
          [["started", ThreadId.make("accepted")]],
        );
        yield* recoverStartedIssueAttempts(restarted.firstPromptSent);
        assert.equal((yield* restarted.listReceipts({})).receipts.length, 1);
        const attempts = yield* restarted.listAttempts({});
        assert.equal(
          attempts.find((attempt) => attempt.threadId === "accepted")?.status,
          "started",
        );
        assert.equal(attempts.find((attempt) => attempt.threadId === "queued")?.status, "attached");
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
