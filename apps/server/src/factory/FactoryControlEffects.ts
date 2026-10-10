import {
  CommandId,
  FactoryError,
  type FactoryAssignment,
  type FactoryControl,
  type FactoryEffectIntent,
  type FactorySnapshot,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
import { factoryAuxiliaryIsCurrent } from "./FactoryAuxiliary.ts";
import { FactoryControlAccess } from "./FactoryControlAccess.ts";
import { FactoryHandover } from "./FactoryHandover.ts";
import { FactoryStore, type PendingFactoryEffect } from "./FactoryStore.ts";

export class FactoryControlEffects extends Context.Service<
  FactoryControlEffects,
  {
    readonly run: (pending: PendingFactoryEffect) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryControlEffects") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (cause: unknown) => new FactoryError({ code: "execution-unavailable", cause });
const diagnosisCanResume = (
  state: FactorySnapshot,
  assignment: FactoryAssignment | undefined,
  threadId: ThreadId,
) => {
  const auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === threadId);
  const incident = assignment?.oversight?.recovery.incident;
  return (
    auxiliary?.status === "running" &&
    auxiliary.assignmentId === assignment?.id &&
    incident?.id === auxiliary.incidentId &&
    incident.phase === "diagnosing" &&
    incident.diagnosisThreadId === auxiliary.threadId &&
    assignment?.wait?.kind === "recovery"
  );
};

const currentRetrospective = (
  state: FactorySnapshot,
  assignment: FactoryAssignment | undefined,
  threadId: ThreadId,
) => {
  const auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === threadId);
  return (
    auxiliary?.kind === "retrospective" &&
    factoryAuxiliaryIsCurrent(assignment, auxiliary, state.retros)
  );
};

const currentDeliveryReviewNotice = (
  state: FactorySnapshot,
  assignment: FactoryAssignment | undefined,
  intent: Extract<FactoryEffectIntent, { type: "thread.deliver" }>,
) => {
  const purpose = intent.purpose;
  if (purpose?.kind !== "delivery-review" || !assignment) return false;
  const auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === intent.threadId);
  const revision = assignment.delivery?.revisions.find((entry) => entry.id === purpose.revisionId);
  const preview = revision?.preview;
  return (
    auxiliary?.kind === "delivery-review" &&
    auxiliary.assignmentId === assignment.id &&
    auxiliary.revisionId === purpose.revisionId &&
    auxiliary.incidentId === purpose.reviewId &&
    factoryAuxiliaryIsCurrent(assignment, auxiliary, state.retros) &&
    preview?.instanceId === purpose.instanceId &&
    preview.reviewId === purpose.reviewId &&
    preview.threadId === intent.threadId &&
    ["ready", "failed"].includes(preview.status) &&
    intent.sourceThreadId === assignment.threadId
  );
};

