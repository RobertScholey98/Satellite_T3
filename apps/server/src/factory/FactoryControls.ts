import { factoryIncidentBlocked } from "./FactoryCollaboration.ts";
import {
  FactoryControlId,
  FactoryError,
  MessageId,
  type FactoryAssignmentId,
  type FactoryCommandResult,
  type FactoryControl,
  type FactoryDecisionCommand,
  type FactoryEffectIntent,
  type FactoryGuidance,
  type FactoryManager,
  type FactorySnapshot,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

import type { FactoryActor, FactoryDecision } from "./FactoryState.ts";
import { factoryAuxiliaryIsCurrent } from "./FactoryAuxiliary.ts";
import {
  factorySharedAssignmentEnabled,
  factoryWorkflowRestartPending,
} from "./FactoryWorkflowOwnership.ts";

/** Where a thread sits in the factory, as `FactoryControlAccess` resolves it from lineage. */
export interface FactoryControlMembership {
  readonly threadId: ThreadId;
  readonly managerId: ThreadId;
  readonly managerRole?: "project" | "system";
  readonly projectId: ProjectId;
  readonly assignmentId?: FactoryAssignmentId;
  readonly auxiliaryThreadId?: ThreadId;
  /** Outermost first, ending at the thread's parent. Takeover checks compare positions in it. */
  readonly ancestorThreadIds: ReadonlyArray<ThreadId>;
}

/**
 * Facts the host resolves before deciding, because the pure decider cannot read threads: the
 * membership of a takeover or handback target, and proof that an escalated guidance message is a
 * real human message in that thread.
 */
export interface FactoryControlContext {
  readonly controlTarget?: FactoryControlMembership;
  readonly guidance?: {
    readonly messageId: MessageId;
    readonly target: FactoryControlMembership;
  };
}

/**
 * The reason a factory thread may not run now, or `undefined` when it may. Every path that
 * starts or continues managed work asks this: manager retirement, incidents, concluded
 * implementation, workflow restarts, authority holds, cancellation and pauses. A manager pause
 * stops only the manager's own thread; its teams keep working within their grants.
 *
 * The current retrospective thread of an assignment is exempt from the assignment-level checks,
 * since it must run after the team has concluded or been cancelled.
 */
export const factoryExecutionBlocked = (
  state: FactorySnapshot,
  member: FactoryControlMembership,
): string | undefined => {
  if (state.managers.some((entry) => entry.id === member.managerId && entry.status === "retired"))
    return "This engineering manager was retired. Its threads and evidence remain readable.";
  const auxiliary = state.auxiliaryThreads.find(
    (entry) => entry.threadId === member.auxiliaryThreadId,
  );
  const retrospective =
    auxiliary?.kind === "retrospective" &&
    auxiliary.threadId === member.threadId &&
    factoryAuxiliaryIsCurrent(
      state.assignments.find((entry) => entry.id === member.assignmentId),
      auxiliary,
      state.retros,
    );
  const assignment = state.assignments.find((entry) => entry.id === member.assignmentId);
  const incident =
    assignment && !retrospective
      ? factoryIncidentBlocked(state, assignment.id, "execution")
      : undefined;
  if (incident) return incident;
  const completion = assignment?.completion;
  if (!retrospective && completion !== undefined && completion.phase !== "collecting")
    return "Implementation has concluded. Its retrospective uses a separate read-only conversation.";
  if (!retrospective && assignment && factoryWorkflowRestartPending(state, assignment.id))
    return "This team is stopped while its explicitly selected workflow restart is prepared.";
  if (!retrospective && assignment?.wait?.kind === "authority")
    return "This team's authority is held. A workflow restart does not restore permission to work.";
  if (
    !retrospective &&
    assignment?.sharedWork &&
    !factorySharedAssignmentEnabled(state, assignment)
  )
    return "This shared assignment no longer has active repository, work or experiment authority.";
  for (const control of state.controls) {
    switch (control.kind) {
      case "cancellation":
        if (control.assignmentId === member.assignmentId && !retrospective)
          return "This assignment has been cancelled. Its work and evidence remain available.";
        break;
      case "project-pause":
        if (
          control.status === "active" &&
          (member.managerRole !== "system" || member.assignmentId !== undefined) &&
          control.projectId === member.projectId
        )
          return "This project's manager and teams are paused.";
        break;
      case "manager-pause":
        if (control.status === "active" && control.managerId === member.threadId)
          return "This engineering manager is paused. Existing teams may continue within their grants.";
        break;
      case "takeover":
        break;
    }
  }
};

/**
 * `factoryExecutionBlocked` plus the checks on who is directing the thread. Pass `undefined` as
 * the sender to skip them, and `null` for direction with no sender thread. Manager direction
 * waits while the human reviews delivery with the lead, a paused manager's direction waits, and
 * under a takeover the manager, sender-less direction and any thread above the taken-over one
 * wait until handback.
 */
export const factoryDirectionBlocked = (
  state: FactorySnapshot,
  member: FactoryControlMembership,
  senderThreadId?: ThreadId | null,
): string | undefined => {
  const blocked = factoryExecutionBlocked(state, member);
  if (blocked !== undefined || senderThreadId === undefined) return blocked;
  if (
    senderThreadId === member.managerId &&
    state.assignments.some(
      (assignment) => assignment.id === member.assignmentId && assignment.delivery?.directionHeld,
    )
  )
    return "The human is reviewing this assignment with its implementation lead. Manager direction waits until review handback.";
  if (
    senderThreadId !== null &&
    state.controls.some(
      (entry) =>
        entry.kind === "manager-pause" &&
        entry.status === "active" &&
        entry.managerId === senderThreadId,
    )
  )
    return "The engineering manager is paused. Its coordination waits until resume.";
  const path = [...member.ancestorThreadIds, member.threadId];
  for (const control of state.controls) {
    if (control.kind !== "takeover" || control.status !== "active") continue;
    const targetIndex = path.indexOf(control.threadId);
    if (targetIndex === -1) continue;
    const senderIndex = senderThreadId === null ? -1 : path.indexOf(senderThreadId);
    if (
      senderThreadId === null ||
      senderThreadId === member.managerId ||
      (senderIndex !== -1 && senderIndex < targetIndex)
    )
      return "The user has taken over this thread. Parent direction waits until handback.";
  }
};

/**
 * Keeps a manager under an active pause paused when a decision writes a new status for it. The
 * written status moves onto the pause as the status its resume restores.
 */
export const preserveFactoryManagerPauses = (
  state: FactorySnapshot,
  managers: ReadonlyArray<FactoryManager>,
) => {
  let controls = state.controls;
  const preserved = managers.map((manager) => {
    const pause = controls.find(
      (entry) =>
        entry.kind === "manager-pause" &&
        entry.status === "active" &&
        entry.managerId === manager.id,
    );
    if (
      pause?.kind !== "manager-pause" ||
      manager.status === "paused" ||
      manager.status === "retired"
    )
      return manager;
    const priorStatus = manager.status;
    controls = controls.map((entry) => (entry.id === pause.id ? { ...pause, priorStatus } : entry));
    return { ...manager, status: "paused" as const };
  });
  return { managers: preserved, controls };
};

/**
 * Decides the human's controls (pause, resume, retire, takeover, handback, cancel), the host's
 * reports of what stopping and resuming physically did, and guidance relays. Returns `undefined`
 * for any other command.
 *
 * Pausing again after a release bumps the control's generation, which the stop and resume
 * effects carry, so a host report from an earlier generation is accepted as a no-op instead of
 * changing the current one.
 */
export function decideFactoryControls(
  input: FactoryControlContext & {
    readonly state: FactorySnapshot;
    readonly actor: FactoryActor;
    readonly command: FactoryDecisionCommand;
    readonly now: string;
  },
): Result.Result<FactoryDecision, FactoryError> | undefined {
  const { state, actor, command, now } = input;
  const fail = (code: FactoryError["code"], detail?: string) =>
    Result.fail(new FactoryError({ code, ...(detail === undefined ? {} : { detail }) }));
  const accept = (
    patch: Partial<FactorySnapshot> = {},
    result: Omit<FactoryCommandResult, "revision"> = {},
    effects: ReadonlyArray<FactoryEffectIntent> = [],
  ): Result.Result<FactoryDecision, FactoryError> => {
    const revision = state.revision + 1;
    return Result.succeed({
      state: { ...state, ...patch, revision },
      result: { ...result, revision },
      effects,
    });
  };
  const save = (
    control: FactoryControl,
    effects: ReadonlyArray<FactoryEffectIntent> = [],
    patch: Partial<FactorySnapshot> = {},
  ) =>
    accept(
      {
        ...patch,
        controls: state.controls.some((entry) => entry.id === control.id)
          ? state.controls.map((entry) => (entry.id === control.id ? control : entry))
          : [...state.controls, control],
      },
      { controlId: control.id },
      effects,
    );
  const stopIntent = (control: FactoryControl): FactoryEffectIntent => ({
    type: "control.stop",
    controlId: control.id,
    generation: control.generation,
  });
  const resumeIntent = (control: FactoryControl): FactoryEffectIntent => ({
    type: "control.resume",
    controlId: control.id,
    generation: control.generation,
  });
  const retired = (control: FactoryControl) =>
    control.kind === "manager-pause" &&
    state.managers.some((entry) => entry.id === control.managerId && entry.status === "retired");

  switch (command.type) {
    case "manager.pause":
    case "project.pause": {
      if (actor.kind !== "human") return fail("permission-denied");
      const manager =
        command.type === "manager.pause"
          ? state.managers.find((entry) => entry.id === command.managerId)
          : state.managers.find((entry) => entry.projectId === command.projectId);
      // A project with no manager may still be paused when it hosts shared repository work.
      if (
        !manager &&
        (command.type !== "project.pause" ||
          !state.sharedRepositories.some((entry) => entry.projectId === command.projectId))
      )
        return fail("manager-not-found");
      const id = FactoryControlId.make(
        command.type === "manager.pause"
          ? `manager-pause:${command.managerId}`
          : `project-pause:${command.projectId}`,
      );
      const existing = state.controls.find((entry) => entry.id === id);
      if (existing && "status" in existing && existing.status === "active")
        return accept({}, { controlId: existing.id });
      const shared = {
        id,
        generation: (existing?.generation ?? 0) + 1,
        status: "active" as const,
        stop: { status: "pending" as const },
        requestedAt: now,
        updatedAt: now,
      };
      if (command.type === "project.pause") {
        const control: FactoryControl = {
          ...shared,
          kind: "project-pause",
          projectId: command.projectId,
        };
        return save(control, [stopIntent(control)]);
      }
      if (!manager || manager.status === "paused" || manager.status === "retired")
        return fail("invalid-state");
      const control: FactoryControl = {
        ...shared,
        kind: "manager-pause",
        managerId: manager.id,
        priorStatus: manager.status,
      };
      return save(control, [stopIntent(control)], {
        managers: state.managers.map((entry) =>
          entry.id === manager.id ? { ...entry, status: "paused", updatedAt: now } : entry,
        ),
      });
    }
    case "manager.resume":
    case "project.resume": {
      if (actor.kind !== "human") return fail("permission-denied");
      const control = state.controls.find((entry) =>
        command.type === "manager.resume"
          ? entry.kind === "manager-pause" && entry.managerId === command.managerId
          : entry.kind === "project-pause" && entry.projectId === command.projectId,
      );
      if (!control || (control.kind !== "manager-pause" && control.kind !== "project-pause"))
        return fail("invalid-state");
      if (retired(control))
        return fail("invalid-state", "A retired manager stays stopped. Create a new manager.");
      if (control.status === "released" || control.resume?.status === "pending")
        return accept({}, { controlId: control.id });
      // Releasing is always safe, so a stop that failed does not trap the pause.
      if (control.stop.status === "pending")
        return fail("invalid-state", "Wait for the stop to finish before resuming.");
      return save({ ...control, resume: { status: "pending" }, updatedAt: now }, [
        resumeIntent(control),
      ]);
    }
    case "manager.retire": {
      if (actor.kind !== "human") return fail("permission-denied");
      const manager = state.managers.find((entry) => entry.id === command.managerId);
      if (!manager) return fail("manager-not-found");
      if (manager.status === "retired") return accept({}, { managerId: manager.id });
      if (manager.role === "system" && command.reason === undefined)
        return fail("invalid-state", "Give a reason for retiring the system manager.");
      // The manager's pause stops its own thread and each cancellation stops one team. Threads,
      // evidence and history stay; the released project, or the environment's system-manager
      // role, can be filled again by a new manager.
      const pauseId = FactoryControlId.make(`manager-pause:${manager.id}`);
      const existing = state.controls.find((entry) => entry.id === pauseId);
      const pause: FactoryControl | undefined =
        existing?.kind === "manager-pause" && existing.status === "active"
          ? undefined
          : {
              id: pauseId,
              kind: "manager-pause",
              managerId: manager.id,
              priorStatus: manager.status === "paused" ? "active" : manager.status,
              generation: (existing?.generation ?? 0) + 1,
              status: "active",
              stop: { status: "pending" },
              requestedAt: now,
              updatedAt: now,
            };
      const cancelled = state.assignments.filter(
        (entry) =>
          entry.managerId === manager.id &&
          entry.outcome === undefined &&
          entry.status !== "complete" &&
          entry.completion?.phase !== "concluded",
      );
      const cancellations = cancelled.map((assignment): FactoryControl => ({
        kind: "cancellation",
        id: FactoryControlId.make(`cancellation:${assignment.id}`),
        generation: 1,
        assignmentId: assignment.id,
        managerId: manager.id,
        stop: { status: "pending" },
        requestedAt: now,
        updatedAt: now,
      }));
      const retros = state.retros.filter(
        (retro) =>
          retro.reports.phase !== "complete" &&
          retro.execution.status !== "stopped" &&
          state.assignments.some(
            (entry) => entry.id === retro.assignmentId && entry.managerId === manager.id,
          ),
      );
      const added = [...(pause ? [pause] : []), ...cancellations];
      return accept(
        {
          managers: state.managers.map((entry) =>
            entry.id === manager.id
              ? {
                  ...entry,
                  status: "retired",
                  wait: null,
                  ...(command.reason === undefined ? {} : { retiredReason: command.reason }),
                  updatedAt: now,
                }
              : entry,
          ),
          assignments: state.assignments.map((entry) =>
            cancelled.includes(entry)
              ? {
                  ...entry,
                  status: "waiting",
                  outcome: {
                    kind: "cancelled",
                    controlId: FactoryControlId.make(`cancellation:${entry.id}`),
                  },
                  updatedAt: now,
                }
              : entry,
          ),
          controls: [
            ...state.controls.filter((entry) => !added.some((control) => control.id === entry.id)),
            ...added,
          ],
        },
        { managerId: manager.id },
        [
          ...added.map(stopIntent),
          ...retros.map((retro): FactoryEffectIntent => ({
            type: "retro.stop",
            retroId: retro.id,
          })),
        ],
      );
    }
    case "thread.takeover": {
      if (actor.kind !== "human") return fail("permission-denied");
      const member = input.controlTarget;
      const assignment = state.assignments.find((entry) => entry.id === member?.assignmentId);
      const auxiliary = state.auxiliaryThreads.find(
        (entry) => entry.threadId === member?.auxiliaryThreadId,
      );
      const retrospective =
        auxiliary?.kind === "retrospective" &&
        factoryAuxiliaryIsCurrent(assignment, auxiliary, state.retros);
      if (
        !member ||
        member.threadId !== command.threadId ||
        !assignment ||
        assignment.managerId !== member.managerId ||
        assignment.projectId !== member.projectId ||
        // A team with an outcome can be taken over only through its current retrospective
        // thread, and the manager's own thread never.
        (assignment.outcome !== undefined && !retrospective) ||
        member.threadId === member.managerId
      )
        return fail("invalid-state");
      const id = FactoryControlId.make(`takeover:${command.threadId}`);
      const existing = state.controls.find((entry) => entry.id === id);
      if (existing?.kind === "takeover" && existing.status === "active")
        return accept({}, { controlId: id });
      return save({
        id,
        kind: "takeover",
        generation: (existing?.generation ?? 0) + 1,
        status: "active",
        threadId: member.threadId,
        assignmentId: assignment.id,
        managerId: member.managerId,
        parentThreadId: member.ancestorThreadIds.at(-1) ?? member.managerId,
        requestedAt: now,
        updatedAt: now,
      });
    }
    case "thread.handback": {
      if (actor.kind !== "human") return fail("permission-denied");
      const control = state.controls.find(
        (entry) => entry.kind === "takeover" && entry.threadId === command.threadId,
      );
      if (!control || control.kind !== "takeover") return fail("invalid-state");
      if (control.status === "released") return accept({}, { controlId: control.id });
      return save({ ...control, status: "released", updatedAt: now }, [
        {
          type: "thread.queue.resume",
          controlId: control.id,
          generation: control.generation,
          threadId: control.threadId,
        },
      ]);
    }
    case "assignment.cancel": {
      const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
      if (!assignment) return fail("assignment-not-found");
      if (assignment.completion?.phase === "concluded")
        return fail(
          "invalid-state",
          "This implementation has already concluded. Pause the project or take over its retrospective to control the remaining review.",
        );
      // Specification 1 stories 25-26: the user cancels and supplies the reason the retro waits for.
      if (actor.kind !== "human") return fail("permission-denied");
      const existing = state.controls.find(
        (entry) => entry.kind === "cancellation" && entry.assignmentId === assignment.id,
      );
      if (existing) return accept({}, { controlId: existing.id, assignmentId: assignment.id });
      if (assignment.status === "complete") return fail("invalid-state");
      const control: FactoryControl = {
        kind: "cancellation",
        id: FactoryControlId.make(`cancellation:${assignment.id}`),
        generation: 1,
        assignmentId: assignment.id,
        managerId: assignment.managerId,
        stop: { status: "pending" },
        requestedAt: now,
        updatedAt: now,
      };
      return save(control, [stopIntent(control)], {
        assignments: state.assignments.map((entry) =>
          entry.id === assignment.id
            ? {
                ...entry,
                status: "waiting",
                outcome: { kind: "cancelled", controlId: control.id },
                updatedAt: now,
              }
            : entry,
        ),
      });
    }
    case "assignment.cancellation-reason": {
      if (actor.kind !== "human") return fail("permission-denied");
      if (
        state.assignments.some(
          (entry) => entry.id === command.assignmentId && entry.completion?.phase === "concluded",
        )
      )
        return fail(
          "invalid-state",
          "The original cancellation reason is part of the concluded retrospective evidence. Add further context in the retrospective conversation.",
        );
      const control = state.controls.find(
        (entry) => entry.kind === "cancellation" && entry.assignmentId === command.assignmentId,
      );
      if (!control || control.kind !== "cancellation" || control.stop.status !== "confirmed")
        return fail(
          "invalid-state",
          "The team must finish stopping before a cancellation reason can be recorded.",
        );
      return save({
        ...control,
        reason: { text: command.reason, recordedAt: now },
        updatedAt: now,
      });
    }
    case "control.retry": {
      if (actor.kind !== "human") return fail("permission-denied");
      const control = state.controls.find((entry) => entry.id === command.controlId);
      if (!control || control.generation !== command.generation || control.kind === "takeover")
        return fail("invalid-state");
      if (control.kind !== "cancellation" && control.status === "released")
        return fail("invalid-state");
      if (control.kind !== "cancellation" && control.resume?.status === "failed") {
        if (retired(control))
          return fail("invalid-state", "A retired manager stays stopped. Create a new manager.");
        return save({ ...control, resume: { status: "pending" }, updatedAt: now }, [
          resumeIntent(control),
        ]);
      }
      if (control.stop.status !== "failed") return fail("invalid-state");
      return save({ ...control, stop: { status: "pending" }, updatedAt: now }, [
        stopIntent(control),
      ]);
    }
    case "control.stop.targets.recorded":
    case "control.stop.recorded":
    case "control.stop.failed":
    case "control.resume.recorded":
    case "control.resume.failed": {
      if (actor.kind !== "system") return fail("permission-denied");
      const control = state.controls.find((entry) => entry.id === command.controlId);
      if (!control || control.kind === "takeover") return fail("invalid-state");
      if (
        control.generation !== command.generation ||
        (control.kind !== "cancellation" && control.status === "released")
      )
        return accept({}, { controlId: control.id });
      if (command.type === "control.stop.targets.recorded") {
        // A cancellation never resumes, so it keeps no targets. For a pause the first record of
        // what was running wins; a retried stop would find that work already stopped.
        if (control.kind === "cancellation" || control.resumeThreadIds !== undefined)
          return accept({}, { controlId: control.id });
        return save({
          ...control,
          resumeThreadIds: [...new Set(command.threadIds)],
          ...(command.resumeQueues === undefined ? {} : { resumeQueues: command.resumeQueues }),
          updatedAt: now,
        });
      }
      if (command.type === "control.stop.recorded" || command.type === "control.stop.failed") {
        if (control.stop.status === "confirmed") return accept({}, { controlId: control.id });
        return save({
          ...control,
          stop:
            command.type === "control.stop.recorded"
              ? { status: "confirmed", stoppedAt: now }
              : { status: "failed", detail: command.reason },
          updatedAt: now,
        });
      }
      if (
        control.kind === "cancellation" ||
        control.stop.status === "pending" ||
        control.resume === undefined
      )
        return fail("invalid-state");
      if (command.type === "control.resume.failed")
        return save({
          ...control,
          resume: { status: "failed", detail: command.reason },
          updatedAt: now,
        });
      // The pause ends only once the host confirms the resume, then the interrupted threads
      // are told to continue and their held queues are released.
      const { resume: _, ...released } = control;
      return save(
        { ...released, status: "released", updatedAt: now },
        [
          ...(control.resumeThreadIds ?? []).map((threadId): FactoryEffectIntent => ({
            type: "thread.deliver",
            kind: "continuation",
            threadId,
            messageId: MessageId.make(
              `factory-resume:${control.id}:${control.generation}:${threadId}`,
            ),
            text: "The explicit pause has been released. Continue the interrupted work only within the current assignment, permissions, and remaining waits.",
          })),
          ...(control.resumeQueues ?? [])
            .filter((queue) => queue.runIds.length > 0)
            .map((queue): FactoryEffectIntent => ({
              type: "thread.queue.resume",
              controlId: control.id,
              generation: control.generation,
              threadId: queue.threadId,
              runIds: queue.runIds,
            })),
        ],
        control.kind === "manager-pause"
          ? {
              managers: state.managers.map((entry) =>
                entry.id === control.managerId && entry.status !== "retired"
                  ? { ...entry, status: control.priorStatus, updatedAt: now }
                  : entry,
              ),
            }
          : {},
      );
    }
    case "guidance.observed":
    case "guidance.escalate": {
      if (command.type === "guidance.observed" && actor.kind !== "system")
        return fail("permission-denied");
      const proof = input.guidance;
      const assignmentId =
        command.type === "guidance.observed" ? command.assignmentId : proof?.target.assignmentId;
      const assignment = state.assignments.find((entry) => entry.id === assignmentId);
      if (!assignment) return fail("assignment-not-found");
      // Escalation needs the host's proof that the message is the human's own, in a thread under
      // this assignment's manager and project. Besides the human, only the lead, the manager or
      // that thread may escalate it.
      if (
        command.type === "guidance.escalate" &&
        (!proof ||
          proof.messageId !== command.messageId ||
          proof.target.threadId !== command.threadId ||
          proof.target.managerId !== assignment.managerId ||
          proof.target.projectId !== assignment.projectId ||
          (actor.kind !== "human" &&
            (actor.kind !== "thread" ||
              ![assignment.threadId, assignment.managerId, command.threadId].includes(
                actor.threadId,
              ))))
      )
        return fail("permission-denied");
      const existing = state.guidance.find(
        (entry) => entry.threadId === command.threadId && entry.messageId === command.messageId,
      );
      // A message is observed once and escalated at most once.
      if (existing && (command.type === "guidance.observed" || existing.escalation !== undefined))
        return accept();
      const guidance: FactoryGuidance = {
        ...(existing ?? {
          threadId: command.threadId,
          messageId: command.messageId,
          assignmentId: assignment.id,
          observedAt: now,
        }),
        ...(command.type === "guidance.escalate"
          ? { escalation: { summary: command.summary, escalatedAt: now } }
          : {}),
      };
      // Both relays carry the human's message, so the host sends them without a sender thread.
      // An independent review or diagnosis thread may never direct work as a sender.
      const effects: FactoryEffectIntent[] = [];
      if (!existing && command.threadId !== assignment.threadId)
        effects.push({
          type: "thread.deliver",
          kind: "guidance",
          threadId: assignment.threadId,
          messageId: MessageId.make(`factory-guidance:${command.threadId}:${command.messageId}`),
          sourceMessageId: command.messageId,
          text: `The user gave guidance in thread ${command.threadId}, message ${command.messageId}. Read it and coordinate the existing assignment. Guidance does not expand scope or transfer ownership. If it changes scope or priority, send it to your manager with factory_dispatch guidance.escalate using that thread and message ID and a one-line summary.`,
        });
      if (command.type === "guidance.escalate")
        effects.push({
          type: "thread.deliver",
          kind: "coordination",
          threadId: assignment.managerId,
          messageId: MessageId.make(
            `factory-guidance-escalation:${command.threadId}:${command.messageId}`,
          ),
          sourceMessageId: command.messageId,
          text: `Review a requested scope or priority decision for assignment ${assignment.id}. Source human message ${command.messageId} in ${command.threadId}. ${command.summary}`,
        });
      return accept(
        {
          guidance: existing
            ? state.guidance.map((entry) => (entry === existing ? guidance : entry))
            : [...state.guidance, guidance],
        },
        { assignmentId: assignment.id },
        effects,
      );
    }
    case "thread.delivery.recorded":
    case "thread.queue.resumed":
      return actor.kind === "system" ? accept() : fail("permission-denied");
    default:
      return undefined;
  }
}
