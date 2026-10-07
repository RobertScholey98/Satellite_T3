import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migration from "./062_ProjectionRequestLifecycleIndex.ts";

it.effect("indexes request lifecycle reads after upgrading an existing activity history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    for (const kind of [
      "approval.requested",
      "approval.resolved",
      "provider.approval.respond.failed",
      "user-input.requested",
      "user-input.resolved",
      "provider.user-input.respond.failed",
      "tool.completed",
    ]) {
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
        VALUES (${kind}, 'thread-1', NULL, 'info', ${kind}, 'Activity',
          '{"requestId":"request-1"}', '2026-10-01T00:00:00Z')`;
    }
    yield* sql`INSERT INTO projection_thread_activities
      (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
      VALUES ('other-thread', 'thread-2', NULL, 'approval', 'approval.requested', 'Other request',
        '{"requestId":"request-2"}', '2026-10-01T00:00:00Z')`;
    yield* runMigrations({ toMigrationInclusive: 62 });
    yield* migration;

    const kinds = yield* sql<{ readonly kind: string }>`
      SELECT kind FROM projection_thread_activities
      WHERE thread_id = 'thread-1' AND kind IN (
        'approval.requested', 'approval.resolved', 'provider.approval.respond.failed',
        'user-input.requested', 'user-input.resolved', 'provider.user-input.respond.failed'
      )
      ORDER BY kind
    `;
    assert.deepStrictEqual(
      kinds.map((row) => row.kind),
      [
        "approval.requested",
        "approval.resolved",
        "provider.approval.respond.failed",
        "provider.user-input.respond.failed",
        "user-input.requested",
        "user-input.resolved",
      ],
    );
    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN SELECT payload_json FROM projection_thread_activities
      WHERE thread_id = 'thread-1' AND kind IN (
        'approval.requested', 'approval.resolved', 'provider.approval.respond.failed',
        'user-input.requested', 'user-input.resolved', 'provider.user-input.respond.failed'
      )
    `;
    assert.match(
      plan.map((row) => row.detail).join("\n"),
      /USING INDEX idx_projection_thread_activities_request_lifecycle/,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
