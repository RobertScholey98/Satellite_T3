import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  ORCHESTRATION_REQUEST_LIFECYCLE_MAX_ROW_BYTES,
  OrchestrationGetRequestLifecycleError,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { EventSinkV2 } from "./EventSink.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { OrchestrationEngineService, ProjectionSnapshotQuery } from "./SatelliteOrchestration.ts";
import {
  layer as SatelliteTestLayer,
  recordProject,
  recordQuestion,
} from "./testkit/SatelliteTestRuntime.ts";

const layer = SatelliteTestLayer.pipe(Layer.provideMerge(NodeServices.layer));
const threadId = ThreadId.make("work");
const requestId = RuntimeRequestId.make("request");
const input = {
  threadId,
  audience: "work",
  kind: "question",
  requestId,
  submittedAt: "2026-10-01T00:01:00.000Z",
} as const;
const questions = [{ id: "target", header: "Target", question: "Which target?", options: [] }];
const isLifecycleError = Schema.is(OrchestrationGetRequestLifecycleError);

const seedThreads = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projects = yield* ProjectionStoreV2;
  const sink = yield* EventSinkV2;
  const projectId = ProjectId.make("request-project");
  yield* recordProject({ projectId, title: "Project", workspaceRoot: process.cwd() });
  for (const [id, purpose, unavailable] of [
    ["work", "work", null],
    ["other-work", "work", null],
    ["idea", "idea", null],
    ["revdoc", "revdoc", null],
    ["archived", "work", "archived"],
    ["deleted", "work", "deleted"],
  ] as const) {
    const idValue = ThreadId.make(id);
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId: idValue,
      projectId,
      purpose,
      title: id,
      createdBy: "user",
      creationSource: "web",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    if (unavailable !== null) {
      const thread = yield* projects.getThread(idValue);
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`unavailable:${id}`),
            type: "thread.metadata-updated",
            threadId: idValue,
            occurredAt: now,
            payload: {
              ...thread,
              archivedAt: unavailable === "archived" ? now : null,
              deletedAt: unavailable === "deleted" ? now : null,
            },
          },
        ],
      });
    }
  }
});

const patchRequest = Effect.fn(function* (
  patch: Partial<Omit<OrchestrationV2RuntimeRequest, "id">>,
) {
  const projections = yield* ProjectionStoreV2;
  const request = yield* projections.getRuntimeRequest(threadId, requestId);
  if (request === undefined) return yield* Effect.die("Missing request fixture");
  const sink = yield* EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(
          `patch:${requestId}:${patch.kind ?? request.kind}:${patch.status ?? request.status}`,
        ),
        type: "runtime-request.updated",
        threadId,
        occurredAt: now,
        payload: { ...request, ...patch },
      },
    ],
  });
});

it.effect("recovers exact request resolution independently of unrelated oversized history", () =>
  Effect.gen(function* () {
    yield* seedThreads;
    const query = yield* ProjectionSnapshotQuery;
    yield* recordQuestion({ threadId, requestId, questions });
    yield* recordQuestion({ threadId, requestId, questions, answers: { target: "all" } });
    yield* recordQuestion({
      threadId,
      requestId: RuntimeRequestId.make("unrelated"),
      questions: [{ ...questions[0]!, question: "x".repeat(70_000) }],
    });
    yield* recordQuestion({
      threadId: ThreadId.make("other-work"),
      requestId: RuntimeRequestId.make("other-thread-request"),
      questions,
      answers: { target: "other" },
    });
    const evidence = yield* query.getRequestLifecycle(input);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.id, `${requestId}:resolved`);
    assert.deepInclude(evidence[0]?.payload, { answers: { target: "all" } });
    assert.deepEqual(
      yield* query.getRequestLifecycle({ ...input, requestId: RuntimeRequestId.make("missing") }),
      [],
    );
    assert.deepEqual(yield* query.getRequestLifecycle({ ...input, kind: "approval" }), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("recovers a small resolution without loading an oversized original question", () =>
  Effect.gen(function* () {
    yield* seedThreads;
    const query = yield* ProjectionSnapshotQuery;
    const largeQuestions = [{ ...questions[0]!, question: "x".repeat(70_000) }];
    yield* recordQuestion({ threadId, requestId, questions: largeQuestions });
    const pending = yield* query.getRequestLifecycle(input).pipe(Effect.result);
    assert.equal(pending._tag, "Failure");
    if (pending._tag === "Failure") assert.equal(pending.failure.reason, "payload-too-large");
    yield* recordQuestion({
      threadId,
      requestId,
      questions: largeQuestions,
      answers: { target: "all" },
    });
    const evidence = yield* query.getRequestLifecycle(input);
    assert.equal(evidence[0]?.kind, "user-input.resolved");
    assert.deepInclude(evidence[0]?.payload, { answers: { target: "all" } });
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["cancelled", "expired"] as const)(
  "returns terminal evidence for a %s request",
  (status) =>
    Effect.gen(function* () {
      yield* seedThreads;
      const query = yield* ProjectionSnapshotQuery;
      yield* recordQuestion({ threadId, requestId, questions });
      yield* patchRequest({ status, resolvedAt: yield* DateTime.now });
      const evidence = yield* query.getRequestLifecycle(input);
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.kind, "user-input.cancelled");
    }).pipe(Effect.provide(layer)),
);

it.effect("enforces work and idea audiences and excludes unavailable threads", () =>
  Effect.gen(function* () {
    yield* seedThreads;
    const query = yield* ProjectionSnapshotQuery;
    yield* recordQuestion({ threadId: ThreadId.make("idea"), requestId, questions });
    const evidence = yield* query.getRequestLifecycle({
      ...input,
      threadId: ThreadId.make("idea"),
      audience: "idea",
    });
    assert.equal(evidence[0]?.kind, "user-input.requested");
    for (const [id, audience] of [
      ["idea", "work"],
      ["work", "idea"],
      ["revdoc", "work"],
      ["revdoc", "idea"],
      ["missing", "work"],
      ["archived", "work"],
      ["deleted", "work"],
    ] as const) {
      const result = yield* query
        .getRequestLifecycle({ ...input, threadId: ThreadId.make(id), audience })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue(isLifecycleError(result.failure));
        assert.equal(result.failure.reason, "thread-unavailable");
      }
    }
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["auth_refresh", "dynamic_tool_call"] as const)(
  "does not expose internal %s requests as approval prompts",
  (kind) =>
    Effect.gen(function* () {
      yield* seedThreads;
      yield* recordQuestion({ threadId, requestId, questions });
      yield* patchRequest({ kind });
      const query = yield* ProjectionSnapshotQuery;
      assert.deepEqual(yield* query.getRequestLifecycle({ ...input, kind: "approval" }), []);
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects oversized matching answers without silently dropping terminal evidence", () =>
  Effect.gen(function* () {
    yield* seedThreads;
    yield* recordQuestion({
      threadId,
      requestId,
      questions,
      answers: { target: "💬".repeat(ORCHESTRATION_REQUEST_LIFECYCLE_MAX_ROW_BYTES / 4) },
    });
    const query = yield* ProjectionSnapshotQuery;
    const result = yield* query.getRequestLifecycle(input).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "payload-too-large");
  }).pipe(Effect.provide(layer)),
);
