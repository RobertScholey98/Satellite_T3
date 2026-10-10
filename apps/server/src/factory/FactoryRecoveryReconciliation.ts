import { CommandId, FactoryError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { factoryRecoveryBlocked } from "./FactoryOversight.ts";
import { factoryAuxiliaryIsCurrent } from "./FactoryAuxiliary.ts";
import { factoryExecutionBlocked } from "./FactoryControls.ts";
import * as FactoryStore from "./FactoryStore.ts";

export class FactoryRecoveryReconciliation extends Context.Service<
  FactoryRecoveryReconciliation,
  {
    readonly handle: (
      pending: FactoryStore.PendingFactoryEffect,
    ) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryRecoveryReconciliation") {}

const failure = (cause: unknown) => new FactoryError({ code: "execution-unavailable", cause });

const make = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const events = yield* EventSink.EventSinkV2;

  return FactoryRecoveryReconciliation.of({
    handle: Effect.fn("FactoryRecoveryReconciliation.handle")(function* (pending) {
      if (pending.intent.type !== "auxiliary.reconcile") return;
      const intent = pending.intent;
      for (;;) {
        const state = yield* store.snapshot;
        const auxiliary = state.auxiliaryThreads.find(
          (entry) => entry.threadId === intent.threadId,
        );
        const assignment = state.assignments.find((entry) => entry.id === auxiliary?.assignmentId);
        if (
          !auxiliary ||
          !assignment ||
          assignment.outcome ||
          assignment.status === "complete" ||
          auxiliary.status === "complete" ||
          auxiliary.status === "failed" ||
          auxiliary.findings ||
          !factoryAuxiliaryIsCurrent(assignment, auxiliary)
        ) {
          yield* store.retireEffect(pending.id);
          return;
        }
        if (
          auxiliary.status === "pending" ||
          (auxiliary.kind === "diagnosis"
            ? factoryRecoveryBlocked(state, assignment)
            : factoryExecutionBlocked(state, {
                threadId: auxiliary.threadId,
                managerId: assignment.managerId,
                projectId: assignment.projectId,
                assignmentId: assignment.id,
                ancestorThreadIds: [],
              })) !== undefined
        )
          return;
        if (
          (yield* store.pending).some(
            (entry) =>
              ((entry.intent.type === "auxiliary.launch" ||
                entry.intent.type === "delivery.review.launch" ||
                entry.intent.type === "thread.deliver") &&
                entry.intent.threadId === auxiliary.threadId) ||
              (entry.intent.type === "delivery.preview.start" &&
                entry.intent.assignmentId === assignment.id &&
                entry.intent.revisionId === auxiliary.revisionId),
          )
        )
          return;
        yield* store.beginEffect(pending.id);
        const sequence = yield* events.latestSequence().pipe(Effect.mapError(failure));
        const shells = yield* threads
          .listProjectThreads({
            projectId: auxiliary.projectId,
            includeSubagents: true,
          })
          .pipe(Effect.mapError(failure));
        const team = new Set([auxiliary.threadId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const shell of shells) {
            if (
              shell.lineage.parentThreadId !== null &&
              team.has(shell.lineage.parentThreadId) &&
              !team.has(shell.id)
            ) {
              team.add(shell.id);
              changed = true;
            }
          }
        }
        let active = false;
        let waiting = false;
        for (const threadId of team) {
          const shell = shells.find((entry) => entry.id === threadId);
          if (!shell || shell.deletedAt !== null) continue;
          const records = yield* threads
            .getThreadRecords(threadId, ["runs", "runtimeRequests", "subagents"])
            .pipe(Effect.mapError(failure));
          waiting ||=
            records.runtimeRequests.some((request) => request.status === "pending") ||
            records.runs.some((run) => run.status === "queued" && run.queueHeld);
          active ||=
            records.runs.some((run) =>
              ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
            ) ||
            records.subagents.some((child) =>
              ["idle", "pending", "running", "waiting"].includes(child.status),
            );
        }
        if (waiting) return;
        if (
          (yield* store.snapshot).revision !== state.revision ||
          (yield* events.latestSequence().pipe(Effect.mapError(failure))) !== sequence
        )
          continue;
        yield* store.finishEffect({
          id: pending.id,
          now: DateTime.formatIso(yield* DateTime.now),
          command: {
            type: "auxiliary.reconciled",
            commandId: CommandId.make(`${pending.id}:receipt`),
            threadId: auxiliary.threadId,
            triggerId: intent.triggerId,
            observation: active
              ? { kind: "active" }
              : {
                  kind: "failed",
                  reason:
                    auxiliary.kind === "diagnosis"
                      ? "The independent diagnosis stopped without reporting findings. Its transcript and inspected evidence are preserved; review them before authorizing further recovery."
                      : "The independent candidate review stopped without reporting findings. Its transcript and candidate are preserved. Request another review or address its recorded blocker.",
                },
          },
        });
        return;
      }
    }),
  });
});

export const layer = Layer.effect(FactoryRecoveryReconciliation, make);
