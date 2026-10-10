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
        const assignment = state.assignments.find((entry) => entry.threadId === threadId);
        if (manager !== undefined) {
          return { ownerThreadId: threadId, manager, assignment: undefined };
        }
        if (assignment !== undefined) {
          const owner = state.managers.find((entry) => entry.id === assignment.managerId);
          if (owner === undefined) return yield* unavailable();
          return { ownerThreadId: threadId, manager: owner, assignment };
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
          const sameManager = target?.manager.id === member.manager.id;
          const sameAssignment =
            member.assignment !== undefined && target?.assignment?.id === member.assignment.id;
          const ownManager =
            target?.assignment === undefined && target?.manager.id === member.manager.id;
          scopedCommunication =
            sameManager &&
            (member.assignment === undefined ||
              sameAssignment ||
              (ownManager && toolName !== "t3_thread_interrupt"));
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
        };
      }),
    dispatch: (invocation, command) =>
      Effect.gen(function* () {
        if (invocation.thread === undefined) return yield* denied();
        const member = yield* managedCaller(invocation);
        const descendantOperation =
          member.assignment !== undefined &&
          member.assignment.kind !== "onboarding" &&
          (((command.type === "assignment.file.mutate" || command.type === "assignment.verify") &&
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
