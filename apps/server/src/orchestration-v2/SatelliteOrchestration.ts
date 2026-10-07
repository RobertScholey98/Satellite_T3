import {
  EventId,
  RuntimeRequestId,
  TurnId,
  OrchestrationGetRequestLifecycleError,
  OrchestrationThreadActivity as ActivitySchema,
  ORCHESTRATION_REQUEST_LIFECYCLE_MAX_ROW_BYTES,
  type CommitRecommendation,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationGetRequestLifecycleInput,
  type OrchestrationGetRequestLifecycleResult,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  OrchestrationV2ThreadShellJson,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

const encodeShell = Schema.encodeSync(OrchestrationV2ThreadShellJson);
const encodeActivity = Schema.encodeSync(Schema.fromJsonString(ActivitySchema));
const isLifecycleError = Schema.is(OrchestrationGetRequestLifecycleError);
const decodeTurnItem = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

function sessionForRun(threadId: ThreadId, run: OrchestrationV2Run): OrchestrationSession {
  return {
    threadId,
    status:
      run.status === "failed"
        ? "error"
        : run.status === "interrupted"
          ? "interrupted"
          : run.status === "cancelled"
            ? "stopped"
            : ["starting", "running", "waiting"].includes(run.status)
              ? "running"
              : "ready",
    activeTurnId: TurnId.make(run.id),
    lastError: null,
    updatedAt: DateTime.formatIso(run.completedAt ?? run.startedAt ?? run.requestedAt),
  };
}

export function runtimeRequestActivity(
  request: OrchestrationV2RuntimeRequest,
  item?: Extract<OrchestrationV2TurnItem, { readonly type: "user_input_request" }>,
  requested = false,
): OrchestrationThreadActivity {
  const question = request.kind === "user_input";
  const state =
    requested || request.status === "pending"
      ? "requested"
      : request.status === "resolved"
        ? "resolved"
        : "cancelled";
  return {
    id: EventId.make(`${request.id}:${state}`),
    tone: "approval",
    kind: `${question ? "user-input" : "approval"}.${state}`,
    summary: question ? "Question for the user" : "Approval request",
    payload: {
      requestId: request.id,
      status: request.status,
      responseCapability: request.responseCapability,
      ...(item === undefined ? {} : { questions: item.questions }),
      ...(requested || request.answers === undefined ? {} : { answers: request.answers }),
      ...(requested || request.decision === undefined ? {} : { decision: request.decision }),
    },
    turnId: request.providerTurnId === null ? null : TurnId.make(request.providerTurnId),
    createdAt: DateTime.formatIso(
      requested ? request.createdAt : (request.resolvedAt ?? request.createdAt),
    ),
  };
}

function requestActivities(
  request: OrchestrationV2RuntimeRequest,
  item?: Extract<OrchestrationV2TurnItem, { readonly type: "user_input_request" }>,
): readonly OrchestrationThreadActivity[] {
  return request.status === "pending"
    ? [runtimeRequestActivity(request, item)]
    : [runtimeRequestActivity(request, item, true), runtimeRequestActivity(request)];
}

/** Satellite's notebooks and review services consume these views, never a V1 engine. */
export function satelliteEvents(stored: OrchestrationV2StoredEvent): readonly OrchestrationEvent[] {
  if (stored.event.id.startsWith("migration:v1:")) return [];
  const event = stored.event;
  const base = {
    sequence: stored.sequence,
    eventId: event.id,
    aggregateKind: "thread" as const,
    aggregateId: event.threadId,
    occurredAt: DateTime.formatIso(event.occurredAt),
  };
  switch (event.type) {
    case "idea.changed":
      return [{ ...base, type: event.type, payload: event.payload }];
    case "idea.purged":
      return [{ ...base, type: event.type, payload: event.payload }];
    case "thread.created":
      return [
        {
          ...base,
          type: "thread.created",
          payload: { threadId: event.threadId, purpose: event.payload.purpose },
        },
      ];
    case "thread.deleted":
      return [{ ...base, type: "thread.deleted", payload: { threadId: event.threadId } }];
    case "run.created":
    case "run.updated": {
      const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(
        event.payload.status,
      );
      return [
        {
          ...base,
          type: "thread.session-set",
          payload: {
            threadId: event.threadId,
            session: sessionForRun(event.threadId, event.payload),
            turnSettled: terminal,
          },
        },
      ];
    }
    case "message.updated":
      return [
        {
          ...base,
          type: "thread.message-sent",
          payload: {
            threadId: event.threadId,
            messageId: event.payload.id,
            role: event.payload.role,
            text: event.payload.text,
            streaming: false,
          },
        },
      ];
    case "provider-turn.updated":
      return event.payload.startedAt === null || event.payload.status !== "running"
        ? []
        : [
            {
              ...base,
              type: "thread.session-set",
              payload: {
                threadId: event.threadId,
                providerAccepted: true,
                session: {
                  threadId: event.threadId,
                  status: "running",
                  activeTurnId: TurnId.make(event.payload.id),
                  lastError: null,
                  updatedAt: DateTime.formatIso(event.payload.startedAt),
                },
              },
            },
          ];
    case "runtime-request.updated":
      return [
        {
          ...base,
          type: "thread.activity-appended",
          payload: {
            threadId: event.threadId,
            activity: { ...runtimeRequestActivity(event.payload), sequence: stored.sequence },
          },
        },
      ];
    case "turn-item.updated":
      return event.payload.type !== "user_input_request"
        ? []
        : [
            {
              ...base,
              type: "thread.activity-appended",
              payload: {
                threadId: event.threadId,
                activity: {
                  id: EventId.make(`${event.payload.requestId}:requested`),
                  tone: "approval",
                  kind: "user-input.requested",
                  summary: "Question for the user",
                  payload: {
                    requestId: event.payload.requestId,
                    questions: event.payload.questions,
                  },
                  turnId:
                    event.payload.providerTurnId === null
                      ? null
                      : TurnId.make(event.payload.providerTurnId),
                  createdAt: DateTime.formatIso(event.payload.startedAt ?? event.payload.updatedAt),
                  sequence: stored.sequence,
                },
              },
            },
          ];
    case "thread.pull-request-synced":
    case "thread.metadata-updated":
      return [
        { ...base, type: "thread.meta-updated", payload: { threadId: event.threadId } },
        ...(event.payload.pullRequests ?? []).flatMap((link): readonly OrchestrationEvent[] =>
          link.snapshot === null
            ? []
            : [
                {
                  ...base,
                  eventId: EventId.make(
                    `${event.id}:${link.host}:${link.repository}:${link.number}`,
                  ),
                  type: "thread.pull-request-synced",
                  payload: { threadId: event.threadId, ...link, snapshot: link.snapshot },
                },
              ],
        ),
      ];
    default:
      return [];
  }
}

export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  {
    readonly dispatch: (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }, Orchestrator.OrchestratorV2Error>;
    readonly subscribeDomainEvents: Effect.Effect<
      Stream.Stream<OrchestrationEvent>,
      never,
      Scope.Scope
    >;
    readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;
    readonly latestSequence: Effect.Effect<number>;
  }
>()("t3/orchestration-v2/SatelliteOrchestration/OrchestrationEngineService") {}
export type OrchestrationEngineShape = OrchestrationEngineService["Service"];

export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  {
    readonly getThreadShellById: (
      threadId: ThreadId,
    ) => Effect.Effect<
      Option.Option<OrchestrationThreadShell>,
      ProjectionStore.ProjectionStoreV2Error
    >;
    readonly getThreadDetailById: (
      threadId: ThreadId,
      options?: { readonly activityKinds?: readonly string[] },
    ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionStore.ProjectionStoreV2Error>;
    readonly getThreadDetailSnapshot: (
      threadId: ThreadId,
      options?: { readonly turnLimit?: number },
    ) => Effect.Effect<
      Option.Option<{
        readonly thread: OrchestrationThread;
        readonly page?: { readonly hasMore: boolean };
      }>,
      ProjectionStore.ProjectionStoreV2Error
    >;
    readonly getProjectShellById: (
      projectId: ProjectId,
    ) => ReturnType<ProjectStore.ProjectStoreV2["Service"]["getShell"]>;
    readonly getProjectShells: () => Effect.Effect<
      readonly OrchestrationProjectShell[],
      ProjectStore.ProjectStoreV2Error
    >;
    readonly listThreadsWithPullRequests: () => ReturnType<
      ProjectionStore.ProjectionStoreV2["Service"]["getThreadsWithPullRequests"]
    >;
    readonly listThreadsWithCommitRecommendations: () => Effect.Effect<
      readonly { readonly id: ThreadId; readonly commitRecommendation: CommitRecommendation }[],
      ProjectionStore.ProjectionStoreV2Error
    >;
    readonly getRequestLifecycle: (
      input: OrchestrationGetRequestLifecycleInput,
    ) => Effect.Effect<
      OrchestrationGetRequestLifecycleResult,
      OrchestrationGetRequestLifecycleError
    >;
    readonly getUserInputActivity: (input: {
      readonly threadId: ThreadId;
      readonly requestId: RuntimeRequestId;
    }) => Effect.Effect<
      Option.Option<OrchestrationThreadActivity>,
      ProjectionStore.ProjectionStoreV2Error
    >;
  }
>()("t3/orchestration-v2/SatelliteOrchestration/ProjectionSnapshotQuery") {}
export type ProjectionSnapshotQueryShape = ProjectionSnapshotQuery["Service"];

const queryLayer = Layer.effect(
  ProjectionSnapshotQuery,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const getRequestItem = (threadId: ThreadId, requestId: RuntimeRequestId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId} AND json_extract(payload_json, '$.requestId') = ${requestId} AND json_extract(payload_json, '$.type') = 'user_input_request' ORDER BY ordinal DESC LIMIT 1`;
        if (rows[0] === undefined) return undefined;
        const item = yield* decodeTurnItem(rows[0].payload_json);
        return item.type === "user_input_request" ? item : undefined;
      }).pipe(
        Effect.mapError(
          (cause) => new ProjectionStore.ProjectionStoreReadError({ threadId, cause }),
        ),
      );
    const toShell = (shell: Parameters<typeof encodeShell>[0]): OrchestrationThreadShell => {
      const value = encodeShell(shell);
      return {
        id: shell.id,
        projectId: shell.projectId,
        title: shell.title,
        purpose: shell.purpose ?? "work",
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        branch: shell.branch,
        worktreePath: shell.worktreePath,
        commitRecommendation: shell.commitRecommendation ?? null,
        linkedPullRequest: shell.linkedPullRequest ?? null,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        archivedAt: value.archivedAt,
        settledAt: value.settledAt,
        settledOverride: shell.settledOverride,
        latestUserMessageAt: value.latestUserMessageAt,
        hasActionableProposedPlan: shell.hasActionableProposedPlan,
        ...(shell.titleRegeneration == null
          ? {}
          : {
              titleRegeneration: {
                requestId: shell.titleRegeneration.requestId,
                startedAt: DateTime.formatIso(shell.titleRegeneration.startedAt),
              },
            }),
        pullRequests: shell.pullRequests ?? [],
        latestTurn:
          shell.latestRunId === null
            ? null
            : {
                turnId: TurnId.make(shell.latestRunId),
                state:
                  shell.status === "failed"
                    ? "error"
                    : shell.status === "interrupted"
                      ? "interrupted"
                      : shell.status === "completed"
                        ? "completed"
                        : "running",
                requestedAt: value.latestRunRequestedAt ?? value.updatedAt,
                startedAt: value.latestRunStartedAt ?? null,
                completedAt: value.latestRunCompletedAt ?? null,
                assistantMessageId: null,
              },
        session:
          shell.latestRunId === null
            ? null
            : {
                threadId: shell.id,
                status:
                  shell.status === "failed"
                    ? "error"
                    : shell.status === "cancelled"
                      ? "stopped"
                      : shell.status === "interrupted"
                        ? "interrupted"
                        : shell.status === "completed"
                          ? "ready"
                          : "running",
                activeTurnId: TurnId.make(shell.latestRunId),
                lastError: shell.lastError ?? null,
                updatedAt: value.updatedAt,
              },
        hasPendingApprovals:
          shell.pendingRuntimeRequest !== null && shell.pendingRuntimeRequest.kind !== "user_input",
        hasPendingUserInput: shell.pendingRuntimeRequest?.kind === "user_input",
      };
    };
    const getThreadShellById = (threadId: ThreadId) =>
      projections
        .getThreadShell(threadId)
        .pipe(
          Effect.map((shell) => (shell === null ? Option.none() : Option.some(toShell(shell)))),
        );
    const getThreadDetailById = (
      threadId: ThreadId,
      options?: { readonly activityKinds?: readonly string[] },
    ) =>
      Effect.gen(function* () {
        const shell = yield* getThreadShellById(threadId);
        if (Option.isNone(shell)) return Option.none();
        const projection = yield* projections.getThreadProjection(threadId);
        const messages = projection.messages.map((message): OrchestrationMessage => ({
          id: message.id,
          role: message.role,
          text: message.text,
          attachments: message.attachments,
          turnId: message.runId === null ? null : TurnId.make(message.runId),
          streaming: false,
          createdAt: DateTime.formatIso(message.createdAt),
          updatedAt: DateTime.formatIso(message.updatedAt),
        }));
        const activities = projection.runtimeRequests
          .flatMap((request) =>
            requestActivities(
              request,
              projection.turnItems.find(
                (
                  item,
                ): item is Extract<
                  OrchestrationV2TurnItem,
                  { readonly type: "user_input_request" }
                > => item.type === "user_input_request" && item.requestId === request.id,
              ),
            ),
          )
          .filter(
            (activity) =>
              options?.activityKinds === undefined || options.activityKinds.includes(activity.kind),
          );
        return Option.some({
          ...shell.value,
          messages,
          activities,
          proposedPlans: projection.plans.flatMap((plan) =>
            plan.kind === "proposed_plan" ? [{ planMarkdown: plan.markdown }] : [],
          ),
        });
      });
    return ProjectionSnapshotQuery.of({
      getThreadShellById,
      getThreadDetailById,
      getThreadDetailSnapshot: (threadId) =>
        getThreadDetailById(threadId).pipe(Effect.map(Option.map((thread) => ({ thread })))),
      getProjectShellById: projects.getShell,
      getProjectShells: () => projects.listShells(),
      listThreadsWithPullRequests: () => projections.getThreadsWithPullRequests(),
      listThreadsWithCommitRecommendations: () =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND json_extract(payload_json, '$.commitRecommendation') IS NOT NULL`;
          const threads = yield* Effect.forEach(rows, (row) =>
            projections.getThread(ThreadId.make(row.thread_id)),
          );
          return threads.flatMap((thread) =>
            thread.commitRecommendation
              ? [{ id: thread.id, commitRecommendation: thread.commitRecommendation }]
              : [],
          );
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectionStore.ProjectionStoreReadError({
                threadId: ThreadId.make("thread:commit-recommendations"),
                cause,
              }),
          ),
        ),
      getUserInputActivity: ({ threadId, requestId }) =>
        Effect.gen(function* () {
          const request = yield* projections.getRuntimeRequest(threadId, requestId);
          if (request === undefined || request.kind !== "user_input") return Option.none();
          return Option.some(
            runtimeRequestActivity(request, yield* getRequestItem(threadId, requestId), true),
          );
        }),
      getRequestLifecycle: (input) =>
        Effect.gen(function* () {
          const thread = yield* projections.getThreadShell(input.threadId);
          if (
            thread === null ||
            thread.archivedAt !== null ||
            (thread.purpose ?? "work") !== input.audience
          )
            return yield* new OrchestrationGetRequestLifecycleError({
              reason: "thread-unavailable",
            });
          const request = yield* projections.getRuntimeRequest(input.threadId, input.requestId);
          if (
            request === undefined ||
            request.kind === "auth_refresh" ||
            request.kind === "dynamic_tool_call" ||
            (request.kind === "user_input" ? "question" : "approval") !== input.kind
          )
            return [];
          const activities = [
            runtimeRequestActivity(
              request,
              request.status === "pending"
                ? yield* getRequestItem(input.threadId, input.requestId)
                : undefined,
            ),
          ];
          if (
            activities.some(
              (activity) =>
                Buffer.byteLength(encodeActivity(activity), "utf8") >
                ORCHESTRATION_REQUEST_LIFECYCLE_MAX_ROW_BYTES,
            )
          )
            return yield* new OrchestrationGetRequestLifecycleError({
              reason: "payload-too-large",
            });
          return activities;
        }).pipe(
          Effect.mapError((cause) =>
            isLifecycleError(cause)
              ? cause
              : new OrchestrationGetRequestLifecycleError({ reason: "query-failed" }),
          ),
        ),
    });
  }),
);

