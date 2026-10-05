import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  EventId,
  ORCHESTRATION_REQUEST_LIFECYCLE_MAX_ROW_BYTES,
  OrchestrationGetRequestLifecycleError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
const createdAt = "2026-10-01T00:00:00.000Z";
const submittedAt = "2026-10-01T00:01:00.000Z";
const input = {
  threadId: ThreadId.make("work"),
  audience: "work",
  kind: "question",
  requestId: ApprovalRequestId.make("request"),
  submittedAt,
} as const;
const question = {
  requestId: "request",
  questions: [{ id: "target", header: "Target", question: "Which target?", options: [] }],
};
const encodePayload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const seedThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Project', '/project', '[]', ${createdAt}, ${createdAt})`;
  for (const [threadId, purpose, archivedAt, deletedAt] of [
    ["work", "work", null, null],
    ["other-work", "work", null, null],
    ["idea", "idea", null, null],
    ["revdoc", "revdoc", null, null],
    ["archived", "work", createdAt, null],
    ["deleted", "work", null, createdAt],
  ] as const) {
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        purpose, archived_at, deleted_at, created_at, updated_at)
      VALUES (${threadId}, 'project', 'Thread', '{"instanceId":"codex","model":"test"}',
        'full-access', 'default', ${purpose}, ${archivedAt}, ${deletedAt}, ${createdAt}, ${createdAt})`;
  }
});

const insertActivity = (
  id: string,
  kind: string,
  payload: unknown,
  options: { threadId?: string; sequence?: number; createdAt?: string } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_thread_activities
    (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
    VALUES (${id}, ${options.threadId ?? "work"}, NULL, 'info', ${kind}, ${id},
      ${encodePayload(payload)}, ${options.sequence ?? null}, ${options.createdAt ?? createdAt})`;
  });

it.effect("recovers exact request evidence after the thread detail window has moved on", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    yield* seedThreads;
    yield* insertActivity("requested", "user-input.requested", question, { sequence: 1 });
    const resolved = {
      requestId: "request",
      commandId: "submitted-command",
      answers: { target: "all" },
    };
    yield* insertActivity("resolved", "user-input.resolved", resolved, {
      sequence: 2,
      createdAt: submittedAt,
    });
    yield* insertActivity(
      "other-request",
      "user-input.resolved",
      { requestId: "other" },
      { sequence: 3 },
    );
    yield* insertActivity(
      "other-kind",
      "approval.resolved",
      { requestId: "request" },
      { sequence: 4 },
    );
    yield* insertActivity(
      "other-thread",
      "user-input.resolved",
      { requestId: "request" },
      { threadId: "other-work", sequence: 5 },
    );
    yield* sql`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 600)
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
      SELECT 'tool-' || n, 'work', NULL, 'info', 'tool.completed', 'Tool result', '{}', n + 100,
        '2026-10-02T00:00:00.000Z' FROM numbers`;

    const detail = Option.getOrThrow(yield* query.getThreadDetailSnapshot(input.threadId));
    assert.strictEqual(detail.thread.activities.length, 500);
    assert.strictEqual(
      detail.thread.activities.some((activity) => activity.id === "resolved"),
      false,
    );
    assert.deepStrictEqual(yield* query.getRequestLifecycle(input), [
      {
        id: EventId.make("resolved"),
        kind: "user-input.resolved",
        tone: "info",
        summary: "resolved",
        payload: resolved,
        sequence: 2,
        turnId: null,
        createdAt: submittedAt,
      },
    ]);
    assert.deepStrictEqual(
      yield* query.getRequestLifecycle({ ...input, requestId: ApprovalRequestId.make("missing") }),
      [],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("recovers an old resolution without loading its oversized original request", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    yield* seedThreads;
    yield* insertActivity(
      "large-request",
      "approval.requested",
      {
        requestId: "request",
        requestType: "command",
        command: "x".repeat(70_000),
      },
      { sequence: 1 },
    );
    yield* insertActivity(
      "small-resolution",
      "approval.resolved",
      { requestId: "request" },
      { sequence: 2 },
    );
    yield* sql`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 600)
        INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
        SELECT 'tool-' || n, 'work', NULL, 'info', 'tool.completed', 'Tool result', '{}', n + 100,
          '2026-10-02T00:00:00.000Z' FROM numbers`;
    const detail = Option.getOrThrow(yield* query.getThreadDetailSnapshot(input.threadId));
    assert.strictEqual(detail.thread.activities.length, 500);
    assert.strictEqual(
      detail.thread.activities.some((activity) => activity.id === "small-resolution"),
      false,
    );
    assert.deepStrictEqual(yield* query.getRequestLifecycle({ ...input, kind: "approval" }), [
      {
        id: EventId.make("small-resolution"),
        kind: "approval.resolved",
        tone: "info",
        summary: "small-resolution",
        payload: { requestId: "request" },
        sequence: 2,
        turnId: null,
        createdAt,
      },
    ]);

    yield* sql`UPDATE projection_thread_activities
        SET kind = 'provider.approval.respond.failed',
          payload_json = '{"requestId":"request","detail":"Unknown pending approval request"}'
        WHERE activity_id = 'small-resolution'`;
    const failure = yield* Effect.flip(query.getRequestLifecycle({ ...input, kind: "approval" }));
    assert.deepStrictEqual(
      failure,
      new OrchestrationGetRequestLifecycleError({ reason: "payload-too-large" }),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "preserves both sequenced and exact-submission failures without later attempts replacing them",
  () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      yield* seedThreads;
      yield* insertActivity("requested", "user-input.requested", question, { sequence: 1 });
      const failure = {
        requestId: "request",
        detail: "Provider disconnected",
        commandId: "submitted-command",
      };
      yield* insertActivity("old-sequenced", "provider.user-input.respond.failed", failure, {
        sequence: 2,
      });
      yield* insertActivity("latest-sequenced", "provider.user-input.respond.failed", failure, {
        sequence: 3,
      });
      yield* insertActivity("submitted-failure", "provider.user-input.respond.failed", failure, {
        createdAt: submittedAt,
      });
      yield* insertActivity(
        "later-attempt",
        "provider.user-input.respond.failed",
        { ...failure, commandId: "later-command" },
        { createdAt: "2026-10-01T00:02:00.000Z" },
      );
      const evidence = yield* query.getRequestLifecycle(input);
      assert.deepStrictEqual(
        evidence.map((activity) => activity.id),
        ["submitted-failure", "requested", "latest-sequenced"],
      );
      assert.deepStrictEqual(evidence[0], {
        id: EventId.make("submitted-failure"),
        kind: "provider.user-input.respond.failed",
        tone: "info",
        summary: "submitted-failure",
        payload: failure,
        turnId: null,
        createdAt: submittedAt,
      });
      assert.strictEqual(
        evidence.some((activity) => activity.kind.endsWith(".resolved")),
        false,
      );
    }).pipe(Effect.provide(layer)),
);

for (const [kind, prefix, staleDetail] of [
  ["question", "user-input", "Unknown pending Codex user input request"],
  ["approval", "approval", "Stale pending approval request"],
] as const) {
  it.effect(
    `retains terminal ${kind} evidence alongside newer response failures within four rows`,
    () =>
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        yield* seedThreads;
        yield* insertActivity(
          "requested",
          `${prefix}.requested`,
          kind === "question" ? question : { requestId: "request", requestType: "command" },
          { sequence: 1 },
        );
        yield* insertActivity(
          "terminal",
          `provider.${prefix}.respond.failed`,
          { requestId: "request", detail: staleDetail },
          { sequence: 2 },
        );
        yield* insertActivity(
          "later-failure",
          `provider.${prefix}.respond.failed`,
          { requestId: "request", detail: { message: staleDetail } },
          { sequence: 3 },
        );
        yield* insertActivity(
          "submitted-failure",
          `provider.${prefix}.respond.failed`,
          { requestId: "request", detail: "Disconnected" },
          { createdAt: submittedAt },
        );
        const evidence = yield* query.getRequestLifecycle({ ...input, kind });
        assert.strictEqual(evidence.length, 4);
        assert.deepStrictEqual(
          evidence.map((activity) => activity.id),
          ["submitted-failure", "requested", "terminal", "later-failure"],
        );
        assert.deepStrictEqual(evidence.find((activity) => activity.id === "terminal")?.payload, {
          requestId: "request",
          detail: staleDetail,
        });
      }).pipe(Effect.provide(layer)),
  );
}

