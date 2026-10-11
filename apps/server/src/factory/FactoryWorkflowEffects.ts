import {
  CommandId,
  FactoryError,
  MessageId,
  factorySystemManager,
  type FactoryAssignment,
  type FactoryCommand,
  type FactorySnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import * as Boundaries from "./FactoryBoundaryExecution.ts";
import * as Execution from "./FactoryExecution.ts";
import * as WorkflowExecution from "./FactoryWorkflowExecution.ts";
import * as Handover from "./FactoryHandover.ts";
import * as Access from "./FactoryControlAccess.ts";
import { FactoryStore, type PendingFactoryEffect } from "./FactoryStore.ts";
import { effectiveFactoryWorkflow, type FactoryWorkflowContext } from "./FactoryWorkflow.ts";
import type { FactoryActor } from "./FactoryState.ts";

export class FactoryWorkflowEffects extends Context.Service<
  FactoryWorkflowEffects,
  {
    readonly context: (
      actor: FactoryActor,
      command: FactoryCommand,
    ) => Effect.Effect<FactoryWorkflowContext, FactoryError>;
    readonly handle: (pending: PendingFactoryEffect) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryWorkflowEffects") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const isFactoryError = Schema.is(FactoryError);
const failure = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause });

const make = Effect.gen(function* () {
  const store = yield* FactoryStore;
  const boundaries = yield* Boundaries.FactoryBoundaryExecution;
  const execution = yield* Execution.FactoryExecution;
  const workflows = yield* WorkflowExecution.FactoryWorkflowExecution;
  const handovers = yield* Handover.FactoryHandover;
  const access = yield* Access.FactoryControlAccess;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;

  const context = Effect.fn("FactoryWorkflowEffects.context")(function* (
    actor: FactoryActor,
    command: FactoryCommand,
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
      command.type !== "workflow.release.register" &&
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
      const workflow = effectiveFactoryWorkflow(state, manager);
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
    if (command.type === "workflow.release.register") {
      const repository = state.sharedRepositories.find(
        (entry) =>
          entry.id === command.repositoryId && entry.managerId === manager.id && entry.enabled,
      );
      if (!repository) return yield* new FactoryError({ code: "permission-denied" });
      const version = { repositoryRoot: repository.repositoryRoot, revision: command.revision };
      const snapshot = yield* workflows.snapshot({ version, requireSkillAuthoring: true });
      return { workflowRelease: { version, snapshotDigest: snapshot.digest } };
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

  const accepted = Effect.fn(function* (threadId: ThreadId, messageId: MessageId) {
    const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
      messageIds: [messageId],
    });
    return records.messages.some(
      (message) => message.id === messageId && records.runs.some((run) => run.id === message.runId),
    );
  }, Effect.mapError(failure));

  const handle = Effect.fn("FactoryWorkflowEffects.handle")(function* (
    pending: PendingFactoryEffect,
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
              text: `The human authorized shared work ${work.id} against proposal ${work.plan.proposalId}, revision ${work.plan.proposalRevision}. Task: ${work.plan.work.title.slice(0, 3000)}. Read its exact immutable plan and current authority in factory_snapshot, then commission its implementation lead with shared.work.commission and workId ${work.id} when available. Your team owns implementation, internal review and delivery. This authorization grants neither live workflow adoption nor broader changes.`,
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
    if (
      intent.type !== "workflow.restart.stop" &&
      intent.type !== "workflow.restart.prepare" &&
      intent.type !== "workflow.restart.resume"
    )
      return;
    const state = yield* store.snapshot;
    const migration = state.workflowMigrations.find(
      (entry) => entry.id === intent.migrationId && entry.assignmentId === intent.assignmentId,
    );
    const assignment = state.assignments.find((entry) => entry.id === intent.assignmentId);
    const step =
      intent.type === "workflow.restart.stop"
        ? "stop"
        : intent.type === "workflow.restart.prepare"
          ? "prepare"
          : "resume";
    if (
      !migration ||
      !assignment ||
      (step === "stop"
        ? migration.lifecycle.phase !== "stopping"
        : step === "prepare"
          ? migration.lifecycle.phase !== "preparing"
          : migration.lifecycle.phase !== "ready" || migration.lifecycle.resume.phase !== "pending")
    ) {
      yield* store.retireEffect(pending.id);
      return;
    }
    const messageId = MessageId.make(`factory-workflow-restart:${migration.id}`);
    if (step === "resume" && !(yield* accepted(assignment.threadId, messageId))) {
      const permitted = yield* access
        .assertDirection({ threadId: assignment.threadId, senderThreadId: assignment.managerId })
        .pipe(Effect.result);
      if (Result.isFailure(permitted)) return;
    }
    yield* store.beginEffect(pending.id);
    const result = yield* Effect.gen(function* () {
      if (step === "stop") {
        yield* stopTeam(state, assignment, pending.id);
        const startingSource = yield* boundaries.captureMigration({
          assignmentId: assignment.id,
          migrationId: migration.id,
          expectedEpoch: migration.previousEpoch,
        });
        yield* store.finishEffect({
          id: pending.id,
          now: yield* nowIso,
          command: {
            type: "workflow.restart.stopped",
            commandId: CommandId.make(`${pending.id}:stopped`),
            migrationId: migration.id,
            expectedStateRevision: (yield* store.snapshot).revision,
            startingSource,
          },
        });
      } else if (step === "prepare") {
        if (!assignment.grant || !assignment.startingSource)
          return yield* new FactoryError({ code: "invalid-state" });
        const qualification = yield* boundaries.prepare({
          assignmentId: assignment.id,
          threadId: assignment.threadId,
          boundaryId: assignment.grant.boundaryId,
          grant: assignment.grant,
          startingSourceId: assignment.startingSource.id,
        });
        if (qualification.status !== "qualified")
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail: qualification.reason,
          });
        yield* store.finishEffect({
          id: pending.id,
          now: yield* nowIso,
          command: {
            type: "workflow.restart.prepared",
            commandId: CommandId.make(`${pending.id}:prepared`),
            migrationId: migration.id,
            expectedStateRevision: (yield* store.snapshot).revision,
            qualification,
          },
        });
      } else {
        if (assignment.qualification.status !== "qualified" || !assignment.modelSelection)
          return yield* new FactoryError({ code: "execution-unavailable" });
        const profileId = assignment.qualification.profileId;
        if (!(yield* accepted(assignment.threadId, messageId))) {
          const profile = yield* execution.runtimePolicyFor(assignment.threadId);
          if (!profile) return yield* new FactoryError({ code: "execution-unavailable" });
          yield* access.assertDirection({
            threadId: assignment.threadId,
            senderThreadId: assignment.managerId,
          });
          yield* execution.assertSelectionFor(assignment.threadId, assignment.modelSelection);
          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${pending.id}:workspace`),
            threadId: assignment.threadId,
            worktreePath: profile.projectSnapshotPath,
          });
          yield* threads
            .sendToThread({
              projectId: assignment.projectId,
              threadId: assignment.threadId,
              commandId: CommandId.make(`${pending.id}:resume`),
              messageId,
              senderThreadId: assignment.managerId,
              text: `The human authorized a workflow ${migration.kind} for this assignment. The previous provider session and its team have stopped. Start with workflow ${assignment.workflow.revision} at /workflow and read its applicable instructions before continuing. Preserved candidate work is at /workspace. Your durable assignment, scope, PRs, review decisions, waits, and recovery allowances are unchanged. Use factory_snapshot to read current state and resume only work permitted by its current controls. Do not repeat a completed publication or treat this restart as new approval.`,
              modelSelection: assignment.modelSelection,
              attachments: [],
              mode: "auto",
              createdBy: "system",
              creationSource: "server",
            })
            .pipe(
              Effect.catch((cause) =>
                accepted(assignment.threadId, messageId).pipe(
                  Effect.flatMap((recorded) => (recorded ? Effect.void : Effect.fail(cause))),
                ),
              ),
            );
        }
        yield* store.finishEffect({
          id: pending.id,
          now: yield* nowIso,
          command: {
            type: "workflow.restart.resumed",
            commandId: CommandId.make(`${pending.id}:resumed`),
            migrationId: migration.id,
            profileId,
          },
        });
      }
    }).pipe(Effect.mapError(failure), Effect.result);
    if (Result.isFailure(result)) {
      if (result.failure.code === "stale-revision") return;
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        failed: true,
        command: {
          type: "workflow.restart.failed",
          commandId: CommandId.make(`${pending.id}:failed`),
          migrationId: migration.id,
          step,
          reason:
            result.failure.detail ??
            `Workflow ${step} could not finish. Preserved work remains available; retry this operation.`,
        },
      });
    }
  }, Effect.mapError(failure));
  return FactoryWorkflowEffects.of({ context, handle });
});

export const layer = Layer.effect(FactoryWorkflowEffects, make);
