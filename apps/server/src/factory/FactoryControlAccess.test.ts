import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactorySnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { decide, initialFactorySnapshot } from "./FactoryState.ts";
import { deliveryIds, reviewedDeliveryFixture } from "./FactoryDelivery.testkit.ts";
import { sharedAccessFixture } from "./FactorySharedAccess.testkit.ts";

const managerId = ThreadId.make("control-manager");
const leadId = ThreadId.make("control-lead");
const workerId = ThreadId.make("control-worker");
const childId = ThreadId.make("control-child");
const projectId = ProjectId.make("control-project");
const assignmentId = FactoryAssignmentId.make("control-assignment");
const now = "2026-10-10T12:00:00.000Z";
const state = Result.getOrThrow(
  decide({
    state: initialFactorySnapshot(),
    actor: { kind: "human" },
    now,
    command: {
      type: "manager.create",
      commandId: CommandId.make("create-control-manager"),
      projectId,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved" },
    },
    allocation: { managerThreadId: managerId, leadThreadId: leadId, assignmentId },
    skills: { repositoryRoot: "/skills", revision: "pinned" },
    qualification: { status: "qualified", profileId: "profile", checkedAt: now },
  }),
).state;
const shell = (id: ThreadId, parent: ThreadId | null): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(id),
  projectId,
  lineage: {
    rootThreadId: parent === null ? id : leadId,
    parentThreadId: parent,
    relationshipToParent: parent === null ? null : "subagent",
  },
});
const layer = (
  shells: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>,
  snapshot: FactorySnapshot = state,
) =>
  Access.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(FactoryStore.FactoryStore)({ snapshot: Effect.succeed(snapshot) }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
        }),
      ),
    ),
  );

it.effect(
  "admits real shared teams across the manager workspace and holds disabled repositories and experiments",
  () => {
    const shared = sharedAccessFixture(state, true);
    const roster = new Map([
      [workerId, shell(workerId, leadId)],
      [childId, shell(childId, workerId)],
    ]);
    return Effect.gen(function* () {
      const access = yield* Access.FactoryControlAccess;
      assert.equal((yield* access.membership(childId))?.projectId, projectId);
      yield* access.assertExecution(childId);
      for (const changed of [
        { ...shared, sharedRepositories: [] },
        {
          ...shared,
          experimentConfigurations: shared.experimentConfigurations.map((entry) => ({
            ...entry,
            enabled: false,
          })),
        },
      ])
        yield* Effect.gen(function* () {
          const current = yield* Access.FactoryControlAccess;
          assert.isTrue(
            Result.isFailure(yield* current.assertExecution(childId).pipe(Effect.result)),
          );
        }).pipe(Effect.provide(Layer.fresh(layer(roster, changed))));
    }).pipe(Effect.provide(layer(roster, shared)));
  },
);

it.effect(
  "derives nested ownership from persisted lineage and ignores a caller's alternative parent",
  () =>
    Effect.gen(function* () {
      const access = yield* Access.FactoryControlAccess;
      const member = yield* access.membership(childId, ThreadId.make("unrelated"));
      assert.deepStrictEqual(member, {
        threadId: childId,
        managerId,
        managerRole: "project",
        projectId,
        assignmentId,
        ancestorThreadIds: [leadId, workerId],
      });
      const pending = yield* access.membership(ThreadId.make("pending-child"), childId);
      assert.deepStrictEqual(pending?.ancestorThreadIds, [leadId, workerId, childId]);
    }).pipe(
      Effect.provide(
        layer(
          new Map([
            [workerId, shell(workerId, leadId)],
            [childId, shell(childId, workerId)],
          ]),
        ),
      ),
    ),
);