const commandLayer = Layer.effect(
  OrchestrationEngineService,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const translate = (
      stream: Stream.Stream<OrchestrationV2StoredEvent, EventSink.EventSinkV2Error>,
    ) =>
      stream.pipe(
        Stream.flatMap((stored) => Stream.fromIterable(satelliteEvents(stored))),
        Stream.catch(() => Stream.empty),
      );
    const subscribeDomainEvents = eventSink.latestSequence().pipe(
      Effect.orDie,
      Effect.map((afterSequence) => translate(eventSink.stream({ afterSequence }))),
    );
    return OrchestrationEngineService.of({
      dispatch: Effect.fn("SatelliteOrchestration.dispatch")(function* (command) {
        let result: Orchestrator.OrchestratorV2DispatchResult;
        switch (command.type) {
          case "thread.turn.start":
            result = yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: command.commandId,
              threadId: command.threadId,
              messageId: command.message.messageId,
              text: command.message.text,
              attachments: [...command.message.attachments],
              ...(command.message.context === undefined
                ? {}
                : { context: command.message.context }),
              ...(command.modelSelection === undefined
                ? {}
                : { modelSelection: command.modelSelection }),
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "server",
            });
            break;
          case "thread.turn.interrupt":
            result = yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId: command.commandId,
              threadId: command.threadId,
            });
            break;
          case "thread.meta.update":
            result = yield* orchestrator.dispatch({ ...command, type: "thread.metadata.update" });
            break;
          case "thread.title.generate.complete": {
            const shell = yield* orchestrator.getThreadShell(command.threadId);
            if (shell?.title !== command.expectedTitle)
              return { sequence: yield* eventSink.latestSequence().pipe(Effect.orDie) };
            result = yield* orchestrator.dispatch({
              type: "thread.metadata.update",
              commandId: command.commandId,
              threadId: command.threadId,
              title: command.title,
            });
            break;
          }
          case "thread.create":
            result = yield* orchestrator.dispatch({
              ...command,
              createdBy: "createdBy" in command ? command.createdBy : "system",
              creationSource: "creationSource" in command ? command.creationSource : "server",
            });
            break;
          default:
            result = yield* orchestrator.dispatch(command);
        }
        return { sequence: result.sequence };
      }),
      subscribeDomainEvents,
      streamDomainEvents: Stream.unwrap(subscribeDomainEvents),
      latestSequence: eventSink.latestSequence().pipe(Effect.orDie),
    });
  }),
);

export const layer = Layer.merge(queryLayer, commandLayer);
