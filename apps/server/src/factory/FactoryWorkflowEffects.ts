import {
  CommandId,
  FactoryError,
  MessageId,
  factorySystemManager,
  type FactoryAssignment,
  type FactoryCommand,
  type FactoryWorkflowVersion,
  type FactorySnapshot,
  type ThreadId,
  isFactoryError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Boundaries from "./FactoryBoundaryExecution.ts";
import * as Execution from "./FactoryExecution.ts";
import * as Handover from "./FactoryHandover.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { type FactoryWorkflowContext } from "./FactoryWorkflow.ts";
import { factorySkillsPin } from "./FactoryAssignmentCommission.ts";
import type { FactoryActor } from "./FactoryState.ts";

/**
 * The host side of the workflow decider. `FactoryService` asks it for the facts a command needs
 * before deciding, and the effect worker hands it the decider's workflow intents: notifying the
 * system manager of authorized shared work and stopping revoked teams.
 */
export class FactoryWorkflowEffects extends Context.Service<
  FactoryWorkflowEffects,
  {
    /**
     * Resolves the `FactoryWorkflowContext` for a command, or an empty context when it needs
     * none. For the commands that need host facts it fails early when the actor is neither the
     * human nor the system manager's thread, or when a report-only scope names a recipient other
     * than the manager's live thread.
     */
    readonly context: (
      actor: FactoryActor,
      command: FactoryCommand,
      skills: FactoryWorkflowVersion | undefined,
    ) => Effect.Effect<FactoryWorkflowContext, FactoryError>;
    /**
     * Runs one pending workflow intent and records its receipt. Safe to replay: intents that no
     * longer match the snapshot retire, and messages use fixed ids that are checked before
     * sending. Leaves the effect pending while the target manager or thread cannot be directed.
     */
    readonly handle: (
      pending: FactoryStore.PendingFactoryEffect,
    ) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryWorkflowEffects") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause });

const make = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  const boundaries = yield* Boundaries.FactoryBoundaryExecution;
  const execution = yield* Execution.FactoryExecution;
  const handovers = yield* Handover.FactoryHandover;
  const access = yield* Access.FactoryControlAccess;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;

  const context = Effect.fn("FactoryWorkflowEffects.context")(function* (
    actor: FactoryActor,
    command: FactoryCommand,
    skills: FactoryWorkflowVersion | undefined,
  ): Effect.fn.Return<FactoryWorkflowContext, FactoryError> {
    if (command.type === "manager.create") {
      if (actor.kind !== "human") return yield* new FactoryError({ code: "permission-denied" });
      const project = yield* projects.get(command.projectId).pipe(Effect.mapError(failure));
      if (Option.isNone(project) || project.value.deletedAt !== null)
        return yield* new FactoryError({ code: "invalid-state" });
      return {
        projectRepositoryRoot: yield* fs
          .realPath(project.value.workspaceRoot)
          .pipe(Effect.mapError(failure)),
      };
    }
    if (
      command.type !== "shared.repository.register" &&
      command.type !== "shared.work.commission" &&
      command.type !== "experiment.commission"
    )
      return {};
    const state = yield* store.snapshot;
    const manager = factorySystemManager(state.managers);
    if (
      !manager ||
      (actor.kind !== "human" && (actor.kind !== "thread" || actor.threadId !== manager.threadId))
    )
      return yield* new FactoryError({ code: "permission-denied" });
    if (command.type === "shared.repository.register") {
      if (actor.kind !== "human") return yield* new FactoryError({ code: "permission-denied" });
      const project = yield* projects.get(command.projectId).pipe(Effect.mapError(failure));
      if (
        Option.isNone(project) ||
        project.value.deletedAt !== null ||
        state.managers.some(
          (entry) => entry.role === "project" && entry.projectId === command.projectId,
        )
      )
        return yield* new FactoryError({ code: "invalid-state" });
      const repositoryRoot = yield* fs
        .realPath(project.value.workspaceRoot)
        .pipe(Effect.mapError(failure));
      const pin = factorySkillsPin(skills);
      if (Result.isFailure(pin)) return yield* pin.failure;
      const workflow = pin.success;
      const qualification = yield* execution.qualify({
        projectId: command.projectId,
        modelSelection: manager.modelSelection,
        workflow,
      });
      if (qualification.status !== "qualified")
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail: "The shared repository needs a qualified isolated runtime before registration.",
        });
      const boundary = yield* boundaries.approveShared({
        managerId: manager.id,
        projectId: command.projectId,
        workflow,
        qualification,
        configuration: command.configuration,
      });
      return { sharedRepository: { boundary, repositoryRoot } };
    }
    const scope =
      command.type === "experiment.commission"
        ? command.work.scope
        : state.sharedWorks.find((entry) => entry.id === command.workId)?.plan.work.scope;
    if (scope?.noPrTarget?.kind === "report-received") {
      const recipient = yield* threads
        .getThreadShell(scope.noPrTarget.recipientThreadId)
        .pipe(Effect.mapError(failure));
      if (
        !recipient ||
        recipient.id !== manager.threadId ||
        recipient.projectId !== manager.workspaceProjectId ||
        recipient.archivedAt !== null ||
        recipient.deletedAt !== null
      )
        return yield* new FactoryError({
          code: "invalid-state",
          detail:
            "The system manager must have an available thread to receive this shared-work report.",
        });
    }
    return {};
  });

  // Stops the assignment's boundary and every root thread the team ever ran: the lead, earlier
  // leads, reviewers, auxiliary threads and retros. Threads already gone are skipped.
  const stopTeam = Effect.fn("FactoryWorkflowEffects.stopTeam")(function* (
    state: FactorySnapshot,
    assignment: FactoryAssignment,
    operation: string,
  ) {
    const roots = new Set([
      assignment.threadId,
      ...(assignment.previousLeadThreadIds ?? []),
      ...(assignment.delivery?.revisions.flatMap((revision) =>
        revision.reviews.map((review) => review.threadId),
      ) ?? []),
      ...state.auxiliaryThreads
        .filter((entry) => entry.assignmentId === assignment.id)
        .map((entry) => entry.threadId),
      ...state.retros
        .filter((entry) => entry.assignmentId === assignment.id)
        .map((entry) => entry.threadId),
    ]);
    yield* boundaries.stop(assignment.id);
    for (const threadId of roots) {
      if ((yield* threads.getThreadShell(threadId)) === null) continue;
      yield* handovers.stopTeam({
        threadId,
        projectId: assignment.projectId,
        commandId: CommandId.make(`${operation}:stop:${threadId}`),
      });
    }
  }, Effect.mapError(failure));

  // Whether a message with this fixed id already reached the thread and started a run, so a
  // replayed effect never sends it twice.
  const accepted = Effect.fn(function* (threadId: ThreadId, messageId: MessageId) {
    const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
      messageIds: [messageId],
    });
    return records.messages.some(
      (message) => message.id === messageId && records.runs.some((run) => run.id === message.runId),
    );
  }, Effect.mapError(failure));

  const handle = Effect.fn("FactoryWorkflowEffects.handle")(function* (
    pending: FactoryStore.PendingFactoryEffect,
  ) {
    const intent = pending.intent;
    if (!(yield* store.pending).some((entry) => entry.id === pending.id)) return;
    if (intent.type === "workflow.work.notify") {
      const state = yield* store.snapshot;
      const work = state.sharedWorks.find(
        (entry) => entry.id === intent.workId && entry.managerId === intent.managerId,
      );
      const manager = state.managers.find(
        (entry) => entry.id === intent.managerId && entry.role === "system",
      );
      if (
        !work ||
        manager?.role !== "system" ||
        manager.status === "retired" ||
        work.notification?.phase !== "pending" ||
        work.lifecycle.phase !== "authorized"
      ) {
        yield* store.retireEffect(pending.id);
        return;
      }
      // An inactive manager, or one that cannot be directed now, gets the notification later:
      // the effect stays pending without a failure receipt.
      if (manager.status !== "active") return;
      const allowed = yield* access
        .assertDirection({ threadId: manager.threadId, senderThreadId: null })
        .pipe(Effect.result);
      if (Result.isFailure(allowed)) return;
      yield* store.beginEffect(pending.id);
      const messageId = MessageId.make(`factory-shared-work:${work.id}`);
      const notified = yield* Effect.gen(function* () {
        if (!(yield* accepted(manager.threadId, messageId))) {
          yield* threads
            .sendToThread({
              projectId: manager.workspaceProjectId,
              threadId: manager.threadId,
              messageId,
              commandId: CommandId.make(`factory-shared-work:${work.id}:notify`),
              text: `The human authorized shared work ${work.id} against proposal ${work.plan.proposalId}, revision ${work.plan.proposalRevision}. Task: ${work.plan.work.title.slice(0, 3000)}. Read its exact immutable plan and current authority in factory_snapshot, then commission its implementation lead with shared.work.commission and workId ${work.id} when available. Your team owns implementation, internal review and delivery. This authorization grants nothing beyond this plan.`,
              modelSelection: manager.modelSelection,
              attachments: [],
              mode: "auto",
              createdBy: "system",
              creationSource: "server",
            })
            .pipe(
              Effect.catch((cause) =>
                accepted(manager.threadId, messageId).pipe(
                  Effect.flatMap((recorded) => (recorded ? Effect.void : Effect.fail(cause))),
                ),
              ),
            );
        }
      }).pipe(Effect.mapError(failure), Effect.result);
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        ...(Result.isFailure(notified) ? { failed: true } : {}),
        command: Result.isFailure(notified)
          ? {
              type: "workflow.work.notify.failed",
              commandId: CommandId.make(`${pending.id}:failed`),
              workId: work.id,
              managerId: manager.id,
              reason:
                notified.failure.detail ??
                "The system manager could not receive this authorization. Retry delivery of the same approved work.",
            }
          : {
              type: "workflow.work.notified",
              commandId: CommandId.make(`${pending.id}:notified`),
              workId: work.id,
              managerId: manager.id,
              messageId,
            },
      });
      return;
    }
    if (intent.type === "workflow.revoke") {
      const state = yield* store.snapshot;
      for (const id of intent.assignmentIds) {
        const assignment = state.assignments.find((entry) => entry.id === id);
        if (assignment) yield* stopTeam(state, assignment, pending.id);
      }
      yield* store.retireEffect(pending.id);
      return;
    }
  }, Effect.mapError(failure));
  return FactoryWorkflowEffects.of({ context, handle });
});

export const layer = Layer.effect(FactoryWorkflowEffects, make);
