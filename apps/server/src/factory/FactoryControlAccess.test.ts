import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Access from "./FactoryControlAccess.ts";
import { FactoryStore } from "./FactoryStore.ts";
import { decide, initialFactorySnapshot } from "./FactoryState.ts";

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
      workflow: { repositoryRoot: "/skills", revision: "pinned" },
    },
    allocation: { managerThreadId: managerId, leadThreadId: leadId, assignmentId },
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
const layer = (shells: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>) =>
  Access.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(FactoryStore)({ snapshot: Effect.succeed(state) }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
        }),
      ),
    ),
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

it("uses actual human provenance and treats scheduled or unowned messages as automation", () => {
  assert.equal(Access.factoryDirectionSender({ createdBy: "user" }), undefined);
  assert.equal(Access.factoryDirectionSender({ createdBy: "system" }), null);
  assert.equal(
    Access.factoryDirectionSender({ createdBy: "user", senderThreadId: managerId }),
    managerId,
  );
});
