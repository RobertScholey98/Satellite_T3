import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { deliveryFixture, deliveryIds } from "./FactoryDelivery.testkit.ts";
import { resolveFactoryLineage } from "./FactoryLineage.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";

type Shell = Pick<OrchestrationV2ThreadShell, "projectId" | "deletedAt" | "lineage">;

const managedProject = deliveryIds.project;
const otherProject = ProjectId.make("other");
const shell = (
  projectId: ProjectId,
  parentThreadId: ThreadId | null = null,
  relationshipToParent: "fork" | "subagent" | null = parentThreadId === null ? null : "subagent",
): Shell => ({
  projectId,
  deletedAt: null,
  lineage: {
    rootThreadId: parentThreadId ?? ThreadId.make("root"),
    parentThreadId,
    relationshipToParent,
  },
});

// Counts projection reads so tests can prove which walks touch the store.
const projection = (shells: Record<string, Shell>) => {
  const reads: ThreadId[] = [];
  return {
    reads,
    getThreadShell: (threadId: ThreadId) =>
      Effect.sync(() => {
        reads.push(threadId);
        return shells[threadId] ?? null;
      }),
  };
};

describe("resolveFactoryLineage", () => {
  it.effect("reads nothing when no manager exists", () =>
    Effect.gen(function* () {
      const store = projection({
        child: shell(managedProject, ThreadId.make("deleted"), "subagent"),
      });
      const match = yield* resolveFactoryLineage({
        state: initialFactorySnapshot(),
        threadId: ThreadId.make("child"),
        pendingParentThreadId: ThreadId.make("pending"),
        getThreadShell: store.getThreadShell,
      });
      assert.isUndefined(match);
      assert.deepStrictEqual(store.reads, []);
    }),
  );

  it.effect("does not enroll a fork of a managed lead or its subagents", () =>
    Effect.gen(function* () {
      const store = projection({
        fork: shell(managedProject, deliveryIds.lead, "fork"),
        "fork-child": shell(managedProject, ThreadId.make("fork"), "subagent"),
      });
      for (const threadId of ["fork", "fork-child"])
        assert.isUndefined(
          yield* resolveFactoryLineage({
            state: deliveryFixture(),
            threadId: ThreadId.make(threadId),
            getThreadShell: store.getThreadShell,
          }),
        );
    }),
  );

  it.effect("enrolls subagents of a managed lead", () =>
    Effect.gen(function* () {
      const store = projection({
        worker: shell(managedProject, deliveryIds.lead, "subagent"),
      });
      const match = yield* resolveFactoryLineage({
        state: deliveryFixture(),
        threadId: ThreadId.make("worker"),
        getThreadShell: store.getThreadShell,
      });
      assert.equal(match?.threadId, deliveryIds.lead);
      assert.deepStrictEqual(match?.ancestorThreadIds, [deliveryIds.lead]);
      assert.equal(match?.assignment?.threadId, deliveryIds.lead);
    }),
  );

  it.effect("treats a broken chain as ordinary outside managed projects only", () =>
    Effect.gen(function* () {
      const store = projection({
        ordinary: shell(otherProject, ThreadId.make("deleted"), "subagent"),
        orphan: shell(otherProject, null, "subagent"),
        managed: shell(managedProject, ThreadId.make("deleted"), "subagent"),
        cycle: shell(otherProject, ThreadId.make("cycle"), "subagent"),
      });
      const resolve = (threadId: string) =>
        resolveFactoryLineage({
          state: deliveryFixture(),
          threadId: ThreadId.make(threadId),
          getThreadShell: store.getThreadShell,
        });
      assert.isUndefined(yield* resolve("ordinary"));
      assert.isUndefined(yield* resolve("orphan"));
      assert.equal((yield* resolve("managed").pipe(Effect.flip)).code, "execution-unavailable");
      assert.equal((yield* resolve("cycle").pipe(Effect.flip)).code, "execution-unavailable");
    }),
  );
});
