import {
  OrchestratorMcpFailure,
  type FactoryCommand,
  type FactoryCommandResult,
  type FactoryError,
  type FactorySnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryStore from "./FactoryStore.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";

export class FactoryMcpGuard extends Context.Service<
  FactoryMcpGuard,
  {
    readonly authorize: (
      invocation: McpInvocationScope,
      toolName: string,
      payload?: unknown,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly snapshot: (
      invocation: McpInvocationScope,
    ) => Effect.Effect<FactorySnapshot, OrchestratorMcpFailure | FactoryError>;
    readonly dispatch: (
      invocation: McpInvocationScope,
      command: FactoryCommand,
    ) => Effect.Effect<FactoryCommandResult, OrchestratorMcpFailure | FactoryError>;
  }
>()("t3/factory/FactoryMcpGuard") {}

const denied = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message:
      "This managed thread can use only its scoped factory and approved team tools. This host tool is outside its execution grant.",
  });

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "The managed execution boundary could not be verified. No host tool was run.",
  });
const hasThreadTarget = Schema.is(Schema.Struct({ threadId: ThreadId }));

const make = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const execution = yield* FactoryExecution.FactoryExecution;
  const factory = yield* FactoryService.FactoryService;
  const controls = yield* FactoryControlAccess.FactoryControlAccess;

  const membership = (invocation: McpInvocationScope) =>
    Effect.gen(function* () {
      if (invocation.thread === undefined) return undefined;
      const state = yield* store.snapshot.pipe(Effect.mapError(unavailable));
      const visited = new Set<ThreadId>();
      let threadId = invocation.thread.threadId;
      for (;;) {
        if (visited.has(threadId) || visited.size >= 64) return yield* unavailable();
        visited.add(threadId);
        const manager = state.managers.find((entry) => entry.threadId === threadId);
        const auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === threadId);
        const assignment = state.assignments.find(
          (entry) =>
            entry.threadId === threadId ||
            entry.previousLeadThreadIds?.includes(threadId) ||
            entry.id === auxiliary?.assignmentId,
        );
        if (manager !== undefined) {
          return { ownerThreadId: threadId, manager, assignment: undefined, auxiliary: undefined };
        }
        if (assignment !== undefined) {
          const owner = state.managers.find((entry) => entry.id === assignment.managerId);
          if (owner === undefined) return yield* unavailable();
          return { ownerThreadId: threadId, manager: owner, assignment, auxiliary };
        }
        const thread = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
        if (thread === null || thread.deletedAt !== null) return yield* unavailable();
        if (thread.lineage.parentThreadId === null) {
          if (thread.lineage.relationshipToParent === "subagent") return yield* unavailable();
          return undefined;
        }
        threadId = thread.lineage.parentThreadId;
      }
    });

  const managedCaller = (invocation: McpInvocationScope) =>
    Effect.gen(function* () {
      const member = yield* membership(invocation);
      if (member === undefined) return yield* denied();
      return member;
    });

  return FactoryMcpGuard.of({
    authorize: (invocation, toolName, payload) =>
      Effect.gen(function* () {
        const member = yield* membership(invocation);
        if (member === undefined) return;
        if (invocation.thread !== undefined)
          yield* controls
            .assertExecution(invocation.thread.threadId)
            .pipe(Effect.mapError(unavailable));
        const implementationTeamTool =
          member.auxiliary === undefined &&
          member.assignment !== undefined &&
          member.assignment.kind !== "onboarding" &&
          ["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel"].includes(
            toolName,
          );
        let scopedCommunication = false;
        if (
          ["t3_thread_read", "t3_thread_send", "t3_thread_wait", "t3_thread_interrupt"].includes(
            toolName,
          ) &&
          invocation.thread !== undefined &&
          hasThreadTarget(payload)
        ) {
          const target = yield* membership({
            ...invocation,
            thread: { ...invocation.thread, threadId: payload.threadId },
          });
          const targetControls = yield* controls
            .membership(payload.threadId)
            .pipe(Effect.mapError(unavailable));
          const sameManager = target?.manager.id === member.manager.id;
          const sameAssignment =
            member.assignment !== undefined && target?.assignment?.id === member.assignment.id;
          const ownManager =
            target?.assignment === undefined && target?.manager.id === member.manager.id;
          scopedCommunication =
            (member.auxiliary === undefined || toolName === "t3_thread_read") &&
            sameManager &&
            (member.auxiliary?.kind !== "retrospective" || sameAssignment) &&
            (member.assignment === undefined ||
              sameAssignment ||
              (ownManager && toolName !== "t3_thread_interrupt"));
          if (
            scopedCommunication &&
            toolName === "t3_thread_send" &&
            target?.assignment?.wait != null &&
            (member.assignment === undefined ||
              targetControls?.ancestorThreadIds.includes(invocation.thread.threadId))
          )
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message:
                "Parent direction is held while this assignment waits. Resolve its recorded prerequisite through the scoped factory workflow before continuing work.",
            });
          if (
            scopedCommunication &&
            (toolName === "t3_thread_send" || toolName === "t3_thread_interrupt")
          )
            yield* controls
              .assertDirection({
                threadId: payload.threadId,
                senderThreadId: invocation.thread.threadId,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorMcpFailure({
                      code: "capability_denied",
                      message: cause.detail ?? cause.message,
                    }),
                ),
              );
        }
        if (
          toolName !== "factory_snapshot" &&
          toolName !== "factory_dispatch" &&
          !(
            member.auxiliary?.kind === "delivery-review" &&
            [
              "factory_preview_action",
              "factory_preview_snapshot",
              "factory_preview_finish",
            ].includes(toolName)
          ) &&
          !implementationTeamTool &&
          !scopedCommunication
        )
          return yield* denied();
        const profile = yield* execution
          .runtimePolicyFor(member.ownerThreadId)
          .pipe(Effect.mapError(unavailable));
        if (profile === undefined) return yield* unavailable();
      }),
    snapshot: (invocation) =>
      Effect.gen(function* () {
        const { manager, assignment } = yield* managedCaller(invocation);
        if (manager.projectId === null) return yield* denied();
        const snapshot = yield* factory.snapshot({ projectId: manager.projectId });
        return {
          ...snapshot,
          managers: snapshot.managers.filter((entry) => entry.id === manager.id),
          assignments: snapshot.assignments.filter((entry) =>
            assignment === undefined ? entry.managerId === manager.id : entry.id === assignment.id,
          ),
          guidance: snapshot.guidance.filter(
            (entry) => assignment === undefined || entry.assignmentId === assignment.id,
          ),
          controls: snapshot.controls.flatMap((entry): FactorySnapshot["controls"] => {
            if (assignment === undefined) return [entry];
            if (entry.kind === "manager-pause")
              return entry.managerId === assignment.managerId
                ? [Struct.omit(entry, ["resumeThreadIds", "resumeQueues"])]
                : [];
            if (entry.kind === "project-pause")
              return entry.projectId === assignment.projectId
                ? [Struct.omit(entry, ["resumeThreadIds", "resumeQueues"])]
                : [];
            return entry.assignmentId === assignment.id ? [entry] : [];
          }),
          dependencies: snapshot.dependencies.filter(
            (entry) =>
              assignment === undefined ||
              entry.assignmentId === assignment.id ||
              entry.supportingAssignmentId === assignment.id,
          ),
          auxiliaryThreads: snapshot.auxiliaryThreads.filter(
            (entry) => assignment === undefined || entry.assignmentId === assignment.id,
          ),
          retros: snapshot.retros.filter(
            (entry) => assignment === undefined || entry.assignmentId === assignment.id,
          ),
          findings: snapshot.findings.filter(
            (entry) => assignment === undefined || entry.assignmentId === assignment.id,
          ),
          followups: snapshot.followups.filter(
            (entry) => assignment === undefined || entry.assignmentId === assignment.id,
          ),
        };
      }),
    dispatch: (invocation, command) =>
      Effect.gen(function* () {
        if (invocation.thread === undefined) return yield* denied();
        yield* controls
          .assertExecution(invocation.thread.threadId)
          .pipe(Effect.mapError(unavailable));
        const member = yield* managedCaller(invocation);
        const retroCommand =
          member.auxiliary?.kind === "retrospective" &&
          ((command.type === "retro.team.submit" &&
            command.retroId === member.auxiliary.incidentId) ||
            ((command.type === "finding.report" || command.type === "followup.request") &&
              command.assignmentId === member.assignment?.id) ||
            (command.type === "finding.escalate" &&
              (yield* store.snapshot).findings.some(
                (entry) =>
                  entry.id === command.findingId && entry.assignmentId === member.assignment?.id,
              )));
        if (
          member.auxiliary !== undefined &&
          (member.auxiliary.threadId !== invocation.thread.threadId ||
            (member.auxiliary.kind === "retrospective"
              ? !retroCommand
              : member.auxiliary.kind === "diagnosis"
                ? command.type !== "auxiliary.report" ||
                  command.threadId !== invocation.thread.threadId
                : !(
                    command.type === "delivery.review.report" ||
                    command.type === "delivery.preview.start" ||
                    command.type === "delivery.preview.stop"
                  ) ||
                  command.assignmentId !== member.assignment?.id ||
                  command.revisionId !== member.auxiliary.revisionId ||
                  ("reviewId" in command && command.reviewId !== member.auxiliary.incidentId)))
        )
          return yield* denied();
        const descendantOperation =
          member.assignment !== undefined &&
          member.assignment.kind !== "onboarding" &&
          (((command.type === "assignment.file.mutate" ||
            command.type === "assignment.verify" ||
            command.type === "finding.report") &&
            command.assignmentId === member.assignment.id) ||
            (command.type === "guidance.escalate" &&
              command.threadId === invocation.thread.threadId));
        if (member.ownerThreadId !== invocation.thread.threadId && !descendantOperation)
          return yield* denied();
        return yield* factory.dispatch(
          {
            kind: "thread",
            threadId: invocation.thread.threadId,
            ...(member.assignment === undefined ? {} : { assignmentId: member.assignment.id }),
          },
          command,
        );
      }),
  });
});

export const layer = Layer.effect(FactoryMcpGuard, make).pipe(
  Layer.provide(FactoryControlAccess.layer),
);
