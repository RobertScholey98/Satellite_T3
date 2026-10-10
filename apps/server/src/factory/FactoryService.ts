import {
  CommandId,
  FactoryAssignmentId,
  FactoryError,
  MessageId,
  ThreadId,
  type FactoryCommand,
  type FactoryCommandResult,
  type FactoryThreadLaunchIntent,
  type FactoryQuery,
  type FactorySnapshot,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { FactoryExecution } from "./FactoryExecution.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
import { FactorySource } from "./FactorySource.ts";
import { FactoryHandover } from "./FactoryHandover.ts";
import { FactoryStore, type PendingFactoryEffect } from "./FactoryStore.ts";
import { decide, type FactoryActor } from "./FactoryState.ts";

export class FactoryService extends Context.Service<
  FactoryService,
  {
    readonly snapshot: (query: FactoryQuery) => Effect.Effect<FactorySnapshot, FactoryError>;
    readonly changes: (query: FactoryQuery) => Stream.Stream<FactorySnapshot>;
    readonly dispatch: (
      actor: Exclude<FactoryActor, { readonly kind: "system" }>,
      command: FactoryCommand,
    ) => Effect.Effect<FactoryCommandResult, FactoryError>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/factory/FactoryService") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const renderJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isFactoryError = Schema.is(FactoryError);

const scopedSnapshot =
  (query: FactoryQuery) =>
  (snapshot: FactorySnapshot): FactorySnapshot =>
    query.projectId === undefined
      ? snapshot
      : {
          ...snapshot,
          managers: snapshot.managers.filter((manager) => manager.projectId === query.projectId),
          assignments: snapshot.assignments.filter(
            (assignment) => assignment.projectId === query.projectId,
          ),
          boundaries: snapshot.boundaries.filter(
            (boundary) => boundary.projectId === query.projectId,
          ),
        };

const onboardingInstructions = (intent: FactoryThreadLaunchIntent) =>
  [
    `You are the onboarding lead for project ${intent.projectId}, assigned by engineering manager ${intent.managerId}.`,
    `Assignment: ${intent.assignmentId}. You are in a read-only snapshot of the project's tracked files. Untracked files, known credential paths, and symlinks are excluded; identify any discovery gaps.`,
    `The owned workflow is pinned to ${intent.workflow.revision} and available at /workflow. Read its relevant skills.`,
    "Discover the project's instructions, existing quality checks, issue tracker readiness, verification tools, and protected controls. Cite concrete evidence paths for each finding. Do not change the project or start implementation.",
    "Protected controls include CI and merge requirements, lint and type strictness, architecture boundaries, verification procedures, authority-defining instructions, and shared skills.",
    "Where the evidence supports it, include a proposedBoundary with exact repository-relative writable source/test paths, directories for new source/test files, additional protected paths, and direct verification commands. Gate executables must be absolute container paths; record their protected configuration inputs. This is a proposal for human approval, not permission to change files. If a supported check or control is unclear, record an unresolved decision instead of inventing one.",
    "Use factory_dispatch with an onboarding.report command and this assignment ID to record your report. List unresolved decisions explicitly. The human owns approval and the manager coordinates future work; you own this investigation.",
    "If a tool or permission is unavailable, report the exact limitation instead of bypassing the boundary.",
  ].join("\n\n");

export const layer = Layer.effect(
  FactoryService,
  Effect.gen(function* () {
    const store = yield* FactoryStore;
    const execution = yield* FactoryExecution;
    const boundaries = yield* FactoryBoundaryExecution;
    const sources = yield* FactorySource;
    const handovers = yield* FactoryHandover;
    const threads = yield* ThreadManagementService;
    const projects = yield* ProjectService;
    const commands = yield* Semaphore.make(1);
    const commandLocks = new Map<
      CommandId,
      { readonly semaphore: Semaphore.Semaphore; users: number }
    >();
    const withCommand = <A, E, R>(id: CommandId, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          let lock = commandLocks.get(id);
          if (lock === undefined) {
            lock = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
            commandLocks.set(id, lock);
          }
          lock.users += 1;
          return lock;
        }),
        (lock) => lock.semaphore.withPermits(1)(effect),
        (lock) =>
          Effect.sync(() => {
            lock.users -= 1;
            if (lock.users === 0) commandLocks.delete(id);
          }),
      );

    const launch = Effect.fn("FactoryService.launch")(function* (pending: PendingFactoryEffect) {
      const { intent } = pending;
      if (intent.type !== "thread.launch") return;
      const snapshot = yield* store.snapshot;
      const assignment = snapshot.assignments.find((entry) => entry.id === intent.assignmentId);
      const manager = snapshot.managers.find((entry) => entry.id === intent.managerId);
      if (
        assignment === undefined ||
        manager === undefined ||
        assignment.qualification.status !== "qualified" ||
        assignment.qualification.profileId !== intent.profileId
      ) {
        yield* store.retireEffect(pending.id);
        return;
      }
      if (manager.status === "blocked" || manager.status === "paused") return;
      yield* store.beginEffect(pending.id);
      const result = yield* Effect.gen(function* () {
        const profile = yield* execution.runtimePolicyFor(intent.threadId);
        if (profile === undefined)
          return yield* new FactoryError({ code: "execution-unavailable" });
        const existing = yield* threads.getThreadShell(intent.threadId);
        if (
          existing !== null &&
          (existing.projectId !== intent.projectId ||
            existing.deletedAt !== null ||
            existing.archivedAt !== null)
        )
          return yield* new FactoryError({ code: "invalid-state" });
        if (existing === null)
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`factory:${pending.id}:create`),
            threadId: intent.threadId,
            projectId: intent.projectId,
            title:
              intent.purpose === "manager"
                ? manager.name
                : intent.purpose === "onboarding"
                  ? "Project onboarding"
                  : (assignment.title ?? "Implementation"),
            modelSelection: intent.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: profile.projectSnapshotPath,
            createdBy: "system",
            creationSource: "server",
          });
        yield* store.commit({
          actor: { kind: "system" },
          command: {
            type: "thread.launch.started",
            commandId: CommandId.make(`${pending.id}:started`),
            threadId: intent.threadId,
          },
          now: yield* nowIso,
        });
        const messageId = MessageId.make(`factory:${intent.threadId}:initial-message`);
        const records = yield* threads.getThreadRecords(intent.threadId, ["messages", "runs"], {
          messageIds: [messageId],
        });
        const accepted = records.messages.find((message) => message.id === messageId);
        if (accepted !== undefined) {
          if (!records.runs.some((run) => run.id === accepted.runId))
            return yield* new FactoryError({ code: "launch-failed" });
          return;
        }
        yield* threads.sendToThread({
          projectId: intent.projectId,
          commandId: CommandId.make(`factory:${pending.id}:initial-message`),
          threadId: intent.threadId,
          messageId,
          ...(intent.purpose !== "manager" ? { senderThreadId: intent.managerId } : {}),
          text:
            intent.purpose === "onboarding"
              ? onboardingInstructions(intent)
              : intent.purpose === "implementation"
                ? [
                    `You lead implementation assignment ${assignment.id} for engineering manager ${manager.id}. You own implementation, your team's reviews, verification, and the complete PR process.`,
                    `Task: ${assignment.title}. Scope: ${assignment.scope?.description}. Completion: ${assignment.scope?.completionCondition}. Pull request required: ${assignment.scope?.requiresPullRequest ?? true}.`,
                    `The owned workflow is pinned to ${assignment.workflow.revision} at /workflow. Read its relevant skills. Your approved starting source is ${assignment.startingSource?.revision} (${assignment.startingSource?.sourceDigest}); preserve any handed-over work and existing PR links.`,
                    `Approved execution grant: ${renderJson(assignment.grant)}. Existing granted files can be edited normally. For creating, renaming, or deleting files use factory_dispatch assignment.file.mutate with the current grant epoch. Use assignment.verify to run the adopted immutable checks and retain its evidence.`,
                    `Approved exact models: ${renderJson(assignment.modelPolicy)}. Your selected model: ${renderJson(assignment.modelChoice)}. Choose approved models according to task complexity. Native subagent tools are disabled; use delegate_task for your internal team. Every descendant remains inside this assignment's boundary.`,
                    "Raise an out-of-scope dependency or structural problem when discovered. Do not change protected controls without a separately authorized rule-change assignment. The manager coordinates priorities; it does not review your PR.",
                    "Human review is required unless the delivery grant and project rules explicitly permit autonomous delivery. Major UI changes require human PR approval and useful screenshots. After merge, conduct your internal retro and then a retro with your manager. Creating a follow-up ticket does not authorize its implementation.",
                  ].join("\n\n")
                : [
                    `You are the engineering manager for project ${intent.projectId}. Your durable manager identity is ${intent.managerId}. The human is your manager.`,
                    `Onboarding lead ${assignment.threadId} owns discovery assignment ${assignment.id}. Use factory_snapshot to inspect its findings and waits. A read-only tracked snapshot is mounted at /workspace; owned workflow ${intent.workflow.revision} is at /workflow.`,
                    "You coordinate scoped implementation teams and project priorities. Implementation leads own code, internal reviews, verification, and the complete PR process. You do not implement or review their PRs. You and the system manager are peers with different remits.",
                    "Currently onboarding is in progress. Acknowledge the assignment briefly, then wait for an actionable event or the human. Do not poll, start implementation, or attempt to broaden execution permissions. Unresolved permissions and project decisions must remain visible.",
                    "When factory_snapshot shows an active manager with an approved boundary and the human requests work, use assignment.commission to create a scoped implementation lead. Choose exact source paths and creation directories within that boundary, a completion condition, and task complexity. Omit modelSelection for the configured lead preference. authorizationMessageId may reference the direct human request, or omit it to use the latest direct human message. Discuss gaps with the human before commissioning unclear work.",
                  ].join("\n\n"),
          attachments: [],
          modelSelection: intent.modelSelection,
          mode: "auto",
          createdBy: "system",
          creationSource: "server",
        });
      }).pipe(Effect.result);
      if (result._tag === "Failure") {
        yield* Effect.logError("Managed thread launch failed", {
          threadId: intent.threadId,
          cause: result.failure,
        });
        yield* store.finishEffect({
          id: pending.id,
          command: {
            type: "thread.launch.failed",
            commandId: CommandId.make(`${pending.id}:receipt`),
            threadId: intent.threadId,
            reason:
              intent.purpose === "implementation"
                ? "The implementation thread could not start. Check the environment's provider and Docker availability, then retry the assignment. Existing work is preserved."
                : "The confined thread could not start. Check the environment's provider and Docker availability, then retry onboarding. Existing work is preserved.",
          },
          now: yield* nowIso,
          failed: true,
        });
      } else {
        yield* store.finishEffect({
          id: pending.id,
          command: {
            type: "thread.launch.recorded",
            commandId: CommandId.make(`${pending.id}:receipt`),
            threadId: intent.threadId,
          },
          now: yield* nowIso,
        });
      }
    });

    const prepare = Effect.fn("FactoryService.prepare")(function* (pending: PendingFactoryEffect) {
      const { intent } = pending;
      if (intent.type !== "assignment.prepare") return;
      const snapshot = yield* store.snapshot;
      const assignment = snapshot.assignments.find((entry) => entry.id === intent.assignmentId);
      const manager = snapshot.managers.find((entry) => entry.id === intent.managerId);
      if (
        assignment === undefined ||
        manager === undefined ||
        assignment.status === "complete" ||
        assignment.preparation === "ready"
      ) {
        yield* store.retireEffect(pending.id);
        return;
      }
      if (manager.status !== "active" || assignment.status !== "pending") return;
      yield* store.beginEffect(pending.id);
      const result = yield* Effect.gen(function* () {
        if (assignment.grant === undefined)
          return yield* new FactoryError({ code: "invalid-state" });
        if (assignment.origin === "handover" && assignment.preparation === "stopping") {
          yield* handovers.stop({
            threadId: assignment.threadId,
            projectId: assignment.projectId,
            commandId: CommandId.make(`factory:${assignment.id}:stop`),
          });
          yield* store.commit({
            actor: { kind: "system" },
            command: {
              type: "assignment.preparation.recorded",
              commandId: CommandId.make(`factory:${assignment.id}:capturing`),
              assignmentId: assignment.id,
              threadId: assignment.threadId,
              stage: "capturing",
            },
            now: yield* nowIso,
          });
        }
        const startingSource =
          assignment.startingSource ??
          (yield* sources.capture({
            requestId: CommandId.make(`factory:${assignment.id}:source`),
            projectId: assignment.projectId,
            ...(assignment.origin === "handover" ? { threadId: assignment.threadId } : {}),
          }));
        yield* store.commit({
          actor: { kind: "system" },
          command: {
            type: "assignment.preparation.recorded",
            commandId: CommandId.make(`factory:${assignment.id}:source-recorded`),
            assignmentId: assignment.id,
            threadId: assignment.threadId,
            stage: "preparing",
            startingSource,
          },
          now: yield* nowIso,
        });
        const qualification = yield* boundaries.prepare({
          assignmentId: assignment.id,
          threadId: assignment.threadId,
          boundaryId: assignment.grant.boundaryId,
          grant: assignment.grant,
          startingSourceId: startingSource.id,
        });
        if (qualification.status !== "qualified")
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail: qualification.reason,
          });
        if (assignment.origin === "handover") yield* sources.validateCurrent(startingSource.id);
        return { qualification, startingSource };
      }).pipe(Effect.result);
      const current = (yield* store.snapshot).assignments.find(
        (entry) => entry.id === assignment.id,
      );
      if (current?.status !== "pending" || current.grant?.epoch !== assignment.grant?.epoch) {
        yield* store.retireEffect(pending.id);
        return;
      }
      yield* store.finishEffect({
        id: pending.id,
        now: yield* nowIso,
        ...(Result.isFailure(result) ? { failed: true } : {}),
        command: Result.isFailure(result)
          ? {
              type: "assignment.prepare.failed",
              commandId: CommandId.make(`${pending.id}:receipt`),
              assignmentId: assignment.id,
              threadId: assignment.threadId,
              reason: isFactoryError(result.failure)
                ? (result.failure.detail ?? result.failure.message)
                : "The approved assignment environment could not be prepared. Existing work is preserved; resolve the environment problem and retry.",
            }
          : {
              type: "assignment.prepared",
              commandId: CommandId.make(`${pending.id}:receipt`),
              assignmentId: assignment.id,
              threadId: assignment.threadId,
              ...result.success,
            },
      });
    });

    const worker = yield* makeDrainableWorker((_wake: void) =>
      Effect.gen(function* () {
        const visited = new Set<string>();
        for (;;) {
          const pending = (yield* store.pending).filter((entry) => !visited.has(entry.id));
          if (pending.length === 0) return;
          for (const entry of pending) {
            visited.add(entry.id);
            if (entry.intent.type === "assignment.prepare") yield* prepare(entry);
            else yield* commands.withPermits(1)(launch(entry));
          }
        }
      }),
    );
    yield* worker.enqueue(undefined);

    const service = FactoryService.of({
      snapshot: (query) => store.snapshot.pipe(Effect.map(scopedSnapshot(query))),
      changes: (query) => store.changes.pipe(Stream.map(scopedSnapshot(query))),
      drain: worker.drain,
      dispatch: Effect.fn("FactoryService.dispatch")(function* (actor, command) {
        const receipt = yield* store.findReceipt({ actor, command });
        if (receipt !== undefined) return receipt;
        const allocation =
          command.type === "manager.create" ||
          command.type === "assignment.commission" ||
          command.type === "assignment.handover"
            ? {
                managerThreadId:
                  command.type === "manager.create"
                    ? ThreadId.make(yield* randomUuidV4)
                    : command.managerId,
                leadThreadId:
                  command.type === "assignment.handover"
                    ? command.threadId
                    : ThreadId.make(yield* randomUuidV4),
                assignmentId: FactoryAssignmentId.make(yield* randomUuidV4),
              }
            : undefined;
        const snapshot = yield* store.snapshot;
        let humanMessageVerified = false;
        let humanMessageId: MessageId | undefined;
        if (command.type === "assignment.commission" && actor.kind === "thread") {
          const records = yield* threads
            .getThreadRecords(
              actor.threadId,
              ["messages"],
              command.authorizationMessageId === undefined
                ? { messageRoles: ["user"] }
                : { messageIds: [command.authorizationMessageId] },
            )
            .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
          humanMessageId = records.messages.findLast(
            (message) =>
              (command.authorizationMessageId === undefined ||
                message.id === command.authorizationMessageId) &&
              message.role === "user" &&
              message.createdBy === "user" &&
              message.senderThreadId === undefined &&
              message.scheduledTaskId === undefined,
          )?.id;
          humanMessageVerified = humanMessageId !== undefined;
        }
        let handoverVerified = false;
        if (command.type === "assignment.handover" && actor.kind === "human") {
          const thread = yield* threads
            .getThreadShell(command.threadId)
            .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
          const manager = snapshot.managers.find((entry) => entry.id === command.managerId);
          handoverVerified =
            thread !== null &&
            thread.projectId === manager?.projectId &&
            thread.deletedAt === null &&
            thread.archivedAt === null &&
            thread.lineage.parentThreadId === null &&
            thread.lineage.relationshipToParent !== "subagent";
        }
        const now = yield* nowIso;
        const preflight = decide({
          state: snapshot,
          actor,
          command,
          now,
          humanMessageVerified,
          ...(humanMessageId === undefined ? {} : { humanMessageId }),
          handoverVerified,
          ...(allocation === undefined ? {} : { allocation }),
        });
        if (Result.isFailure(preflight)) return yield* preflight.failure;
        for (const assignment of snapshot.assignments) {
          const next = preflight.success.state.assignments.find(
            (entry) => entry.id === assignment.id,
          );
          if (
            assignment.grant !== undefined &&
            next?.grant !== undefined &&
            assignment.grant.epoch !== next.grant.epoch
          ) {
            yield* boundaries.stop(assignment.id);
          }
        }
        if (command.type === "manager.create") {
          const project = yield* projects
            .getById(command.projectId)
            .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
          if (Option.isNone(project)) return yield* new FactoryError({ code: "invalid-state" });
        }
        const requested =
          command.type === "manager.create"
            ? command
            : command.type === "manager.retry-onboarding"
              ? preflight.success.state.managers.find((manager) => manager.id === command.managerId)
              : undefined;
        if (requested !== undefined && actor.kind !== "human") {
          return yield* new FactoryError({ code: "permission-denied" });
        }
        const previousAssignment =
          command.type === "manager.retry-onboarding"
            ? snapshot.assignments.find((entry) => entry.managerId === command.managerId)
            : undefined;
        const replacingSetup =
          command.type === "manager.retry-onboarding" &&
          (command.workflow !== undefined || command.modelSelection !== undefined);
        if (replacingSetup && requested !== undefined && previousAssignment !== undefined) {
          for (const threadId of [command.managerId, previousAssignment.threadId]) {
            if (
              (yield* threads
                .getThreadShell(threadId)
                .pipe(
                  Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })),
                )) !== null
            )
              return yield* new FactoryError({ code: "invalid-state" });
          }
        }
        const qualification =
          requested?.projectId == null
            ? undefined
            : !replacingSetup && previousAssignment?.qualification.status === "qualified"
              ? previousAssignment.qualification
              : yield* execution.qualify({
                  projectId: requested.projectId,
                  modelSelection: requested.modelSelection,
                  workflow: requested.workflow,
                });
        const boundary =
          command.type === "manager.approve-onboarding"
            ? yield* boundaries.approve({
                managerId: command.managerId,
                configuration: command.configuration,
              })
            : undefined;
        if (command.type === "assignment.file.mutate") yield* boundaries.mutate(command);
        const verification =
          command.type === "assignment.verify" ? yield* boundaries.verify(command) : undefined;
        const result = yield* store.commit({
          actor,
          command,
          now: yield* nowIso,
          humanMessageVerified,
          ...(humanMessageId === undefined ? {} : { humanMessageId }),
          handoverVerified,
          ...(allocation === undefined ? {} : { allocation }),
          ...(qualification === undefined ? {} : { qualification }),
          ...(boundary === undefined ? {} : { boundary }),
          ...(verification === undefined ? {} : { verification }),
        });
        yield* worker.enqueue(undefined);
        return result;
      }, commands.withPermits(1)),
    });
    return FactoryService.of({
      ...service,
      dispatch: (actor, command) => {
        if (command.type !== "assignment.file.mutate" && command.type !== "assignment.verify")
          return withCommand(command.commandId, service.dispatch(actor, command));
        return withCommand(
          command.commandId,
          Effect.gen(function* () {
            const receipt = yield* store.findReceipt({ actor, command });
            if (receipt !== undefined) return receipt;
            const preflight = decide({
              state: yield* store.snapshot,
              actor,
              command,
              now: yield* nowIso,
            });
            if (Result.isFailure(preflight)) return yield* preflight.failure;
            if (command.type === "assignment.file.mutate") yield* boundaries.mutate(command);
            const verification =
              command.type === "assignment.verify" ? yield* boundaries.verify(command) : undefined;
            return yield* store.commit({
              actor,
              command,
              now: yield* nowIso,
              ...(verification === undefined ? {} : { verification }),
            });
          }),
        );
      },
    });
  }),
);
