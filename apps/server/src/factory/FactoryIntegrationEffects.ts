import {
  CommandId,
  FactoryError,
  MessageId,
  type FactoryAssignment,
  type FactoryEffectIntent,
  type RunId,
  type ThreadId,
  isFactoryError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Store from "./FactoryStore.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Handover from "./FactoryHandover.ts";
import * as Execution from "./FactoryExecution.ts";
import * as IntegrationExecution from "./FactoryIntegrationExecution.ts";
import {
  factoryIntegrationAccessBlocked,
  factoryIntegrationParticipants,
} from "./FactoryIntegration.ts";

/**
 * Carries out the integration effects the decider emits: notices, lead messages, capability
 * qualification, preparation, file changes, verification, stops, and resuming the work an
 * operation stopped. The factory drains `integration.stop` on its own worker, so a hold never
 * waits behind a long preparation or verification. Each handler re-reads the snapshot and
 * retires an effect whose record is gone or superseded.
 */
export class FactoryIntegrationEffects extends Context.Service<
  FactoryIntegrationEffects,
  {
    /** Handles one pending effect. A failure or a wait leaves it pending for the next drain. */
    readonly handle: (pending: Store.PendingFactoryEffect) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryIntegrationEffects") {}

type Operation = Extract<FactoryEffectIntent, { type: "integration.resume" }>["operation"];
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause });
const active = (assignment: FactoryAssignment | undefined): assignment is FactoryAssignment =>
  assignment !== undefined &&
  !assignment.outcome &&
  assignment.status !== "complete" &&
  (!assignment.completion || assignment.completion.phase === "collecting");

