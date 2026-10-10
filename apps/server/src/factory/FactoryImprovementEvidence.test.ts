import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  FactorySnapshot,
  MessageId,
  ThreadId,
  TurnItemId,
  type FactoryInvestigationRead,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import migration from "../persistence/Migrations/067_EngineeringFactory.ts";
import { deliveryFixture, deliveryIds, deliveryNow } from "./FactoryDelivery.testkit.ts";
import * as FactoryImprovementEvidence from "./FactoryImprovementEvidence.ts";
import * as FactoryStore from "./FactoryStore.ts";

const systemId = ThreadId.make("system");
const foreignId = ThreadId.make("foreign");
const input: FactoryInvestigationRead = {
  investigationId: "investigation",
  findingId: "finding",
  evidenceRef: { kind: "thread", threadId: deliveryIds.lead },
  limit: 100,
};
const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const fixture = () => {
  const state = deliveryFixture();
  return {
    ...state,
    managers: [
      ...state.managers,
      {
        ...state.managers[0]!,
        role: "system" as const,
        id: systemId,
        threadId: systemId,
        projectId: null,
        workspaceProjectId: deliveryIds.project,
        qualification: {
          status: "qualified" as const,
          profileId: "system-profile",
          checkedAt: deliveryNow,
        },
      },
    ],
    findings: [
      {
        id: "finding",
        assignmentId: deliveryIds.assignment,
        reporterThreadId: deliveryIds.lead,
        problem: "Shared failure",
        impact: "Repeated waste",
        evidence: [
          input.evidenceRef,
          {
            kind: "message" as const,
            threadId: deliveryIds.lead,
            messageId: MessageId.make("message"),
          },
        ],
        activeBlocker: false,
        route: {
          suspectedCause: "shared-system" as const,
          uncertainty: "Needs evidence",
          owner: { kind: "system-remit" as const },
          requiredAuthority: "Human review",
          rationale: "Shared cause",
        },
        containmentOf: null,
        history: [],
        escalation: null,
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
    improvementInvestigations: [
      {
        id: "investigation",
        title: "Find the cause",
        findingIds: ["finding"],
        relatedInvestigationIds: [],
        uncertainty: "Unknown cause",
        assessment: "",
        lifecycle: { phase: "open" as const },
        createdAt: deliveryNow,
        updatedAt: deliveryNow,
      },
    ],
  } satisfies FactorySnapshot;
};
const record = (
  sourceThreadId = deliveryIds.lead,
  text = "Actual thread evidence ".repeat(20),
): OrchestrationV2ProjectedTurnItem => ({
  position: 0,
  visibility: "local",
  sourceThreadId,
  sourceItemId: TurnItemId.make("item"),
  item: {
    id: TurnItemId.make("item"),
    threadId: sourceThreadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(deliveryNow),
    type: "assistant_message",
    messageId: MessageId.make("message"),
    text,
    streaming: false,
  },
});
interface Scenario {
  readonly evidence: FactoryImprovementEvidence.FactoryImprovementEvidence["Service"];
  readonly store: FactoryStore.FactoryStore["Service"];
  readonly save: (state: FactorySnapshot) => Effect.Effect<void>;
  readonly flags: {
    record: OrchestrationV2ProjectedTurnItem;
    reads: number;
    afterRead: Effect.Effect<void>;
  };
}
const scenario = <E>(test: (s: Scenario) => Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    yield* migration;
    const sql = yield* SqlClient.SqlClient;
    const save = (state: FactorySnapshot) =>
      sql`INSERT INTO factory_state (id,revision,payload_json) VALUES (1,${state.revision},${encode(state)}) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );
    yield* save(fixture());
    const store = yield* FactoryStore.FactoryStore.pipe(Effect.provide(FactoryStore.layer));
    const flags: Scenario["flags"] = { record: record(), reads: 0, afterRead: Effect.void };
    const shell = (id: ThreadId) => ({ ...liveThreadShell(id), projectId: deliveryIds.project });
    const dependencies = Layer.mergeAll(
      Layer.succeed(FactoryStore.FactoryStore, store),
      Layer.mock(ProjectionStoreV2)({ getThreadShell: (id) => Effect.succeed(shell(id)) }),
      Layer.mock(ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(shell(id)),
        getTimelinePage: (_id, options) =>
          Effect.gen(function* () {
            assert.equal(options.limit, 1);
            flags.reads++;
            const item = flags.record;
            yield* flags.afterRead;
            return {
              items: options.afterPosition === 0 ? [] : [item],
              totalItems: 1,
              hasMore: false,
            };
          }),
        getThreadRecords: () => Effect.die("A thread reference must use bounded timeline reads."),
      }),
    );
    const evidence = yield* FactoryImprovementEvidence.FactoryImprovementEvidence.pipe(
      Effect.provide(FactoryImprovementEvidence.layer.pipe(Layer.provide(dependencies))),
    );
    yield* test({ evidence, store, save, flags });
  }).pipe(
    Effect.provide(
      Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
    ),
    Effect.scoped,
  );

it.effect("pages actual source records with stable digest and durable scoped audit", () =>
  scenario(({ evidence, store }) =>
    Effect.gen(function* () {
      const first = yield* evidence.read(systemId, input);
      assert.equal(first.text.length, 100);
      assert.isNotNull(first.nextCursor);
      const second = yield* evidence.read(systemId, { ...input, cursor: first.nextCursor! });
      assert.equal(first.digest, second.digest);
      assert.notEqual(first.text, second.text);
      assert.equal(first.projectId, deliveryIds.project);
      const receipts = (yield* store.snapshot).improvementEvidenceReads;
      assert.equal(receipts.length, 2);
      assert.equal(receipts[0]?.assignmentId, deliveryIds.assignment);
      assert.equal(receipts[0]?.digest, first.digest);
      assert.equal(receipts[1]?.cursor.offset, 100);
    }),
  ),
);
it.effect(
  "rejects unlinked references, project managers, closed investigations and foreign inherited records",
  () =>
    scenario(({ evidence, save, flags }) =>
      Effect.gen(function* () {
        for (const request of [
          { ...input, findingId: "not-linked" },
          { ...input, evidenceRef: { kind: "thread" as const, threadId: foreignId } },
          { ...input, limit: 16001 },
        ])
          assert.equal(
            (yield* evidence.read(systemId, request).pipe(Effect.flip)).code,
            "permission-denied",
          );
        assert.equal(
          (yield* evidence.read(deliveryIds.manager, input).pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.equal(flags.reads, 0);
        flags.record = record(foreignId);
        assert.equal(
          (yield* evidence.read(systemId, input).pipe(Effect.flip)).code,
          "permission-denied",
        );
        const state = fixture();
        yield* save({
          ...state,
          improvementInvestigations: state.improvementInvestigations.map((entry) => ({
            ...entry,
            lifecycle: { phase: "closed", reason: "Done" },
          })),
        });
        assert.equal(
          (yield* evidence.read(systemId, input).pipe(Effect.flip)).code,
          "permission-denied",
        );
      }),
    ),
);
it.effect(
  "refuses changed evidence cursors and does not return data when the investigation closes during the host read",
  () =>
    scenario(({ evidence, save, store, flags }) =>
      Effect.gen(function* () {
        const first = yield* evidence.read(systemId, input);
        flags.record = record(deliveryIds.lead, "Changed source");
        assert.equal(
          (yield* evidence
            .read(systemId, { ...input, cursor: first.nextCursor! })
            .pipe(Effect.flip)).code,
          "invalid-state",
        );
        const state = fixture();
        flags.afterRead = save({
          ...state,
          improvementInvestigations: state.improvementInvestigations.map((entry) => ({
            ...entry,
            lifecycle: { phase: "closed", reason: "Closed during read" },
          })),
        });
        assert.equal(
          (yield* evidence.read(systemId, input).pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.equal((yield* store.snapshot).improvementEvidenceReads.length, 0);
      }),
    ),
);
it.effect("rechecks a human pause after reading and leaves no receipt or returned page", () =>
  scenario(({ evidence, store, flags }) =>
    Effect.gen(function* () {
      flags.afterRead = store
        .commit({
          actor: { kind: "human" },
          command: {
            type: "manager.pause",
            commandId: CommandId.make("pause-during-read"),
            managerId: systemId,
          },
          now: deliveryNow,
        })
        .pipe(Effect.asVoid, Effect.orDie);
      assert.equal(
        (yield* evidence.read(systemId, input).pipe(Effect.flip)).code,
        "permission-denied",
      );
      assert.equal((yield* store.snapshot).improvementEvidenceReads.length, 0);
    }),
  ),
);
