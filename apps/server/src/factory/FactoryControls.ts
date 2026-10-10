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

export interface FactoryControlMembership {
  readonly threadId: ThreadId;
  readonly managerId: ThreadId;
  readonly projectId: ProjectId;
  readonly assignmentId?: FactoryAssignmentId;
  readonly ancestorThreadIds: ReadonlyArray<ThreadId>;
}

export interface FactoryControlContext {
  readonly controlTarget?: FactoryControlMembership;
  readonly guidance?: {
    readonly messageId: MessageId;
    readonly target: FactoryControlMembership;
  };
}

export const factoryExecutionBlocked = (
  state: FactorySnapshot,
  member: FactoryControlMembership,
): string | undefined => {
  for (const control of state.controls) {
    switch (control.kind) {
      case "cancellation":
        if (control.assignmentId === member.assignmentId)
          return "This assignment has been cancelled. Its work and evidence remain available.";
        break;
      case "project-pause":
        if (control.status === "active" && control.projectId === member.projectId)
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

export const factoryDirectionBlocked = (
  state: FactorySnapshot,
  member: FactoryControlMembership,
  senderThreadId?: ThreadId | null,
): string | undefined => {
  const blocked = factoryExecutionBlocked(state, member);
  if (blocked !== undefined || senderThreadId === undefined) return blocked;
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
    if (pause?.kind !== "manager-pause" || manager.status === "paused") return manager;
    const priorStatus = manager.status;
    controls = controls.map((entry) => (entry.id === pause.id ? { ...pause, priorStatus } : entry));
    return { ...manager, status: "paused" as const };
  });
  return { managers: preserved, controls };
};

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

  switch (command.type) {
    case "manager.pause":
    case "project.pause": {
      if (actor.kind !== "human") return fail("permission-denied");
      const manager =
        command.type === "manager.pause"
          ? state.managers.find((entry) => entry.id === command.managerId)
          : state.managers.find((entry) => entry.projectId === command.projectId);
      if (!manager) return fail("manager-not-found");
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
      if (manager.status === "paused") return fail("invalid-state");
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
      if (control.status === "released" || control.resume?.status === "pending")
        return accept({}, { controlId: control.id });
      if (control.stop.status !== "confirmed")
        return fail("invalid-state", "Wait for the stop to be confirmed before resuming.");
      return save({ ...control, resume: { status: "pending" }, updatedAt: now }, [
        resumeIntent(control),
      ]);
    }
    case "thread.takeover": {
      if (actor.kind !== "human") return fail("permission-denied");
      const member = input.controlTarget;
      const assignment = state.assignments.find((entry) => entry.id === member?.assignmentId);
      if (
        !member ||
        member.threadId !== command.threadId ||
        !assignment ||
        assignment.managerId !== member.managerId ||
        assignment.projectId !== member.projectId ||
        assignment.outcome !== undefined ||
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
      if (
        actor.kind !== "human" &&
        (actor.kind !== "thread" || actor.threadId !== assignment.managerId)
      )
        return fail("permission-denied");
      if (
        actor.kind === "thread" &&
        (factoryExecutionBlocked(state, {
          threadId: actor.threadId,
          managerId: assignment.managerId,
          projectId: assignment.projectId,
          ancestorThreadIds: [],
        }) !== undefined ||
          state.controls.some(
            (entry) =>
              entry.kind === "takeover" &&
              entry.status === "active" &&
              entry.assignmentId === assignment.id,
          ))
      )
        return fail("permission-denied");
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
      if (control.kind !== "cancellation" && control.resume?.status === "failed")
        return save({ ...control, resume: { status: "pending" }, updatedAt: now }, [
          resumeIntent(control),
        ]);
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
        control.stop.status !== "confirmed" ||
        control.resume === undefined
      )
        return fail("invalid-state");
      if (command.type === "control.resume.failed")
        return save({
          ...control,
          resume: { status: "failed", detail: command.reason },
          updatedAt: now,
        });
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
                entry.id === control.managerId
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
      const effects: FactoryEffectIntent[] = [];
      if (!existing && command.threadId !== assignment.threadId)
        effects.push({
          type: "thread.deliver",
          kind: "guidance",
          threadId: assignment.threadId,
          messageId: MessageId.make(`factory-guidance:${command.threadId}:${command.messageId}`),
          sourceThreadId: command.threadId,
          sourceMessageId: command.messageId,
          text: `The user gave guidance in worker thread ${command.threadId}, message ${command.messageId}. Read it and coordinate the existing assignment. Guidance does not expand scope or transfer ownership.`,
        });
      if (command.type === "guidance.escalate")
        effects.push({
          type: "thread.deliver",
          kind: "coordination",
          threadId: assignment.managerId,
          messageId: MessageId.make(
            `factory-guidance-escalation:${command.threadId}:${command.messageId}`,
          ),
          sourceThreadId: command.threadId,
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
