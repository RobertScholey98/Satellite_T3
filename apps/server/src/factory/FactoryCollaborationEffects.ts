import {
  CommandId,
  FactoryError,
  MessageId,
  type FactorySnapshot,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
import { FactoryControlAccess } from "./FactoryControlAccess.ts";
import { FactoryHandover } from "./FactoryHandover.ts";
import { FactoryPreviewService } from "./FactoryPreviewService.ts";
import { FactoryStore, type PendingFactoryEffect } from "./FactoryStore.ts";
import {
  factoryCollaborationConditionSatisfied,
  factoryRequestParticipants,
  factoryRequestReconsiderable,
} from "./FactoryCollaboration.ts";

export class FactoryCollaborationEffects extends Context.Service<
  FactoryCollaborationEffects,
  {
    readonly reconcile: Effect.Effect<void, FactoryError>;
    readonly handle: (pending: PendingFactoryEffect) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryCollaborationEffects") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (cause: unknown) => new FactoryError({ code: "execution-unavailable", cause });
const make = Effect.gen(function* () {
  const store = yield* FactoryStore;
  const threads = yield* ThreadManagementService;
  const boundaries = yield* FactoryBoundaryExecution;
  const handovers = yield* FactoryHandover;
  const access = yield* FactoryControlAccess;
  const previews = yield* FactoryPreviewService;
  const accepted = Effect.fn(function* (threadId: ThreadId, messageId: MessageId) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure));
    if (!shell) return false;
    const records = yield* threads
      .getThreadRecords(threadId, ["messages", "runs"], { messageIds: [messageId] })
      .pipe(Effect.mapError(failure));
    const message = records.messages.find((entry) => entry.id === messageId);
    if (!message) return false;
    if (!records.runs.some((entry) => entry.id === message.runId))
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "A peer message exists without its durable run.",
      });
    return true;
  });
  const allowed = Effect.fn(function* (threadId: ThreadId, senderThreadId?: ThreadId) {
    const result = yield* access
      .assertDirection({ threadId, senderThreadId: senderThreadId ?? null })
      .pipe(Effect.result);
    if (Result.isFailure(result)) {
      if (result.failure.code === "permission-denied") return false;
      return yield* result.failure;
    }
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure));
    return shell !== null && shell.deletedAt === null && shell.archivedAt === null;
  });
  const message = Effect.fn(function* (pending: PendingFactoryEffect) {
    if (pending.intent.type !== "collaboration.message.deliver") return;
    const id = pending.intent.messageId;
    const state = yield* store.snapshot;
    const entry = state.collaborationMessages.find((item) => item.id === id);
    if (!entry || entry.delivery.phase === "delivered") {
      yield* store.retireEffect(pending.id);
      return;
    }
    const recipient = state.assignments.find((item) => item.id === entry.toAssignmentId);
    const messageId = MessageId.make(`factory:peer:${entry.id}`);
    // Reconcile a lost acknowledgement before testing whether new delivery is still allowed.
    for (const threadId of recipient
      ? [recipient.threadId, ...(recipient.previousLeadThreadIds ?? [])]
      : []) {
      if (yield* accepted(threadId, messageId)) {
        yield* store.finishEffect({
          id: pending.id,
          now: yield* nowIso,
          command: {
            type: "collaboration.message.recorded",
            commandId: CommandId.make(`${pending.id}:receipt`),
            messageId: id,
            recipientThreadId: threadId,
            deliveredMessageId: messageId,
          },
        });
        return;
      }
    }
    const request = state.crossProjectRequests.find((item) => item.id === entry.requestId);
    const participants = request ? factoryRequestParticipants(state, request) : [];
    const source = participants.find((item) => item.id === entry.fromAssignmentId);
    if (
      !source ||
      !recipient ||
      source.threadId !== entry.senderThreadId ||
      source.outcome ||
      recipient.outcome ||
      source.status === "complete" ||
      recipient.status === "complete" ||
      (source.completion !== undefined && source.completion.phase !== "collecting") ||
      (recipient.completion !== undefined && recipient.completion.phase !== "collecting") ||
      !participants.some((item) => item.id === recipient.id)
    ) {
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        failed: true,
        command: {
          type: "collaboration.message.failed",
          commandId: CommandId.make(`${pending.id}:obsolete`),
          messageId: id,
          reason: "This request or its current implementation leads changed before delivery.",
        },
      });
      return;
    }
    if (
      !(yield* allowed(source.threadId)) ||
      !(yield* allowed(recipient.threadId, source.threadId))
    )
      return;
    yield* store.beginEffect(pending.id);
    const sent = yield* threads
      .sendToThread({
        projectId: recipient.projectId,
        threadId: recipient.threadId,
        messageId,
        commandId: CommandId.make(`factory:${pending.id}:deliver`),
        // Framed so the recipient does not mistake a peer for its own manager.
        text: `[Peer lead message for request ${entry.requestId} from assignment ${source.id}. Your own manager's direction and boundaries still govern your work.]\n${entry.text}`,
        senderThreadId: source.threadId,
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.mapError(failure), Effect.result);
    if (Result.isFailure(sent) && !(yield* accepted(recipient.threadId, messageId))) {
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        failed: true,
        command: {
          type: "collaboration.message.failed",
          commandId: CommandId.make(`${pending.id}:failed`),
          messageId: id,
          reason: sent.failure.message,
        },
      });
      return;
    }
    yield* store.finishEffect({
      id: pending.id,
      now: yield* nowIso,
      command: {
        type: "collaboration.message.recorded",
        commandId: CommandId.make(`${pending.id}:receipt`),
        messageId: id,
        recipientThreadId: recipient.threadId,
        deliveredMessageId: messageId,
      },
    });
  });
  const notify = Effect.fn(function* (pending: PendingFactoryEffect) {
    if (pending.intent.type !== "collaboration.notify") return;
    const intent = pending.intent;
    const state = yield* store.snapshot;
    const recipients = [
      ...state.managers
        .filter((entry) => intent.recipientManagerIds.includes(entry.id))
        .map((entry) => ({
          id: entry.id,
          threadId: entry.threadId,
          projectId: entry.role === "system" ? entry.workspaceProjectId : entry.projectId,
        })),
      ...state.assignments
        .filter(
          (entry) =>
            intent.recipientAssignmentIds.includes(entry.id) &&
            !entry.outcome &&
            entry.status !== "complete" &&
            (entry.completion === undefined || entry.completion.phase === "collecting"),
        )
        .map((entry) => ({ id: entry.id, threadId: entry.threadId, projectId: entry.projectId })),
    ];
    yield* store.beginEffect(pending.id);
    let held = false;
    for (const target of recipients) {
      const messageId = MessageId.make(`factory:collaboration:${pending.id}:${target.id}`);
      if (yield* accepted(target.threadId, messageId)) continue;
      if (!(yield* allowed(target.threadId))) {
        held = true;
        continue;
      }
      const sent = yield* threads
        .sendToThread({
          projectId: target.projectId,
          threadId: target.threadId,
          messageId,
          commandId: CommandId.make(`${pending.id}:${target.id}:notify`),
          text: `[${intent.subject.kind} ${intent.subject.id}]\n${intent.text}`,
          attachments: [],
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.result);
      if (Result.isFailure(sent)) held = true;
    }
    if (!held) yield* store.retireEffect(pending.id);
  });
  const roots = (state: FactorySnapshot, assignmentIds: readonly string[]) =>
    state.assignments
      .filter((entry) => assignmentIds.includes(entry.id))
      .flatMap((assignment) => [
        { threadId: assignment.threadId, projectId: assignment.projectId },
        ...(assignment.previousLeadThreadIds ?? []).map((threadId) => ({
          threadId,
          projectId: assignment.projectId,
        })),
        ...state.auxiliaryThreads
          .filter((entry) => entry.assignmentId === assignment.id && entry.kind !== "retrospective")
          .map((entry) => ({ threadId: entry.threadId, projectId: entry.projectId })),
      ]);
  const incident = Effect.fn(function* (pending: PendingFactoryEffect) {
    if (pending.intent.type !== "incident.stop" && pending.intent.type !== "incident.resume")
      return;
    const intent = pending.intent;
    const state = yield* store.snapshot;
    const restriction = state.incidentRestrictions.find(
      (entry) => entry.id === intent.restrictionId,
    );
    const stopping = intent.type === "incident.stop";
    if (
      !restriction ||
      (stopping
        ? restriction.phase !== "active" || restriction.stop.phase === "confirmed"
        : restriction.phase !== "releasing")
    ) {
      yield* store.retireEffect(pending.id);
      return;
    }
    yield* store.beginEffect(pending.id);
    const result = yield* Effect.gen(function* () {
      const affected = roots(state, restriction.assignmentIds);
      const failures: FactoryError[] = [];
      if (restriction.activity === "execution") {
        if (stopping && restriction.resumeThreadIds === undefined) {
          const captured = yield* Effect.gen(function* () {
            const threadIds = new Set<ThreadId>();
            const resumeQueues: Array<{ threadId: ThreadId; runIds: RunId[] }> = [];
            const seen = new Set<ThreadId>();
            for (const root of affected) {
              const projectThreads = yield* threads
                .listProjectThreads({ projectId: root.projectId, includeSubagents: true })
                .pipe(Effect.mapError(failure));
              const descendants = new Set<ThreadId>([root.threadId]);
              let changed = true;
              while (changed) {
                changed = false;
                for (const thread of projectThreads)
                  if (
                    thread.lineage.relationshipToParent === "subagent" &&
                    thread.lineage.parentThreadId &&
                    descendants.has(thread.lineage.parentThreadId) &&
                    !descendants.has(thread.id)
                  ) {
                    descendants.add(thread.id);
                    changed = true;
                  }
              }
              for (const thread of projectThreads.filter(
                (entry) =>
                  descendants.has(entry.id) && entry.deletedAt === null && !seen.has(entry.id),
              )) {
                seen.add(thread.id);
                const records = yield* threads
                  .getThreadRecords(thread.id, ["runs"])
                  .pipe(Effect.mapError(failure));
                if (
                  records.runs.some((run) =>
                    ["preparing", "starting", "running", "waiting"].includes(run.status),
                  )
                )
                  threadIds.add(thread.id);
                const runIds = records.runs
                  .filter((run) => run.status === "queued" && !run.queueHeld)
                  .map((run) => run.id);
                if (runIds.length) resumeQueues.push({ threadId: thread.id, runIds });
              }
            }
            yield* store.commit({
              actor: { kind: "system" },
              command: {
                type: "incident.targets.recorded",
                commandId: CommandId.make(`${pending.id}:targets`),
                restrictionId: restriction.id,
                threadIds: [...threadIds],
                resumeQueues,
              },
              now: yield* nowIso,
            });
          }).pipe(Effect.result);
          if (Result.isFailure(captured)) failures.push(captured.failure);
        }
        for (const assignmentId of restriction.assignmentIds) {
          const result = yield* boundaries
            .setIncidentHold({ assignmentId, restrictionId: restriction.id, held: stopping })
            .pipe(Effect.result);
          if (Result.isFailure(result)) failures.push(result.failure);
        }
        if (stopping)
          for (const root of affected) {
            const shell = yield* threads
              .getThreadShell(root.threadId)
              .pipe(Effect.mapError(failure));
            if (!shell) continue;
            const result = yield* handovers
              .stopTeam({
                ...root,
                commandId: CommandId.make(`${pending.id}:stop:${root.threadId}`),
              })
              .pipe(Effect.result);
            if (Result.isFailure(result)) failures.push(result.failure);
          }
      }
      if (stopping && restriction.activity !== "delivery") {
        const result = yield* previews.reconcile.pipe(Effect.result);
        if (Result.isFailure(result)) failures.push(result.failure);
      }
      if (failures[0]) return yield* failures[0];
    }).pipe(Effect.result);
    yield* store.finishEffect({
      id: pending.id,
      now: yield* nowIso,
      ...(Result.isFailure(result) ? { failed: true } : {}),
      command: Result.isFailure(result)
        ? {
            type: "incident.failed",
            commandId: CommandId.make(`${pending.id}:failed`),
            restrictionId: restriction.id,
            step: stopping ? "stop" : "resume",
            reason: result.failure.message,
          }
        : {
            type: stopping ? "incident.stopped" : "incident.resumed",
            commandId: CommandId.make(`${pending.id}:receipt`),
            restrictionId: restriction.id,
          },
    });
  });
  const queue = Effect.fn(function* (pending: PendingFactoryEffect) {
    if (pending.intent.type !== "incident.queue.resume") return;
    const intent = pending.intent;
    const state = yield* store.snapshot;
    const restriction = state.incidentRestrictions.find(
      (entry) => entry.id === intent.restrictionId,
    );
    if (
      restriction?.phase !== "released" ||
      !restriction.resumeQueues?.some(
        (entry) =>
          entry.threadId === intent.threadId &&
          intent.runIds.every((id) => entry.runIds.includes(id)),
      )
    ) {
      yield* store.retireEffect(pending.id);
      return;
    }
    if (!(yield* allowed(intent.threadId))) return;
    yield* threads
      .dispatch({
        type: "queue.resume",
        threadId: intent.threadId,
        runIds: intent.runIds,
        commandId: CommandId.make(`${pending.id}:queue`),
      })
      .pipe(Effect.mapError(failure));
    yield* store.retireEffect(pending.id);
  });
  const reconcile = Effect.gen(function* () {
    const state = yield* store.snapshot;
    for (const restriction of state.incidentRestrictions)
      if (
        restriction.phase === "active" &&
        factoryCollaborationConditionSatisfied(state, restriction.resumeCondition)
      )
        // The deterministic command id makes the owner's notice happen once.
        yield* store.commit({
          actor: { kind: "system" },
          command: {
            type: "incident.condition-met",
            commandId: CommandId.make(`collaboration:${restriction.id}:condition-met`),
            restrictionId: restriction.id,
          },
          now: yield* nowIso,
        });
    for (const request of state.crossProjectRequests) {
      if (factoryRequestReconsiderable(state, request))
        yield* store.commit({
          actor: { kind: "system" },
          command: {
            type: "collaboration.request.reconsider",
            commandId: CommandId.make(
              `collaboration:${request.id}:${request.generation}:reconsider`,
            ),
            requestId: request.id,
          },
          now: yield* nowIso,
        });
      if (request.lifecycle.phase === "accepted") {
        const supportId = request.lifecycle.support.assignmentId;
        const support = state.assignments.find((entry) => entry.id === supportId);
        const conclusion = support?.completion?.conclusion;
        if (
          support?.completion?.phase === "concluded" &&
          conclusion &&
          request.lifecycle.notifiedConclusionId !== conclusion.id
        )
          yield* store.commit({
            actor: { kind: "system" },
            command: {
              type: "collaboration.request.support-concluded",
              commandId: CommandId.make(`collaboration:${request.id}:concluded:${conclusion.id}`),
              requestId: request.id,
              conclusionId: conclusion.id,
            },
            now: yield* nowIso,
          });
      }
    }
  });
  return FactoryCollaborationEffects.of({
    reconcile,
    handle: Effect.fn(function* (pending: PendingFactoryEffect) {
      if (!(yield* store.pending).some((entry) => entry.id === pending.id)) return;
      switch (pending.intent.type) {
        case "collaboration.message.deliver":
          return yield* message(pending);
        case "collaboration.notify":
          return yield* notify(pending);
        case "incident.stop":
        case "incident.resume":
          return yield* incident(pending);
        case "incident.queue.resume":
          return yield* queue(pending);
        default:
          return;
      }
    }),
  });
});
export const layer = Layer.effect(FactoryCollaborationEffects, make);
