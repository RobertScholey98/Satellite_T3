import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "./ProjectionStore.ts";
import { OrchestrationEngineService, ProjectionSnapshotQuery } from "./SatelliteOrchestration.ts";
import * as SatelliteTestRuntime from "./testkit/SatelliteTestRuntime.ts";

const layer = SatelliteTestRuntime.layer.pipe(Layer.provideMerge(NodeServices.layer));
const seed = Effect.fn(function* (turnCount: number) {
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectId = ProjectId.make(`snapshot-project:${turnCount}`);
  const threadId = ThreadId.make(`snapshot-thread:${turnCount}`);
  yield* SatelliteTestRuntime.recordProject({
    projectId,
    title: "Project",
    workspaceRoot: process.cwd(),
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId,
    title: "History",
    createdBy: "user",
    creationSource: "web",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  for (let turn = 1; turn <= turnCount; turn += 1) {
    for (const role of ["user", "assistant"] as const) {
      const now = DateTime.makeUnsafe(`2026-10-01T00:${String(turn).padStart(2, "0")}:00.000Z`);
      const messageId = MessageId.make(`${threadId}:${turn}:${role}`);
      const text = `${role} turn ${turn}`;
      yield* projections.apply({
        id: EventId.make(`event:${messageId}`),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: messageId,
          threadId,
          role,
          text,
          streaming: false,
          runId: null,
          nodeId: null,
          attachments: [],
          createdBy: role === "user" ? "user" : "agent",
          creationSource: role === "user" ? "web" : "provider",
          createdAt: now,
          updatedAt: now,
        },
      });
      const base = {
        id: TurnItemId.make(`item:${messageId}`),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: turn * 2 + (role === "user" ? 0 : 1),
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        messageId,
        text,
      };
      yield* projections.apply({
        id: EventId.make(`event:item:${messageId}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload:
          role === "user"
            ? {
                ...base,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                attachments: [],
              }
            : { ...base, type: "assistant_message", streaming: false },
      });
    }
  }
  return threadId;
});

it.layer(layer)("Satellite thread snapshots", (it) => {
  it.effect(
    "returns only 30 complete recent turns and reports omitted history without decoding old messages",
    () =>
      Effect.gen(function* () {
        const threadId = yield* seed(45);
        const query = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        // A full projection read would decode this old row and fail, even if sliced afterward.
        yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{}' WHERE message_id = ${`${threadId}:1:user`}`;
        const result = yield* query.getThreadDetailSnapshot(threadId, { turnLimit: 30 });
        expect(Option.isSome(result)).toBe(true);
        if (Option.isNone(result)) return;
        expect(result.value.page?.hasMore).toBe(true);
        expect(result.value.thread.messages).toHaveLength(60);
        expect(result.value.thread.messages[0]?.text).toBe("user turn 16");
        expect(result.value.thread.messages.at(-1)?.text).toBe("assistant turn 45");
      }),
  );

  it.effect(
    "reports complete history at the requested boundary and preserves unwindowed reads",
    () =>
      Effect.gen(function* () {
        const threadId = yield* seed(30);
        const query = yield* ProjectionSnapshotQuery;
        const recent = yield* query.getThreadDetailSnapshot(threadId, { turnLimit: 30 });
        const full = yield* query.getThreadDetailSnapshot(threadId);
        expect(Option.isSome(recent)).toBe(true);
        expect(Option.isSome(full)).toBe(true);
        if (Option.isNone(recent) || Option.isNone(full)) return;
        expect(recent.value.page?.hasMore).toBe(false);
        expect(recent.value.thread.messages).toHaveLength(60);
        expect(recent.value.thread.messages).toEqual(full.value.thread.messages);
        const smaller = yield* query.getThreadDetailSnapshot(threadId, { turnLimit: 5 });
        if (Option.isNone(smaller)) throw new Error("Missing thread");
        expect(smaller.value.page?.hasMore).toBe(true);
        expect(smaller.value.thread.messages).toHaveLength(10);
      }),
  );

  it.effect("returns no snapshot for a missing thread", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      expect(
        yield* query.getThreadDetailSnapshot(ThreadId.make("missing"), { turnLimit: 30 }),
      ).toEqual(Option.none());
    }),
  );

  it.effect("retains completed plan text inside the window and omits older plans", () =>
    Effect.gen(function* () {
      const threadId = yield* seed(31);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const query = yield* ProjectionSnapshotQuery;
      const now = yield* DateTime.now;
      for (const [name, ordinal] of [
        ["older", 1],
        ["recent", 64],
      ] as const) {
        const planId = PlanId.make(`${threadId}:${name}`);
        const nodeId = NodeId.make(`${planId}:node`);
        yield* projections.apply({
          id: EventId.make(`event:${planId}`),
          type: "plan.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: planId,
            threadId,
            runId: null,
            nodeId,
            status: "completed",
            kind: "proposed_plan",
            markdown: `${name} plan text`,
          },
        });
        yield* projections.apply({
          id: EventId.make(`event:item:${planId}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${planId}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "proposed_plan",
            planId,
            markdown: `${name} plan text`,
            streaming: false,
          },
        });
      }
      const snapshot = yield* query.getThreadDetailSnapshot(threadId, { turnLimit: 30 });
      if (Option.isNone(snapshot)) throw new Error("Missing thread");
      expect(snapshot.value.thread.proposedPlans).toEqual([{ planMarkdown: "recent plan text" }]);
    }),
  );
});
