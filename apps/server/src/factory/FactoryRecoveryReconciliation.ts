import { CommandId, FactoryError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

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
        if (auxiliary?.kind === "retrospective") {
          const retro = state.retros.find((entry) => entry.id === auxiliary.incidentId);
          if (
            !assignment ||
            !retro ||
            retro.execution.status !== "ready" ||
            retro.execution.launch !== "delivered" ||
            retro.reports.phase !== "team-pending" ||
            !factoryAuxiliaryIsCurrent(assignment, auxiliary, state.retros)
          ) {
            yield* store.retireEffect(pending.id);
            return;
          }
          if (
            factoryExecutionBlocked(state, {
              threadId: auxiliary.threadId,
              auxiliaryThreadId: auxiliary.threadId,
              assignmentId: assignment.id,
              managerId: assignment.managerId,
              projectId: assignment.projectId,
              ancestorThreadIds: [],
            }) !== undefined
          )
            return;
          if (
            (yield* store.pending).some(
              (entry) =>
                (entry.intent.type === "retro.launch" && entry.intent.retroId === retro.id) ||
                ((entry.intent.type === "thread.deliver" ||
                  entry.intent.type === "thread.queue.resume") &&
                  entry.intent.threadId === auxiliary.threadId),
            )
          )
            return;
          const sequence = yield* events.latestSequence().pipe(Effect.mapError(failure));
          const records = yield* threads
            .getThreadRecords(auxiliary.threadId, ["runs", "runtimeRequests"])
            .pipe(Effect.mapError(failure));
          if (records.runtimeRequests.some((request) => request.status === "pending")) return;
          if (
            (yield* store.snapshot).revision !== state.revision ||
            (yield* events.latestSequence().pipe(Effect.mapError(failure))) !== sequence
          )
            continue;
          const active = records.runs.some((run) =>
            ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
          );
          if (
            !active &&
            records.runs.some((run) =>
              ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
                run.status,
              ),
            )
          ) {
            const recorded = yield* store
              .commit({
                actor: { kind: "system" },
                now: DateTime.formatIso(yield* DateTime.now),
                command: {
                  type: "retro.failed",
                  commandId: CommandId.make(`${pending.id}:retro-terminal`),
                  retroId: retro.id,
                  expectedStateRevision: state.revision,
                  reason:
                    "The retrospective run stopped without submitting its team report. Its conversation and preserved evidence remain available. Review its last message, then retry the retrospective to finish the report.",
                },
              })
              .pipe(Effect.result);
            if (Result.isFailure(recorded)) {
              if (recorded.failure.code === "stale-revision") continue;
              return yield* recorded.failure;
            }
          }
          yield* store.retireEffect(pending.id);
          return;
        }
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
              shell.lineage.relationshipToParent === "subagent" &&
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