it.effect("enforces work and idea audiences and excludes unavailable threads", () =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    yield* seedThreads;
    yield* insertActivity("idea-request", "user-input.requested", question, { threadId: "idea" });
    const evidence = yield* query.getRequestLifecycle({
      ...input,
      threadId: ThreadId.make("idea"),
      audience: "idea",
    });
    assert.deepStrictEqual(
      evidence.map((activity) => activity.id),
      ["idea-request"],
    );
    assert.strictEqual(
      Option.isNone(yield* query.getThreadDetailSnapshot(ThreadId.make("archived"))),
      true,
    );
    for (const [threadId, audience] of [
      ["idea", "work"],
      ["work", "idea"],
      ["revdoc", "work"],
      ["revdoc", "idea"],
      ["missing", "work"],
      ["archived", "work"],
      ["deleted", "work"],
    ] as const) {
      const failure = yield* Effect.flip(
        query.getRequestLifecycle({ ...input, threadId: ThreadId.make(threadId), audience }),
      );
      assert.deepStrictEqual(
        failure,
        new OrchestrationGetRequestLifecycleError({ reason: "thread-unavailable" }),
      );
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("does not manufacture requested evidence from unusable request bodies", () =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    yield* seedThreads;
    for (const [kind, payload] of [
      ["question", { questions: [] }],
      [
        "question",
        {
          questions: [
            {
              id: "target",
              header: "Target",
              question: "No answer",
              options: [],
              allowCustomAnswer: false,
            },
          ],
        },
      ],
      ["question", { questions: [{ id: "target", question: "Missing header", options: [] }] }],
      ["approval", { requestType: "tool_user_input" }],
      ["approval", { requestType: "auth_tokens_refresh" }],
    ] as const) {
      const prefix = kind === "question" ? "user-input" : "approval";
      yield* insertActivity("unusable", `${prefix}.requested`, {
        requestId: "request",
        ...payload,
      });
      assert.deepStrictEqual(yield* query.getRequestLifecycle({ ...input, kind }), []);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = 'unusable'`;
    }
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects oversized matching evidence without dropping it or loading unrelated payloads",
  () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      yield* seedThreads;
      yield* insertActivity("requested", "user-input.requested", question);
      const largeDetail = "💬".repeat(ORCHESTRATION_REQUEST_LIFECYCLE_MAX_ROW_BYTES / 4);
      yield* insertActivity("unrelated", "user-input.resolved", {
        requestId: "unrelated",
        detail: largeDetail,
      });
      assert.deepStrictEqual(
        (yield* query.getRequestLifecycle(input)).map((activity) => activity.id),
        ["requested"],
      );
      yield* insertActivity("matching", "user-input.resolved", {
        requestId: "request",
        detail: largeDetail,
      });
      const failure = yield* Effect.flip(query.getRequestLifecycle(input));
      assert.deepStrictEqual(
        failure,
        new OrchestrationGetRequestLifecycleError({ reason: "payload-too-large" }),
      );
    }).pipe(Effect.provide(layer)),
);
