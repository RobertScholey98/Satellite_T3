import {
  CommandId,
  FactoryAssignmentId,
  FactoryError,
  MessageId,
  ThreadId,
  type FactoryCommand,
  type FactoryCommandResult,
  type FactoryEffectIntent,
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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { FactoryExecution } from "./FactoryExecution.ts";
import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";
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

const onboardingInstructions = (intent: FactoryEffectIntent) =>
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
    const threads = yield* ThreadManagementService;
    const projects = yield* ProjectService;
    const commands = yield* Semaphore.make(1);

    const launch = Effect.fn("FactoryService.launch")(function* (pending: PendingFactoryEffect) {
      const { intent } = pending;
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
            title: intent.purpose === "manager" ? manager.name : "Project onboarding",
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
          ...(intent.purpose === "onboarding" ? { senderThreadId: intent.managerId } : {}),
          text:
            intent.purpose === "onboarding"
              ? onboardingInstructions(intent)
              : [
                  `You are the engineering manager for project ${intent.projectId}. Your durable manager identity is ${intent.managerId}. The human is your manager.`,
                  `Onboarding lead ${assignment.threadId} owns discovery assignment ${assignment.id}. Use factory_snapshot to inspect its findings and waits. A read-only tracked snapshot is mounted at /workspace; owned workflow ${intent.workflow.revision} is at /workflow.`,
                  "You coordinate scoped implementation teams and project priorities. Implementation leads own code, internal reviews, verification, and the complete PR process. You do not implement or review their PRs. You and the system manager are peers with different remits.",
                  "Currently onboarding is in progress. Acknowledge the assignment briefly, then wait for an actionable event or the human. Do not poll, start implementation, or attempt to broaden execution permissions. Unresolved permissions and project decisions must remain visible.",
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
              "The confined thread could not start. Check the environment's provider and Docker availability, then retry onboarding. Existing work is preserved.",
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

    const worker = yield* makeDrainableWorker((_wake: void) =>
      store.pending.pipe(
        Effect.flatMap((pending) =>
          Effect.forEach(pending, (entry) => commands.withPermits(1)(launch(entry)), {
            discard: true,
          }),
        ),
      ),
    );
    yield* worker.enqueue(undefined);

    return FactoryService.of({
      snapshot: (query) => store.snapshot.pipe(Effect.map(scopedSnapshot(query))),
      changes: (query) => store.changes.pipe(Stream.map(scopedSnapshot(query))),
      drain: worker.drain,
      dispatch: Effect.fn("FactoryService.dispatch")(function* (actor, command) {
        const receipt = yield* store.findReceipt({ actor, command });
        if (receipt !== undefined) return receipt;
        const allocation =
          command.type === "manager.create"
            ? {
                managerThreadId: ThreadId.make(yield* randomUuidV4),
                leadThreadId: ThreadId.make(yield* randomUuidV4),
                assignmentId: FactoryAssignmentId.make(yield* randomUuidV4),
              }
            : undefined;
        const snapshot = yield* store.snapshot;
        const now = yield* nowIso;
        const preflight = decide({
          state: snapshot,
          actor,
          command,
          now,
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
        const result = yield* store.commit({
          actor,
          command,
          now: yield* nowIso,
          ...(allocation === undefined ? {} : { allocation }),
          ...(qualification === undefined ? {} : { qualification }),
          ...(boundary === undefined ? {} : { boundary }),
        });
        yield* worker.enqueue(undefined);
        return result;
      }, commands.withPermits(1)),
    });
  }),
);
