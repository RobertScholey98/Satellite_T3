import {
  CommandId,
  FactoryError,
  MessageId,
  ThreadId,
  type FactoryCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Access from "./FactoryControlAccess.ts";
import * as Execution from "./FactoryExecution.ts";
import {
  factoryImprovementBatchPlan,
  factoryImprovementConfiguration,
  factoryImprovementFindingDigest,
  factoryImprovementNextDueAt,
  factoryImprovementRetroFindingIds,
  type FactoryImprovementContext,
} from "./FactoryImprovements.ts";
import type { FactoryActor } from "./FactoryState.ts";
import { FactoryStore, type PendingFactoryEffect } from "./FactoryStore.ts";

export class FactoryImprovementEffects extends Context.Service<
  FactoryImprovementEffects,
  {
    readonly context: (
      actor: FactoryActor,
      command: FactoryCommand,
    ) => Effect.Effect<FactoryImprovementContext, FactoryError>;
    readonly reconcile: Effect.Effect<void, FactoryError>;
    readonly handle: (pending: PendingFactoryEffect) => Effect.Effect<void, FactoryError>;
    readonly watch: (wake: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/factory/FactoryImprovementEffects") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const isFactoryError = Schema.is(FactoryError);
const error = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause });

const make = Effect.gen(function* () {
  const store = yield* FactoryStore;
  const threads = yield* Threads.ThreadManagementService;
  const execution = yield* Execution.FactoryExecution;
  const access = yield* Access.FactoryControlAccess;
  const context = Effect.fn(function* (actor: FactoryActor, command: FactoryCommand) {
    if (command.type !== "system.create" && command.type !== "system.retry") return {};
    if (actor.kind !== "human") return yield* new FactoryError({ code: "permission-denied" });
    const state = yield* store.snapshot;
    const manager = state.managers.find((entry) => entry.role === "system");
    if (command.type === "system.create" && manager)
      return yield* new FactoryError({
        code: "invalid-state",
        detail: "This environment already has a system manager.",
      });
    if (
      command.type === "system.retry" &&
      (manager?.role !== "system" || manager.id !== command.managerId)
    )
      return yield* new FactoryError({ code: "invalid-state" });
    const threadId = manager?.threadId ?? ThreadId.make(yield* randomUuidV4);
    const qualification =
      manager?.threadStatus === "created" && manager.qualification.status === "qualified"
        ? manager.qualification
        : yield* execution.qualify({
            projectId:
              command.type === "system.create"
                ? command.workspaceProjectId
                : manager!.workspaceProjectId,
            modelSelection: command.modelSelection ?? manager!.modelSelection,
            workflow: command.workflow ?? manager!.workflow,
          });
    return { systemManagerCreation: { threadId, qualification } };
  }, Effect.mapError(error));

  const reconcile = Effect.gen(function* () {
    const initial = yield* store.snapshot;
    const retroFindingIds = factoryImprovementRetroFindingIds(initial);
    for (const finding of initial.findings) {
      const completed = retroFindingIds.includes(finding.id);
      if (!finding.escalation && !completed) continue;
      const state = yield* store.snapshot;
      const current = state.findings.find((entry) => entry.id === finding.id);
      if (!current) continue;
      const origin = current.escalation ? ("explicit-escalation" as const) : ("retro" as const);
      const sourceDigest = factoryImprovementFindingDigest(current);
      const previous = state.improvementIntakes.findLast((entry) => entry.findingId === current.id);
      if (
        previous?.sourceDigest === sourceDigest &&
        (previous.origin === "explicit-escalation" || origin === "retro")
      )
        continue;
      yield* store.commit({
        actor: { kind: "system" },
        now: yield* nowIso,
        command: {
          type: "improvement.intake",
          commandId: CommandId.make(`improvement:intake:${state.revision}:${current.id}`),
          findingId: current.id,
          origin,
          sourceDigest,
        },
      });
    }
    for (const kind of ["urgent", "routine"] as const) {
      const state = yield* store.snapshot;
      const now = yield* nowIso;
      if (!factoryImprovementBatchPlan(state, now, { kind })) continue;
      yield* store.commit({
        actor: { kind: "system" },
        now,
        command: {
          type: "improvement.batch.requested",
          commandId: CommandId.make(`improvement:batch:${kind}:${state.revision}`),
          kind,
          expectedStateRevision: state.revision,
        },
      });
    }
  });

  const accepted = Effect.fn(function* (threadId: ThreadId, messageId: MessageId) {
    const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
      messageIds: [messageId],
    });
    return records.messages.some(
      (message) => message.id === messageId && records.runs.some((run) => run.id === message.runId),
    );
  });
  const handle = Effect.fn(function* (pending: PendingFactoryEffect) {
    const intent = pending.intent;
    if (intent.type === "improvement.reconcile") {
      yield* reconcile;
      yield* store.retireEffect(pending.id);
      return;
    }
    if (intent.type !== "system.launch" && intent.type !== "improvement.notify") return;
    const state = yield* store.snapshot;
    const manager = state.managers.find((entry) => entry.id === intent.managerId);
    if (manager?.role !== "system") {
      yield* store.retireEffect(pending.id);
      return;
    }
    if (manager.status === "paused") return;
    if (
      manager.qualification.status !== "qualified" ||
      (intent.type === "system.launch" && manager.qualification.profileId !== intent.profileId)
    ) {
      yield* store.retireEffect(pending.id);
      return;
    }
    if (manager.status === "blocked") return;
    const allowed = yield* access
      .assertDirection({ threadId: manager.threadId, senderThreadId: null })
      .pipe(Effect.result);
    if (Result.isFailure(allowed)) return;
    if (intent.type === "system.launch") {
      if (manager.launchStatus === "delivered") return;
      yield* store.beginEffect(pending.id);
      const launched = yield* Effect.gen(function* () {
        const profile = yield* execution.runtimePolicyFor(manager.threadId);
        if (!profile) return yield* new FactoryError({ code: "execution-unavailable" });
        const existing = yield* threads.getThreadShell(manager.threadId);
        if (
          existing &&
          (existing.projectId !== manager.workspaceProjectId ||
            existing.archivedAt !== null ||
            existing.deletedAt !== null)
        )
          return yield* new FactoryError({ code: "invalid-state" });
        if (!existing)
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`factory:${pending.id}:create`),
            threadId: manager.threadId,
            projectId: manager.workspaceProjectId,
            title: manager.name,
            modelSelection: manager.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: profile.projectSnapshotPath,
            createdBy: "system",
            creationSource: "server",
          });
        const messageId = MessageId.make(`factory:${manager.id}:initial-message`);
        if (!(yield* accepted(manager.threadId, messageId)))
          yield* threads
            .sendToThread({
              projectId: manager.workspaceProjectId,
              threadId: manager.threadId,
              messageId,
              commandId: CommandId.make(`${messageId}:send`),
              modelSelection: manager.modelSelection,
              mode: "auto",
              attachments: [],
              createdBy: "system",
              creationSource: "server",
              text: [
                `You are the system manager ${manager.id}. The human is your manager. You and project engineering managers are peers with different remits.`,
                `Your workspace is a read-only reference snapshot. Owned workflow ${manager.workflow.revision} is pinned at /workflow. You do not own project priorities, implementation, PR review, or managers' permissions.`,
                "Investigate shared engineering workflow problems using the bounded evidence batches delivered here. Use factory_improvement_snapshot for the improvement backlog and factory_improvement_record for a complete named proposal, investigation, decision or feedback record. Preserve original finding routes, project context, containment, uncertainty and conflicting evidence. Similar local fixes can indicate a shared cause, but do not assume that one project's convention belongs everywhere.",
                "Open or update a named investigation with factory_dispatch. Link only relevant finding IDs. Use factory_investigation_read to request bounded details for a linked finding and retain its provenance. Do not read unrelated project history or follow arbitrary evidence paths and URLs.",
                "Use proposal.write and proposal.submit to bring a concrete version to human review. Explain the scope, exclusions, expected benefit, tradeoffs, uncertainty and requested adoption decision. An assessment approach is optional. Tests, benchmarks, and cross-project trials are not prerequisites for the human to decide. Acceptance of a proposal does not itself implement or adopt a change.",
                "Track recurrence and useful or noisy outcomes. Proposal count is not success. Do not poll, solicit unbounded reports, invent escalations, or wake project managers without a concrete evidence request. Wait for a new batch or the human when no investigation has actionable work.",
              ].join("\n\n"),
            })
            .pipe(
              Effect.catch((cause) =>
                accepted(manager.threadId, messageId).pipe(
                  Effect.flatMap((recorded) => (recorded ? Effect.void : Effect.fail(cause))),
                ),
              ),
            );
      }).pipe(Effect.result);
      if (Result.isFailure(launched)) {
        const stillAllowed = yield* access
          .assertDirection({ threadId: manager.threadId, senderThreadId: null })
          .pipe(Effect.result);
        if (Result.isFailure(stillAllowed) && stillAllowed.failure.code === "permission-denied")
          return;
      }
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        failed: Result.isFailure(launched),
        command: Result.isSuccess(launched)
          ? {
              type: "system.launch.recorded",
              commandId: CommandId.make(`${pending.id}:recorded`),
              managerId: manager.id,
              profileId: intent.profileId,
            }
          : {
              type: "system.launch.failed",
              commandId: CommandId.make(`${pending.id}:failed`),
              managerId: manager.id,
              profileId: intent.profileId,
              threadCreated: (yield* threads.getThreadShell(manager.threadId)) !== null,
              reason: isFactoryError(launched.failure)
                ? (launched.failure.detail ?? launched.failure.code)
                : "The system manager could not start in its qualified environment.",
            },
      });
      return;
    }
    const batch = state.improvementBatches.find(
      (entry) =>
        entry.id === intent.batchId &&
        entry.managerId === manager.id &&
        entry.digest === intent.digest,
    );
    if (!batch || batch.delivery.status === "delivered") {
      yield* store.retireEffect(pending.id);
      return;
    }
    if (
      manager.status !== "active" ||
      !factoryImprovementConfiguration(state).enabled ||
      batch.delivery.failure
    )
      return;
    const messageId = MessageId.make(`factory:${pending.id}:improvements`);
    const sent = yield* Effect.gen(function* () {
      if (!(yield* accepted(manager.threadId, messageId)))
        yield* threads
          .sendToThread({
            projectId: manager.workspaceProjectId,
            threadId: manager.threadId,
            messageId,
            commandId: CommandId.make(`${messageId}:send`),
            modelSelection: manager.modelSelection,
            mode: "auto",
            attachments: [],
            createdBy: "system",
            creationSource: "server",
            text: [
              `Engineering improvement evidence batch ${batch.id}. Kind ${batch.kind}. Digest ${batch.digest}.`,
              batch.summary,
              "Group related evidence into named investigations without rewriting the original findings. Read further details only for relevant linked findings. Bring scoped proposals to the human; preserve uncertainty and project differences. No process change is a valid conclusion. Do not poll for more work.",
            ].join("\n\n"),
          })
          .pipe(
            Effect.catch((cause) =>
              accepted(manager.threadId, messageId).pipe(
                Effect.flatMap((recorded) => (recorded ? Effect.void : Effect.fail(cause))),
              ),
            ),
          );
    }).pipe(Effect.result);
    if (Result.isFailure(sent)) {
      const current = yield* store.snapshot;
      const allowedNow = yield* access
        .assertDirection({ threadId: manager.threadId, senderThreadId: null })
        .pipe(Effect.result);
      if (Result.isFailure(allowedNow) || !factoryImprovementConfiguration(current).enabled) return;
      yield* store.commit({
        actor: { kind: "system" },
        now: yield* nowIso,
        command: {
          type: "improvement.batch.failed",
          commandId: CommandId.make(`${pending.id}:failed:${current.revision}`),
          batchId: batch.id,
          digest: batch.digest,
          reason:
            "The evidence batch could not be delivered. Retry after restoring the manager's thread connection.",
        },
      });
      return;
    }
    yield* store.finishEffect({
      id: pending.id,
      now: yield* nowIso,
      command: {
        type: "improvement.batch.delivered",
        commandId: CommandId.make(`${pending.id}:delivered`),
        batchId: batch.id,
        digest: batch.digest,
        messageId,
      },
    });
  }, Effect.mapError(error));

  return FactoryImprovementEffects.of({
    context,
    reconcile,
    handle,
    watch: (wake) =>
      Effect.gen(function* () {
        yield* forkParked(
          store.changes.pipe(
            Stream.changesWith((left, right) => left.revision === right.revision),
            Stream.runForEach(() => wake),
          ),
        );
        yield* forkParked(
          store.changes.pipe(
            Stream.mapEffect((state) =>
              nowIso.pipe(Effect.map((now) => factoryImprovementNextDueAt(state, now))),
            ),
            Stream.changes,
            Stream.switchMap((due) =>
              due === null
                ? Stream.empty
                : Stream.fromEffect(
                    nowIso.pipe(
                      Effect.flatMap((now) =>
                        Effect.sleep(Math.max(0, Date.parse(due) - Date.parse(now))),
                      ),
                      Effect.andThen(wake),
                    ),
                  ),
            ),
            Stream.runDrain,
          ),
        );
      }),
  });
});

export const layer = Layer.effect(FactoryImprovementEffects, make);