const make = Effect.gen(function* () {
  const store = yield* Store.FactoryStore;
  const threads = yield* Threads.ThreadManagementService;
  const access = yield* Access.FactoryControlAccess;
  const handover = yield* Handover.FactoryHandover;
  const execution = yield* Execution.FactoryExecution;
  const integrationExecution = yield* IntegrationExecution.FactoryIntegrationExecution;
  const locks = new Map<string, Semaphore.Semaphore>();
  const lock = (id: string) => {
    let mutex = locks.get(id);
    if (!mutex) {
      mutex = Semaphore.makeUnsafe(1);
      locks.set(id, mutex);
    }
    return mutex;
  };

  // Whether the thread already holds this message. Every send checks it first, so a retried
  // effect never sends twice.
  const accepted = Effect.fn("FactoryIntegrationEffects.accepted")(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    if (!(yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure)))) return false;
    const records = yield* threads
      .getThreadRecords(threadId, ["messages", "runs"], { messageIds: [messageId] })
      .pipe(Effect.mapError(failure));
    const message = records.messages.find((entry) => entry.id === messageId);
    if (!message) return false;
    if (!records.runs.some((entry) => entry.id === message.runId))
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "An integration message has no durable run.",
      });
    return true;
  });
  // Whether the thread is live and may be directed now. A permission refusal means wait, not
  // fail; any other refusal fails the effect.
  const allowed = Effect.fn("FactoryIntegrationEffects.allowed")(function* (
    threadId: ThreadId,
    senderThreadId?: ThreadId,
  ) {
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
  // The work a stop interrupts: lead and subagent threads with a run in progress, and queued
  // runs that are not held, so the same work resumes when the stop is lifted.
  const collectTargets = Effect.fn("FactoryIntegrationEffects.collectTargets")(function* (
    assignment: FactoryAssignment,
  ) {
    const listed = yield* threads
      .listProjectThreads({ projectId: assignment.projectId, includeSubagents: true })
      .pipe(Effect.mapError(failure));
    const descendants = new Set<ThreadId>([assignment.threadId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of listed)
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
    const threadIds: ThreadId[] = [];
    const resumeQueues: Array<{ threadId: ThreadId; runIds: RunId[] }> = [];
    for (const thread of listed.filter(
      (entry) => descendants.has(entry.id) && entry.deletedAt === null,
    )) {
      const records = yield* threads
        .getThreadRecords(thread.id, ["runs"])
        .pipe(Effect.mapError(failure));
      if (
        records.runs.some((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        )
      )
        threadIds.push(thread.id);
      const runIds = records.runs
        .filter((run) => run.status === "queued" && !run.queueHeld)
        .map((run) => run.id);
      if (runIds.length) resumeQueues.push({ threadId: thread.id, runIds });
    }
    return { threadIds, resumeQueues };
  });
  // Records an operation's targets once, before it stops the team. A preparation also takes
  // over the work it inherited from earlier interruptions that were never resumed.
  const recordTargets = Effect.fn("FactoryIntegrationEffects.recordTargets")(function* (
    pending: Store.PendingFactoryEffect,
    integrationId: string,
    operation: Operation,
    assignment: FactoryAssignment,
  ) {
    const state = yield* store.snapshot;
    const record =
      operation.kind === "preparation"
        ? state.integrationPreparations.find((entry) => entry.id === operation.id)
        : state.integrationVerifications.find((entry) => entry.id === operation.id);
    if (!record || record.resumeThreadIds !== undefined) return;
    const targets = yield* collectTargets(assignment);
    const inherited =
      operation.kind === "preparation"
        ? state.integrationPreparations.find((entry) => entry.id === operation.id)
        : undefined;
    const threadIds = [
      ...new Set([...targets.threadIds, ...(inherited?.inheritedResumeThreadIds ?? [])]),
    ];
    const queues = new Map<ThreadId, Set<RunId>>();
    for (const queue of [...targets.resumeQueues, ...(inherited?.inheritedResumeQueues ?? [])]) {
      const runs = queues.get(queue.threadId) ?? new Set<RunId>();
      for (const runId of queue.runIds) runs.add(runId);
      queues.set(queue.threadId, runs);
    }
    const resumeQueues = [...queues].map(([threadId, runs]) => ({ threadId, runIds: [...runs] }));
    yield* store.commit({
      actor: { kind: "system" },
      now: yield* nowIso,
      command: {
        type: "integration.operation.targets.recorded",
        commandId: CommandId.make(`${pending.id}:targets`),
        integrationId,
        operation,
        threadIds,
        resumeQueues,
      },
    });
  });
  const stopProviderTeam = Effect.fn("FactoryIntegrationEffects.stopProviderTeam")(function* (
    pending: Store.PendingFactoryEffect,
    integrationId: string,
  ) {
    const state = yield* store.snapshot;
    const integration = state.integrations.find((entry) => entry.id === integrationId);
    const assignment = state.assignments.find((entry) => entry.id === integration?.assignmentId);
    if (
      assignment &&
      (yield* threads.getThreadShell(assignment.threadId).pipe(Effect.mapError(failure)))
    )
      yield* handover.stopTeam({
        threadId: assignment.threadId,
        projectId: assignment.projectId,
        commandId: CommandId.make(`${pending.id}:stop-team`),
      });
  });
  // Stops both the isolated runtime and the provider team, attempting each even if the other
  // fails.
  const stopTeam = Effect.fn("FactoryIntegrationEffects.stopTeam")(function* (
    pending: Store.PendingFactoryEffect,
    integrationId: string,
    holdId: string,
    preparationId: string | null,
  ) {
    const physical = yield* integrationExecution
      .stop({ integrationId, holdId, preparationId })
      .pipe(Effect.result);
    const stopped = yield* stopProviderTeam(pending, integrationId).pipe(Effect.result);
    if (Result.isFailure(physical)) return yield* physical.failure;
    if (Result.isFailure(stopped)) return yield* stopped.failure;
  });
  const notify = Effect.fn("FactoryIntegrationEffects.notify")(function* (
    pending: Store.PendingFactoryEffect,
  ) {
    if (pending.intent.type !== "integration.notify") return;
    const intent = pending.intent;
    const state = yield* store.snapshot;
    const integration = state.integrations.find((entry) => entry.id === intent.integrationId);
    const recipients = [
      ...state.managers
        .filter((entry) => intent.recipientManagerIds.includes(entry.id))
        .map((entry) => ({
          id: entry.id,
          threadId: entry.threadId,
          projectId: entry.role === "system" ? entry.workspaceProjectId : entry.projectId,
        })),
      ...state.assignments
        .filter((entry) => intent.recipientAssignmentIds.includes(entry.id) && active(entry))
        .map((entry) => ({ id: entry.id, threadId: entry.threadId, projectId: entry.projectId })),
    ];
    let held = false;
    yield* store.beginEffect(pending.id);
    for (const target of recipients) {
      const messageId = MessageId.make(`factory:integration:${pending.id}:${target.id}`);
      if (yield* accepted(target.threadId, messageId)) continue;
      // The team hears nothing until its integration is ready again. The effect stays pending
      // until every recipient has the notice.
      if (target.id === integration?.assignmentId && integration.phase !== "ready") {
        held = true;
        continue;
      }
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
          text: `[Integration ${intent.integrationId}]\n${intent.text}`,
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
  const message = Effect.fn("FactoryIntegrationEffects.message")(function* (
    pending: Store.PendingFactoryEffect,
  ) {
    if (pending.intent.type !== "integration.message.deliver") return;
    const messageId = pending.intent.messageId;
    const state = yield* store.snapshot;
    const entry = state.integrationMessages.find((item) => item.id === messageId);
    if (!entry || entry.delivery.phase === "delivered") {
      yield* store.retireEffect(pending.id);
      return;
    }
    const recipient = state.assignments.find((item) => item.id === entry.toAssignmentId);
    const deliveredMessageId = MessageId.make(`factory:integration-peer:${entry.id}`);
    const receipt = Effect.fn(function* (recipientThreadId: ThreadId) {
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        command: {
          type: "integration.message.recorded",
          commandId: CommandId.make(`${pending.id}:receipt`),
          messageId,
          recipientThreadId,
          deliveredMessageId,
        },
      });
    });
    // A delivery that already landed on the recipient's current or an earlier lead counts.
    for (const threadId of recipient
      ? [recipient.threadId, ...(recipient.previousLeadThreadIds ?? [])]
      : [])
      if (yield* accepted(threadId, deliveredMessageId)) {
        yield* receipt(threadId);
        return;
      }
    const integration = state.integrations.find((item) => item.id === entry.integrationId);
    const participants = factoryIntegrationParticipants(state, entry.integrationId);
    const implementation = state.assignments.find((item) => item.id === integration?.assignmentId);
    const source = state.assignments.find((item) => item.id === entry.fromAssignmentId);
    const linked =
      integration &&
      implementation &&
      ((source?.id === implementation.id &&
        participants.some((item) => item.id === recipient?.id)) ||
        (recipient?.id === implementation.id &&
          participants.some((item) => item.id === source?.id)));
    // The decider's rule again at delivery time: a message that no longer links the integration
    // lead with a current participant lead fails rather than reach the wrong team.
    if (
      !linked ||
      !active(source) ||
      !active(recipient) ||
      source.threadId !== entry.senderThreadId ||
      !integration.requestIds.every((id) =>
        state.crossProjectRequests.some(
          (request) => request.id === id && request.lifecycle.phase === "accepted",
        ),
      )
    ) {
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        failed: true,
        command: {
          type: "integration.message.failed",
          commandId: CommandId.make(`${pending.id}:obsolete`),
          messageId,
          reason:
            "The integration request or one of its current implementation leads changed before delivery.",
        },
      });
      return;
    }
    // Either lead may not be directed now: wait for a later drain without failing.
    if (
      !(yield* allowed(source.threadId)) ||
      !(yield* allowed(recipient.threadId, source.threadId))
    )
      return;
    yield* store.beginEffect(pending.id);
    const content = entry.content;
    const text =
      content.kind === "message"
        ? content.text
        : `Production defect for the owning implementation team\n${content.summary}\nVerified input preparation: ${content.preparationId}\n${content.evidence.map((item) => `${item.label}: ${item.location}`).join("\n")}\nKeep any fix within your existing scope or request separate work.`;
    const sent = yield* threads
      .sendToThread({
        projectId: recipient.projectId,
        threadId: recipient.threadId,
        messageId: deliveredMessageId,
        commandId: CommandId.make(`${pending.id}:send`),
        text,
        senderThreadId: source.threadId,
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.result);
    if (Result.isFailure(sent) && !(yield* accepted(recipient.threadId, deliveredMessageId))) {
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        failed: true,
        command: {
          type: "integration.message.failed",
          commandId: CommandId.make(`${pending.id}:failed`),
          messageId,
          reason:
            "The integration message could not reach the owning team. Retry this recorded message.",
        },
      });
      return;
    }
    yield* receipt(recipient.threadId);
  });
  /**
   * Gives the team back the work an operation stopped once the integration is ready: releases a
   * verification's hold, points each target thread at the new workspace, nudges interrupted
   * threads and resumes their queued runs. Threads that left the team are skipped. A thread
   * that may not be directed now keeps the effect pending.
   */
  const resume = Effect.fn("FactoryIntegrationEffects.resume")(function* (
    pending: Store.PendingFactoryEffect,
  ) {
    if (pending.intent.type !== "integration.resume") return;
    const intent = pending.intent;
    const state = yield* store.snapshot;
    const integration = state.integrations.find((entry) => entry.id === intent.integrationId);
    const assignment = state.assignments.find((entry) => entry.id === integration?.assignmentId);
    const operation =
      intent.operation.kind === "preparation"
        ? state.integrationPreparations.find((entry) => entry.id === intent.operation.id)
        : state.integrationVerifications.find((entry) => entry.id === intent.operation.id);
    const preparationId =
      intent.operation.kind === "preparation"
        ? intent.operation.id
        : state.integrationVerifications.find((entry) => entry.id === intent.operation.id)
            ?.preparationId;
    // Retired once the team concludes or the preparation is replaced. A newer preparation
    // inherits the work this operation stopped and resumes it itself.
    if (
      !integration ||
      !active(assignment) ||
      !operation ||
      !preparationId ||
      integration.currentPreparationId !== preparationId
    ) {
      yield* store.retireEffect(pending.id);
      return;
    }
    if (integration.phase !== "ready") return;
    if (intent.operation.kind === "verification")
      yield* integrationExecution.release({
        integrationId: integration.id,
        preparationId,
        holdId: intent.operation.id,
      });
    const targets = new Set([
      ...(operation.resumeThreadIds ?? []),
      ...(operation.resumeQueues ?? []).map((entry) => entry.threadId),
    ]);
    let held = false;
    for (const threadId of targets) {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure));
      if (!shell || shell.deletedAt !== null || shell.archivedAt !== null) continue;
      const membership = yield* access.membership(threadId);
      if (membership?.assignmentId !== assignment.id) continue;
      if (!(yield* allowed(threadId))) {
        held = true;
        continue;
      }
      const profile = yield* execution.runtimePolicyFor(threadId);
      if (!profile) {
        held = true;
        continue;
      }
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${pending.id}:${threadId}:workspace`),
          threadId,
          worktreePath: profile.projectSnapshotPath,
        })
        .pipe(Effect.mapError(failure));
      if (operation.resumeThreadIds?.includes(threadId)) {
        const messageId = MessageId.make(`factory:integration-resume:${pending.id}:${threadId}`);
        if (!(yield* accepted(threadId, messageId)))
          yield* threads
            .sendToThread({
              projectId: assignment.projectId,
              threadId,
              messageId,
              commandId: CommandId.make(`${pending.id}:${threadId}:continue`),
              text: `Integration ${intent.operation.kind} ${intent.operation.id} has finished. Read the recorded result and current preparation before continuing your existing work. Project restrictions and grants still apply. Do not repeat completed side effects.`,
              attachments: [],
              mode: "queue",
              createdBy: "system",
              creationSource: "server",
            })
            .pipe(Effect.mapError(failure));
      }
      const queue = operation.resumeQueues?.find((entry) => entry.threadId === threadId);
      if (queue?.runIds.length)
        yield* threads
          .dispatch({
            type: "queue.resume",
            threadId,
            runIds: queue.runIds,
            commandId: CommandId.make(`${pending.id}:${threadId}:queue`),
          })
          .pipe(Effect.mapError(failure));
    }
    if (!held)
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        command: {
          type: "integration.operation.resumed",
          commandId: CommandId.make(`${pending.id}:receipt`),
          integrationId: integration.id,
          operation: intent.operation,
        },
      });
  });

  const handleLocked = Effect.fn("FactoryIntegrationEffects.handleLocked")(function* (
    pending: Store.PendingFactoryEffect,
  ) {
    // Another drain may have finished this effect while it waited for the lock.
    if (!(yield* store.pending).some((entry) => entry.id === pending.id)) return;
    const intent = pending.intent;
    switch (intent.type) {
      case "integration.notify":
        return yield* notify(pending);
      case "integration.message.deliver":
        return yield* message(pending);
      case "integration.resume":
        return yield* resume(pending);
      case "integration.capability.qualify": {
        const capability = (yield* store.snapshot).integrationCapabilities.find(
          (entry) => entry.id === intent.capabilityId,
        );
        if (
          !capability ||
          capability.supersededBy !== null ||
          capability.qualification.status !== "pending"
        ) {
          yield* store.retireEffect(pending.id);
          return;
        }
        yield* store.beginEffect(pending.id);
        const result = yield* integrationExecution
          .qualify({ capabilityId: intent.capabilityId })
          .pipe(Effect.result);
        const current = (yield* store.snapshot).integrationCapabilities.find(
          (entry) => entry.id === intent.capabilityId,
        );
        if (!current || current.supersededBy !== null) {
          yield* store.retireEffect(pending.id);
          return;
        }
        yield* store.finishEffect({
          id: pending.id,
          now: yield* nowIso,
          ...(Result.isFailure(result) ? { failed: true } : {}),
          command: Result.isFailure(result)
            ? {
                type: "integration.capability.failed",
                commandId: CommandId.make(`${pending.id}:failed`),
                capabilityId: intent.capabilityId,
                reason:
                  result.failure.detail ?? "The integration capability could not be qualified.",
              }
            : {
                type: "integration.capability.qualified",
                commandId: CommandId.make(`${pending.id}:receipt`),
                ...result.success,
              },
        });
        return;
      }
      case "integration.prepare": {
        const state = yield* store.snapshot;
        const integration = state.integrations.find((entry) => entry.id === intent.integrationId);
        const preparation = state.integrationPreparations.find(
          (entry) => entry.id === intent.preparationId,
        );
        const assignment = state.assignments.find(
          (entry) => entry.id === integration?.assignmentId,
        );
        if (
          !integration ||
          !active(assignment) ||
          preparation?.lifecycle.phase !== "requested" ||
          integration.currentPreparationId !== preparation.id
        ) {
          yield* store.retireEffect(pending.id);
          return;
        }
        // A preparation that may no longer run is recorded as failed, which blocks the
        // integration until a refresh.
        const blocked = factoryIntegrationAccessBlocked(state, integration.id);
        if (integration.phase !== "preparing" || blocked !== null) {
          yield* store.finishEffect({
            id: pending.id,
            now: yield* nowIso,
            failed: true,
            command: {
              type: "integration.prepare.failed",
              commandId: CommandId.make(`${pending.id}:obsolete`),
              integrationId: integration.id,
              preparationId: preparation.id,
              reason:
                integration.waitReason ??
                blocked ??
                "The integration preparation is no longer authorized. Restore access before refreshing.",
            },
          });
          return;
        }
        if (assignment.threadStatus !== "created") return;
        yield* store.beginEffect(pending.id);
        // Record the running work, stop it, then build. Stopping the earlier runtime first makes
        // its test work final before the new preparation carries it over.
        const result = yield* Effect.gen(function* () {
          yield* recordTargets(
            pending,
            integration.id,
            { kind: "preparation", id: preparation.id },
            assignment,
          );
          yield* stopTeam(
            pending,
            integration.id,
            preparation.id,
            preparation.previousPreparationId,
          );
          return yield* integrationExecution.prepare({
            integrationId: integration.id,
            preparationId: preparation.id,
          });
        }).pipe(Effect.result);
        yield* store.finishEffect({
          id: pending.id,
          now: yield* nowIso,
          ...(Result.isFailure(result) ? { failed: true } : {}),
          command: Result.isFailure(result)
            ? {
                type: "integration.prepare.failed",
                commandId: CommandId.make(`${pending.id}:failed`),
                integrationId: integration.id,
                preparationId: preparation.id,
                reason:
                  result.failure.detail ??
                  "The integration inputs could not be prepared. Existing test work is preserved.",
              }
            : {
                type: "integration.prepared",
                commandId: CommandId.make(`${pending.id}:receipt`),
                ...result.success,
              },
        });
        return;
      }
      case "integration.verify": {
        const state = yield* store.snapshot;
        const verification = state.integrationVerifications.find(
          (entry) => entry.id === intent.verificationId,
        );
        const integration = state.integrations.find(
          (entry) => entry.id === verification?.integrationId,
        );
        const assignment = state.assignments.find(
          (entry) => entry.id === integration?.assignmentId,
        );
        if (!verification || verification.lifecycle.phase !== "requested") {
          yield* store.retireEffect(pending.id);
          return;
        }
        if (
          !integration ||
          !active(assignment) ||
          integration.currentPreparationId !== verification.preparationId ||
          integration.phase !== "ready" ||
          factoryIntegrationAccessBlocked(state, integration.id) !== null
        ) {
          yield* store.finishEffect({
            id: pending.id,
            now: yield* nowIso,
            failed: true,
            command: {
              type: "integration.verify.failed",
              commandId: CommandId.make(`${pending.id}:obsolete`),
              verificationId: verification.id,
              reason:
                "The integration inputs or execution authority changed before verification started. Restore access and refresh the inputs before retrying.",
            },
          });
          return;
        }
        yield* store.beginEffect(pending.id);
        const result = yield* Effect.gen(function* () {
          yield* recordTargets(
            pending,
            integration.id,
            { kind: "verification", id: verification.id },
            assignment,
          );
          // The hold is named for the verification, which `verify` requires before it seals the
          // test artifact; resuming afterwards releases it.
          yield* stopTeam(pending, integration.id, verification.id, verification.preparationId);
          return yield* integrationExecution.verify({ verificationId: verification.id });
        }).pipe(Effect.result);
        yield* store.finishEffect({
          id: pending.id,
          now: yield* nowIso,
          ...(Result.isFailure(result) ? { failed: true } : {}),
          command: Result.isFailure(result)
            ? {
                type: "integration.verify.failed",
                commandId: CommandId.make(`${pending.id}:failed`),
                verificationId: verification.id,
                reason: result.failure.detail ?? "The combined verification could not complete.",
              }
            : {
                type: "integration.verified",
                commandId: CommandId.make(`${pending.id}:receipt`),
                ...result.success,
              },
        });
        return;
      }
      case "integration.file.mutate": {
        yield* store.beginEffect(pending.id);
        const result = yield* integrationExecution.mutate(intent).pipe(Effect.result);
        yield* store.finishEffect({
          id: pending.id,
          now: yield* nowIso,
          ...(Result.isFailure(result) ? { failed: true } : {}),
          command: Result.isFailure(result)
            ? {
                type: "integration.file.failed",
                commandId: CommandId.make(`${pending.id}:failed`),
                integrationId: intent.integrationId,
                preparationId: intent.preparationId,
                operationId: intent.operationId,
                reason: result.failure.detail ?? "The integration file operation did not complete.",
              }
            : {
                type: "integration.file.mutated",
                commandId: CommandId.make(`${pending.id}:receipt`),
                ...result.success,
              },
        });
        return;
      }
      default:
        return;
    }
  });
  const handle = Effect.fn("FactoryIntegrationEffects.handle")(function* (
    pending: Store.PendingFactoryEffect,
  ) {
    const intent = pending.intent;
    if (intent.type === "integration.stop") {
      const current = Effect.gen(function* () {
        const entry = (yield* store.snapshot).integrations.find(
          (entry) => entry.id === intent.integrationId,
        );
        return (
          entry?.hold?.id === intent.holdId && entry.hold.preparationId === intent.preparationId
        );
      });
      if (!(yield* current)) {
        yield* store.retireEffect(pending.id);
        return;
      }
      const snapshot = yield* store.snapshot;
      const integration = snapshot.integrations.find((entry) => entry.id === intent.integrationId);
      const assignment = snapshot.assignments.find(
        (entry) => entry.id === integration?.assignmentId,
      );
      // The hold's work is captured once before anything stops, so lifting it can resume it.
      if (assignment && integration?.hold?.resumeThreadIds === undefined) {
        const targets = yield* collectTargets(assignment);
        if (!(yield* current)) {
          yield* store.retireEffect(pending.id);
          return;
        }
        yield* store.commit({
          actor: { kind: "system" },
          now: yield* nowIso,
          command: {
            type: "integration.hold.targets.recorded",
            commandId: CommandId.make(`${pending.id}:targets`),
            integrationId: intent.integrationId,
            holdId: intent.holdId,
            ...targets,
          },
        });
      }
      yield* store.beginEffect(pending.id);
      const physical = yield* integrationExecution
        .stop({
          integrationId: intent.integrationId,
          preparationId: intent.preparationId,
          holdId: intent.holdId,
        })
        .pipe(Effect.result);
      // The provider stop and the receipt re-check the hold under the integration lock, so a
      // hold replaced meanwhile retires this effect instead of recording against the new one.
      // A failed stop is recorded on the hold and the effect stays pending to retry.
      yield* lock(intent.integrationId).withPermit(
        Effect.gen(function* () {
          if (!(yield* current)) {
            yield* store.retireEffect(pending.id);
            return;
          }
          const provider = yield* stopProviderTeam(pending, intent.integrationId).pipe(
            Effect.result,
          );
          if (!(yield* current)) {
            yield* store.retireEffect(pending.id);
            return;
          }
          if (Result.isFailure(physical) || Result.isFailure(provider)) {
            yield* store.commit({
              actor: { kind: "system" },
              now: yield* nowIso,
              command: {
                type: "integration.stop.failed",
                commandId: CommandId.make(`${pending.id}:failed`),
                integrationId: intent.integrationId,
                holdId: intent.holdId,
                reason: "Integration access is held, but physical shutdown needs retry.",
              },
            });
            return;
          }
          yield* store.finishEffect({
            id: pending.id,
            now: yield* nowIso,
            command: {
              type: "integration.stopped",
              commandId: CommandId.make(`${pending.id}:receipt`),
              integrationId: intent.integrationId,
              holdId: intent.holdId,
            },
          });
        }),
      );
      return;
    }
    const integrationId =
      "integrationId" in intent
        ? intent.integrationId
        : intent.type === "integration.verify"
          ? (yield* store.snapshot).integrationVerifications.find(
              (entry) => entry.id === intent.verificationId,
            )?.integrationId
          : undefined;
    // Workspace operations on one integration run one at a time, and a stop's receipt waits
    // for any of them in progress.
    if (
      integrationId !== undefined &&
      [
        "integration.prepare",
        "integration.verify",
        "integration.file.mutate",
        "integration.resume",
      ].includes(intent.type)
    )
      yield* lock(integrationId).withPermit(handleLocked(pending));
    else yield* handleLocked(pending);
  });
  return FactoryIntegrationEffects.of({ handle });
});
export const layer = Layer.effect(FactoryIntegrationEffects, make);