export const layer = Layer.effect(
  FactoryControlEffects,
  Effect.gen(function* () {
    const store = yield* FactoryStore;
    const threads = yield* ThreadManagementService;
    const boundaries = yield* FactoryBoundaryExecution;
    const handovers = yield* FactoryHandover;
    const access = yield* FactoryControlAccess;

    const targets = (
      state: FactorySnapshot,
      control: FactoryControl,
    ): ReadonlyArray<{ threadId: ThreadId; projectId: ProjectId }> => {
      switch (control.kind) {
        case "takeover":
          return [];
        case "manager-pause": {
          const manager = state.managers.find((entry) => entry.id === control.managerId);
          return manager === undefined
            ? []
            : [
                {
                  threadId: manager.threadId,
                  projectId:
                    manager.role === "system" ? manager.workspaceProjectId : manager.projectId,
                },
              ];
        }
        case "cancellation": {
          const assignment = state.assignments.find((entry) => entry.id === control.assignmentId);
          return [
            ...(assignment === undefined
              ? []
              : [{ threadId: assignment.threadId, projectId: assignment.projectId }]),
            ...state.auxiliaryThreads
              .filter((entry) => entry.assignmentId === control.assignmentId)
              .map((entry) => ({ threadId: entry.threadId, projectId: entry.projectId })),
          ];
        }
        case "project-pause":
          return [
            ...state.managers
              .filter((entry) => entry.projectId === control.projectId)
              .map((entry) => ({ threadId: entry.threadId, projectId: control.projectId })),
            ...state.assignments
              .filter((entry) => entry.projectId === control.projectId)
              .map((entry) => ({ threadId: entry.threadId, projectId: entry.projectId })),
            ...state.auxiliaryThreads
              .filter((entry) => entry.projectId === control.projectId)
              .map((entry) => ({ threadId: entry.threadId, projectId: entry.projectId })),
          ];
      }
    };
    const descendants = Effect.fn("FactoryControlEffects.descendants")(function* (root: {
      threadId: ThreadId;
      projectId: ProjectId;
    }) {
      const projectThreads = yield* threads
        .listProjectThreads({ projectId: root.projectId, includeSubagents: true })
        .pipe(Effect.mapError(failure));
      const affected = new Set<ThreadId>([root.threadId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const thread of projectThreads) {
          if (
            thread.lineage.parentThreadId !== null &&
            affected.has(thread.lineage.parentThreadId) &&
            !affected.has(thread.id)
          ) {
            affected.add(thread.id);
            changed = true;
          }
        }
      }
      return projectThreads.filter((entry) => affected.has(entry.id) && entry.deletedAt === null);
    });

    const stop = Effect.fn("FactoryControlEffects.stop")(function* (pending: PendingFactoryEffect) {
      if (pending.intent.type !== "control.stop") return;
      const intent = pending.intent;
      const state = yield* store.snapshot;
      const control = state.controls.find((entry) => entry.id === intent.controlId);
      if (
        !control ||
        control.kind === "takeover" ||
        control.generation !== intent.generation ||
        (control.kind !== "cancellation" && control.status === "released")
      ) {
        yield* store.retireEffect(pending.id);
        return;
      }
      const roots = targets(state, control);
      yield* store.beginEffect(pending.id);
      const result = yield* Effect.gen(function* () {
        const failures: FactoryError[] = [];
        if (control.kind !== "cancellation" && control.resumeThreadIds === undefined) {
          const captured = yield* Effect.gen(function* () {
            const resumeThreadIds = new Set<ThreadId>();
            const resumeQueues: Array<{ threadId: ThreadId; runIds: RunId[] }> = [];
            for (const root of roots) {
              for (const thread of yield* descendants(root)) {
                const records = yield* threads
                  .getThreadRecords(thread.id, ["runs"])
                  .pipe(Effect.mapError(failure));
                if (
                  records.runs.some((run) =>
                    ["preparing", "starting", "running", "waiting"].includes(run.status),
                  )
                )
                  resumeThreadIds.add(thread.id);
                const runIds = records.runs
                  .filter((run) => run.status === "queued" && !run.queueHeld)
                  .map((run) => run.id);
                if (runIds.length > 0) resumeQueues.push({ threadId: thread.id, runIds });
              }
            }
            yield* store.commit({
              actor: { kind: "system" },
              command: {
                type: "control.stop.targets.recorded",
                commandId: CommandId.make(`${pending.id}:targets`),
                controlId: control.id,
                generation: control.generation,
                threadIds: [...resumeThreadIds],
                resumeQueues,
              },
              now: yield* nowIso,
            });
          }).pipe(Effect.result);
          if (Result.isFailure(captured)) failures.push(captured.failure);
        }
        const operations: Effect.Effect<unknown, FactoryError>[] = [];
        if (control.kind === "cancellation") operations.push(boundaries.stop(control.assignmentId));
        if (control.kind === "project-pause") {
          for (const assignment of state.assignments.filter(
            (entry) =>
              entry.projectId === control.projectId &&
              entry.outcome === undefined &&
              (entry.completion === undefined || entry.completion.phase === "collecting"),
          ))
            operations.push(
              boundaries.suspend({ assignmentId: assignment.id, generation: control.generation }),
            );
        }
        // Admission was closed by the durable command. Attempt every stop even if one runtime is unavailable.
        for (const operation of operations) {
          const stopped = yield* operation.pipe(Effect.result);
          if (Result.isFailure(stopped)) failures.push(stopped.failure);
        }
        for (const root of roots) {
          const stopped = yield* Effect.gen(function* () {
            if ((yield* threads.getThreadShell(root.threadId)) !== null)
              yield* handovers.stopTeam({
                ...root,
                commandId: CommandId.make(`factory:${pending.id}:stop`),
              });
          }).pipe(Effect.mapError(failure), Effect.result);
          if (Result.isFailure(stopped)) failures.push(stopped.failure);
        }
        if (failures[0] !== undefined) return yield* failures[0];
      }).pipe(Effect.result);
      if (Result.isFailure(result))
        yield* Effect.logError("Factory team stop was not confirmed", {
          controlId: control.id,
          cause: result.failure,
        });
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        failed: Result.isFailure(result),
        command: {
          ...(Result.isFailure(result)
            ? {
                type: "control.stop.failed" as const,
                reason:
                  "Stopping could not be confirmed for every affected runtime. Work is preserved and remains blocked; retry stopping.",
              }
            : { type: "control.stop.recorded" as const }),
          commandId: CommandId.make(`${pending.id}:receipt`),
          controlId: control.id,
          generation: control.generation,
        },
      });
    });

    const resume = Effect.fn("FactoryControlEffects.resume")(function* (
      pending: PendingFactoryEffect,
    ) {
      if (pending.intent.type !== "control.resume") return;
      const intent = pending.intent;
      const state = yield* store.snapshot;
      const control = state.controls.find((entry) => entry.id === intent.controlId);
      if (
        !control ||
        control.kind === "takeover" ||
        control.kind === "cancellation" ||
        control.generation !== intent.generation ||
        control.status === "released"
      ) {
        yield* store.retireEffect(pending.id);
        return;
      }
      if (control.stop.status !== "confirmed" || control.resume?.status !== "pending") return;
      yield* store.beginEffect(pending.id);
      const result = yield* Effect.gen(function* () {
        if (control.kind !== "project-pause") return;
        const failures: FactoryError[] = [];
        for (const assignment of state.assignments.filter(
          (entry) =>
            entry.projectId === control.projectId &&
            entry.outcome === undefined &&
            (entry.completion === undefined || entry.completion.phase === "collecting") &&
            entry.wait?.kind !== "authority",
        )) {
          const resumed = yield* boundaries
            .resume({ assignmentId: assignment.id, generation: control.generation })
            .pipe(Effect.result);
          if (Result.isFailure(resumed)) failures.push(resumed.failure);
        }
        if (failures[0] !== undefined) return yield* failures[0];
      }).pipe(Effect.result);
      if (Result.isFailure(result))
        yield* Effect.logError("Factory project resume failed", {
          controlId: control.id,
          cause: result.failure,
        });
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        failed: Result.isFailure(result),
        command: {
          ...(Result.isFailure(result)
            ? {
                type: "control.resume.failed" as const,
                reason:
                  "The preserved project runtimes could not be resumed. The project remains paused; retry resume.",
              }
            : { type: "control.resume.recorded" as const }),
          commandId: CommandId.make(`${pending.id}:receipt`),
          controlId: control.id,
          generation: control.generation,
        },
      });
    });

    const deliver = Effect.fn("FactoryControlEffects.deliver")(function* (
      pending: PendingFactoryEffect,
    ) {
      if (pending.intent.type !== "thread.deliver") return;
      const intent = pending.intent;
      const member = yield* access.membership(intent.threadId);
      if (member === undefined) {
        yield* store.retireEffect(pending.id);
        return;
      }
      const state = yield* store.snapshot;
      const assignment = state.assignments.find((entry) => entry.id === member.assignmentId);
      const manager = state.managers.find((entry) => entry.id === member.managerId);
      const retrospective = currentRetrospective(state, assignment, intent.threadId);
      if (
        !retrospective &&
        (assignment?.outcome !== undefined ||
          (assignment?.status === "complete" && intent.kind !== "continuation"))
      ) {
        yield* store.retireEffect(pending.id);
        return;
      }
      let permitsWait = retrospective;
      if (intent.purpose !== undefined) {
        const purpose = intent.purpose;
        const dependency =
          purpose.kind === "dependency-usability"
            ? state.dependencies.find((entry) => entry.id === purpose.dependencyId)
            : undefined;
        const incident = assignment?.oversight?.recovery.incident;
        const current =
          assignment !== undefined &&
          (purpose.kind === "delivery-review"
            ? currentDeliveryReviewNotice(state, assignment, intent)
            : assignment.threadId === intent.threadId &&
              (purpose.kind === "dependency-usability"
                ? dependency?.assignmentId === assignment.id &&
                  dependency.state === "checking" &&
                  dependency.delivery?.id === purpose.deliveryId
                : purpose.kind === "delivery"
                  ? assignment.delivery?.currentRevisionId === purpose.revisionId
                  : purpose.kind === "delivery-flow"
                    ? assignment.delivery?.flow?.holdId === purpose.holdId &&
                      assignment.delivery.flow.status !== "stopping"
                    : incident?.id === purpose.incidentId && incident.phase === "continuing"));
        if (!current) {
          yield* store.retireEffect(pending.id);
          return;
        }
        permitsWait =
          purpose.kind === "dependency-usability"
            ? assignment?.wait?.kind === "dependency" &&
              assignment.wait.dependencyIds.some((id) => id === purpose.dependencyId)
            : purpose.kind === "recovery"
              ? assignment?.wait?.kind === "recovery"
              : purpose.kind === "delivery" || purpose.kind === "delivery-review"
                ? assignment?.wait?.kind === "review"
                : false;
      }
      if (
        intent.kind === "continuation" &&
        diagnosisCanResume(state, assignment, intent.threadId) &&
        state.controls.some(
          (control) =>
            control.kind === "project-pause" &&
            control.projectId === assignment?.projectId &&
            control.status === "released" &&
            control.stop.status === "confirmed" &&
            control.resumeThreadIds?.includes(intent.threadId) &&
            intent.messageId ===
              `factory-resume:${control.id}:${control.generation}:${intent.threadId}`,
        )
      )
        permitsWait = true;
      if (assignment?.wait != null && !permitsWait) return;
      if (
        intent.kind === "continuation" &&
        member.threadId === manager?.threadId &&
        manager.wait !== null
      )
        return;
      const allowed = yield* access
        .assertDirection({
          threadId: intent.threadId,
          senderThreadId: intent.sourceThreadId ?? null,
        })
        .pipe(Effect.result);
      if (Result.isFailure(allowed)) {
        if (allowed.failure.code === "permission-denied") return;
        return yield* allowed.failure;
      }
      const thread = yield* threads.getThreadShell(intent.threadId).pipe(Effect.mapError(failure));
      if (thread === null || thread.deletedAt !== null || thread.archivedAt !== null) return;
      yield* store.beginEffect(pending.id);
      const records = yield* threads
        .getThreadRecords(intent.threadId, ["messages", "runs"], { messageIds: [intent.messageId] })
        .pipe(Effect.mapError(failure));
      const accepted = records.messages.find((entry) => entry.id === intent.messageId);
      if (accepted === undefined) {
        if (retrospective) {
          const latest = yield* store.snapshot;
          const owner = latest.assignments.find((entry) => entry.id === member.assignmentId);
          if (!currentRetrospective(latest, owner, intent.threadId)) {
            yield* store.retireEffect(pending.id);
            return;
          }
          const allowed = yield* access
            .assertDirection({
              threadId: intent.threadId,
              senderThreadId: intent.sourceThreadId ?? null,
            })
            .pipe(Effect.result);
          if (Result.isFailure(allowed)) {
            if (allowed.failure.code === "permission-denied") return;
            return yield* allowed.failure;
          }
        }
        if (intent.purpose?.kind === "delivery-review") {
          const latest = yield* store.snapshot;
          const owner = latest.assignments.find((entry) => entry.id === member.assignmentId);
          if (!currentDeliveryReviewNotice(latest, owner, intent)) {
            yield* store.retireEffect(pending.id);
            return;
          }
          if (owner?.wait != null && owner.wait.kind !== "review") return;
          const allowed = yield* access
            .assertDirection({ threadId: intent.threadId, senderThreadId: intent.sourceThreadId })
            .pipe(Effect.result);
          if (Result.isFailure(allowed)) {
            if (allowed.failure.code === "permission-denied") return;
            return yield* allowed.failure;
          }
        }
        yield* threads
          .sendToThread({
            projectId: member.projectId,
            threadId: intent.threadId,
            messageId: intent.messageId,
            commandId: CommandId.make(`factory:${pending.id}:deliver`),
            text: intent.text,
            ...(intent.sourceThreadId === undefined
              ? {}
              : { senderThreadId: intent.sourceThreadId }),
            attachments: [],
            mode: "auto",
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(Effect.mapError(failure));
      } else if (!records.runs.some((entry) => entry.id === accepted.runId))
        return yield* new FactoryError({ code: "invalid-state" });
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        command: {
          type: "thread.delivery.recorded",
          commandId: CommandId.make(`${pending.id}:receipt`),
          threadId: intent.threadId,
          messageId: intent.messageId,
        },
      });
    });

    const queue = Effect.fn("FactoryControlEffects.queue")(function* (
      pending: PendingFactoryEffect,
    ) {
      if (pending.intent.type !== "thread.queue.resume") return;
      const intent = pending.intent;
      const state = yield* store.snapshot;
      const control = state.controls.find((entry) => entry.id === intent.controlId);
      if (
        !control ||
        control.kind === "cancellation" ||
        control.generation < intent.generation ||
        (intent.runIds === undefined && control.generation !== intent.generation)
      ) {
        yield* store.retireEffect(pending.id);
        return;
      }
      if (control.status !== "released") return;
      const member = yield* access.membership(intent.threadId);
      if (!member) return yield* new FactoryError({ code: "invalid-state" });
      const assignment = state.assignments.find((entry) => entry.id === member.assignmentId);
      const retrospective = currentRetrospective(state, assignment, intent.threadId);
      if (assignment?.outcome !== undefined && !retrospective) {
        yield* store.retireEffect(pending.id);
        return;
      }
      if (
        assignment?.wait != null &&
        !retrospective &&
        !(
          diagnosisCanResume(state, assignment, intent.threadId) &&
          control.kind === "project-pause" &&
          control.projectId === assignment.projectId &&
          control.generation === intent.generation &&
          control.stop.status === "confirmed" &&
          intent.runIds !== undefined &&
          intent.runIds.length > 0 &&
          control.resumeQueues?.some(
            (queue) =>
              queue.threadId === intent.threadId &&
              intent.runIds?.every((runId) => queue.runIds.includes(runId)),
          )
        )
      )
        return;
      yield* store.beginEffect(pending.id);
      const affected =
        intent.runIds === undefined ? yield* descendants(member) : [{ id: intent.threadId }];
      for (const thread of affected) {
        const allowed = yield* access.assertExecution(thread.id).pipe(Effect.result);
        if (Result.isFailure(allowed)) {
          if (allowed.failure.code === "permission-denied") return;
          return yield* allowed.failure;
        }
        const records = yield* threads
          .getThreadRecords(thread.id, ["runs"])
          .pipe(Effect.mapError(failure));
        if (
          intent.runIds === undefined &&
          records.runs.some((run) => run.status === "queued" && run.queueHeld)
        )
          continue;
        yield* threads
          .dispatch({
            type: "queue.resume",
            threadId: thread.id,
            commandId: CommandId.make(`factory:${pending.id}:queue:${thread.id}`),
            ...(intent.runIds === undefined ? {} : { runIds: intent.runIds }),
          })
          .pipe(Effect.mapError(failure));
      }
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        command: {
          type: "thread.queue.resumed",
          commandId: CommandId.make(`${pending.id}:receipt`),
          threadId: intent.threadId,
          controlId: intent.controlId,
          generation: intent.generation,
        },
      });
    });
    return FactoryControlEffects.of({
      run: (pending) => {
        switch (pending.intent.type) {
          case "control.stop":
            return stop(pending);
          case "control.resume":
            return resume(pending);
          case "thread.deliver":
            return deliver(pending);
          case "thread.queue.resume":
            return queue(pending);
          default:
            return Effect.void;
        }
      },
    });
  }),
);