it.effect(
  "rejects crossed projects, missing ancestors, and lineage cycles instead of admitting an orphan",
  () =>
    Effect.gen(function* () {
      for (const shells of [
        new Map([
          [workerId, { ...shell(workerId, leadId), projectId: ProjectId.make("other-project") }],
        ]),
        new Map([[workerId, shell(workerId, childId)]]),
        new Map([
          [workerId, shell(workerId, childId)],
          [childId, shell(childId, workerId)],
        ]),
      ]) {
        const result = yield* Access.FactoryControlAccess.pipe(
          Effect.flatMap((access) => access.membership(workerId)),
          Effect.provide(layer(shells)),
          Effect.result,
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.equal(result.failure.code, "execution-unavailable");
      }
    }),
);

it.effect("retains replaced lead membership while denying that lead and all descendants", () => {
  const replacementId = ThreadId.make("replacement");
  const replaced = {
    ...state,
    assignments: state.assignments.map((entry) => ({
      ...entry,
      threadId: replacementId,
      previousLeadThreadIds: [leadId],
    })),
  };
  return Effect.gen(function* () {
    const access = yield* Access.FactoryControlAccess;
    for (const threadId of [leadId, workerId, childId]) {
      assert.equal((yield* access.membership(threadId))?.assignmentId, assignmentId);
      assert.equal(
        (yield* access.assertExecution(threadId).pipe(Effect.flip)).code,
        "permission-denied",
      );
      assert.equal(
        (yield* access.assertDirection({ threadId, senderThreadId: undefined }).pipe(Effect.flip))
          .code,
        "permission-denied",
      );
    }
    yield* access.assertExecution(replacementId);
  }).pipe(
    Effect.provide(
      layer(
        new Map([
          [workerId, shell(workerId, leadId)],
          [childId, shell(childId, workerId)],
        ]),
        replaced,
      ),
    ),
  );
});

it.effect.each(["pending", "running"] as const)(
  "admits only the current %s diagnosis and rejects stale identities, descendants, and direction",
  (status) => {
    const diagnosisId = ThreadId.make("diagnosis");
    const incident = {
      id: "incident",
      phase: "diagnosing" as const,
      diagnosisThreadId: diagnosisId,
      reason: "Investigate the stopped team",
      evidence: [],
    };
    const snapshot: FactorySnapshot = {
      ...state,
      assignments: state.assignments.map((entry) => ({
        ...entry,
        oversight: { recovery: { cyclesUsed: 1, history: [], incident } },
      })),
      auxiliaryThreads: [
        {
          threadId: diagnosisId,
          assignmentId,
          managerId,
          projectId,
          kind: "diagnosis",
          incidentId: "incident",
          cycle: 1,
          status,
          modelSelection: state.managers[0]!.modelSelection,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    return Effect.gen(function* () {
      const access = yield* Access.FactoryControlAccess;
      yield* access.assertExecution(diagnosisId);
      assert.equal((yield* access.membership(diagnosisId))?.auxiliaryThreadId, diagnosisId);
      const controlTarget = (yield* access.membership(diagnosisId))!;
      const taken = Result.getOrThrow(
        decide({
          state: snapshot,
          actor: { kind: "human" },
          now,
          controlTarget,
          command: {
            type: "thread.takeover",
            commandId: CommandId.make("take-diagnosis"),
            threadId: diagnosisId,
          },
        }),
      );
      const takeover = taken.state.controls[0]!;
      assert.equal(takeover.kind === "takeover" ? takeover.parentThreadId : null, managerId);
      assert.equal(
        (yield* access.assertExecution(childId).pipe(Effect.flip)).code,
        "permission-denied",
      );
      assert.equal(
        (yield* access
          .assertDirection({ threadId: leadId, senderThreadId: diagnosisId })
          .pipe(Effect.flip)).code,
        "permission-denied",
      );
      yield* access.assertDirection({ threadId: diagnosisId, senderThreadId: managerId });
      for (const stale of [
        { ...incident, phase: "continuing" as const },
        { ...incident, id: "different-incident" },
        { ...incident, diagnosisThreadId: ThreadId.make("different-diagnosis") },
      ])
        yield* Effect.gen(function* () {
          const current = yield* Access.FactoryControlAccess;
          assert.equal((yield* current.membership(diagnosisId))?.assignmentId, assignmentId);
          assert.equal(
            (yield* current.assertExecution(diagnosisId).pipe(Effect.flip)).code,
            "permission-denied",
          );
          for (const senderThreadId of [managerId, undefined])
            assert.equal(
              (yield* current
                .assertDirection({ threadId: diagnosisId, senderThreadId })
                .pipe(Effect.flip)).code,
              "permission-denied",
            );
        }).pipe(
          Effect.provide(
            Layer.fresh(
              layer(new Map(), {
                ...snapshot,
                assignments: snapshot.assignments.map((entry) => ({
                  ...entry,
                  oversight: { recovery: { cyclesUsed: 1, history: [], incident: stale } },
                })),
              }),
            ),
          ),
        );
    }).pipe(Effect.provide(layer(new Map([[childId, shell(childId, diagnosisId)]]), snapshot)));
  },
);

it.effect(
  "gives the independent reviewer a logical lead parent and holds its direction during takeover",
  () => {
    const fixture = reviewedDeliveryFixture();
    const snapshot: FactorySnapshot = {
      ...fixture,
      auxiliaryThreads: fixture.auxiliaryThreads.map((entry) => ({ ...entry, status: "running" })),
      assignments: fixture.assignments.map((entry) => ({
        ...entry,
        delivery: {
          ...entry.delivery!,
          revisions: entry.delivery!.revisions.map((revision) => ({
            ...revision,
            reviews: revision.reviews.map((review) => ({ ...review, status: "running" })),
          })),
        },
      })),
    };
    return Effect.gen(function* () {
      const access = yield* Access.FactoryControlAccess;
      const controlTarget = (yield* access.membership(deliveryIds.reviewer))!;
      assert.deepStrictEqual(controlTarget.ancestorThreadIds, [deliveryIds.lead]);
      const taken = Result.getOrThrow(
        decide({
          state: snapshot,
          actor: { kind: "human" },
          now,
          controlTarget,
          command: {
            type: "thread.takeover",
            commandId: CommandId.make("take-reviewer"),
            threadId: deliveryIds.reviewer,
          },
        }),
      );
      const takeover = taken.state.controls[0]!;
      assert.equal(takeover.kind === "takeover" ? takeover.parentThreadId : null, deliveryIds.lead);
      yield* Effect.gen(function* () {
        const controlled = yield* Access.FactoryControlAccess;
        assert.equal(
          (yield* controlled
            .assertDirection({ threadId: deliveryIds.reviewer, senderThreadId: deliveryIds.lead })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        yield* controlled.assertDirection({
          threadId: deliveryIds.reviewer,
          senderThreadId: undefined,
        });
      }).pipe(Effect.provide(Layer.fresh(layer(new Map(), taken.state))));
    }).pipe(Effect.provide(layer(new Map(), snapshot)));
  },
);
