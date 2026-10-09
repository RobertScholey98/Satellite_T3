import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  RunId,
  TurnItemId,
  type ThreadId,
  type ProjectId,
  type ProviderInstanceId,
  type OrchestrationV2UserInputQuestion,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { IdeaNotebookStore } from "../../ideas/IdeaNotebookStore.ts";
import * as EventStore from "../EventStore.ts";
import * as EventSink from "../EventSink.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as SatelliteOrchestration from "../SatelliteOrchestration.ts";
import { layerWithRegistry } from "./ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LegacyV1ThreadImporter from "../legacy/LegacyV1ThreadImporter.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ThreadSearch from "../ThreadSearch.ts";
import type { ProviderAdapterV2Shape } from "../ProviderAdapter.ts";

const database = SqlitePersistence.layerMemory;
export const makeProviderAdapter = (
  instanceId: ProviderInstanceId,
  driver = ProviderDriverKind.make("codex"),
): ProviderAdapterV2Shape => ({
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Unexpected provider execution in Satellite feature test"),
});
const registry = Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
  list: () => Effect.succeed([]),
  get: (instanceId) => Effect.succeed(makeProviderAdapter(instanceId)),
});
const runtime = layerWithRegistry({ name: "satellite-feature-tests" }, registry, {
  databaseLayer: database,
  runEffectWorker: false,
});
const stores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
  IdeaNotebookStore.layer,
).pipe(Layer.provideMerge(database));

/** Real V2 command receipts, event projection, and Satellite service views without provider execution. */
export const layer = Layer.mergeAll(
  SatelliteOrchestration.layer,
  ProjectService.layer,
  ThreadSearch.layer,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(runtime, stores, McpSessionRegistryTestkit.layer, IdAllocator.layer),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: true,
          }),
        peek: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: true,
          }),
        invalidate: () => Effect.void,
      }),
      Layer.mock(WorkspacePaths.WorkspacePaths)({}),
      Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
        ensureTranscript: () => Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
      }),
    ),
  ),
);

export const recordProject = Effect.fn(function* (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make(`project:${input.projectId}`),
    aggregateKind: "project",
    aggregateId: input.projectId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: { ...input, defaultModelSelection: null, scripts: [], createdAt: now, updatedAt: now },
  });
});

export const recordMessage = Effect.fn(function* (input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming?: boolean;
}) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  return yield* sink.write({
    events: [
      {
        id: EventId.make(
          `${input.messageId}:${input.text.length}:${input.streaming === true ? "delta" : "complete"}`,
        ),
        type: "message.updated",
        threadId: input.threadId,
        occurredAt: now,
        payload: {
          id: input.messageId,
          threadId: input.threadId,
          role: input.role,
          text: input.text,
          streaming: input.streaming ?? false,
          runId: null,
          nodeId: null,
          attachments: [],
          createdBy: input.role === "user" ? "user" : "agent",
          creationSource: input.role === "user" ? "web" : "provider",
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
  });
});

export const recordCompletedRun = Effect.fn(function* (threadId: ThreadId) {
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projection = yield* projections.getThreadProjection(threadId);
  const now = yield* DateTime.now;
  const id = RunId.make(`${threadId}:fixture-run`);
  return yield* sink.write({
    events: [
      {
        id: EventId.make(`${id}:completed`),
        type: "run.updated",
        threadId,
        runId: id,
        occurredAt: now,
        payload: {
          id,
          threadId,
          ordinal: 1,
          providerInstanceId: projection.thread.providerInstanceId,
          modelSelection: projection.thread.modelSelection,
          providerThreadId: null,
          userMessageId:
            projection.messages.findLast((message) => message.role === "user")?.id ??
            MessageId.make(`${threadId}:fixture-message`),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ],
  });
});

export const recordQuestion = Effect.fn(function* (input: {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly questions: readonly OrchestrationV2UserInputQuestion[];
  readonly answers?: Record<string, unknown>;
}) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const nodeId = NodeId.make(`${input.threadId}:fixture-node`);
  const resolved = input.answers !== undefined;
  return yield* sink.write({
    events: [
      {
        id: EventId.make(
          `${input.threadId}:${input.requestId}:${resolved ? "resolved" : "requested"}`,
        ),
        type: "runtime-request.updated",
        threadId: input.threadId,
        occurredAt: now,
        payload: {
          id: input.requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: resolved ? "resolved" : "pending",
          responseCapability: { type: "message" },
          ...(input.answers === undefined ? {} : { answers: input.answers }),
          createdAt: now,
          resolvedAt: resolved ? now : null,
        },
      },
      {
        id: EventId.make(
          `${input.threadId}:${input.requestId}:item:${resolved ? "resolved" : "requested"}`,
        ),
        type: "turn-item.updated",
        threadId: input.threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`${input.requestId}:item`),
          threadId: input.threadId,
          runId: null,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: resolved ? "completed" : "running",
          title: null,
          startedAt: now,
          completedAt: resolved ? now : null,
          updatedAt: now,
          type: "user_input_request",
          responseMode: "message",
          requestId: input.requestId,
          questions: input.questions,
        },
      },
    ],
  });
});
