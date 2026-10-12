import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryStore from "./FactoryStore.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryThreadScope from "./FactoryThreadScope.ts";
import { currentFactoryMergeOperation } from "./FactoryMergeOperation.ts";

import type {
  FactoryPreviewSnapshotToolkit,
  FactoryToolkit,
} from "../mcp/toolkits/factory/tools.ts";
import type { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";

// The tool names this guard rules on, checked against the toolkits that register them.
type GuardedTool =
  | keyof (typeof FactoryToolkit)["tools"]
  | keyof (typeof FactoryPreviewSnapshotToolkit)["tools"]
  | keyof (typeof OrchestratorToolkit)["tools"];
const isTool = (toolName: string, ...names: ReadonlyArray<GuardedTool>) =>
  names.some((name) => name === toolName);

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
const isIntegrationRefresh = Schema.is(
  Schema.Struct({
    command: Schema.Struct({
      type: Schema.Literal("integration.refresh"),
      integrationId: Schema.String,
    }),
  }),
);
const isMergeOperationRequest = Schema.is(
  Schema.Struct({
    command: Schema.Struct({
      type: Schema.Literals([
        "merge.operation.reconcile",
        "merge.operation.retry",
        "merge.operation.escalate",
      ]),
      operationId: Schema.String,
    }),
  }),
);

/**
 * Confines managed threads on `/mcp`. A thread that belongs to a manager,
 * assignment or auxiliary review sees the factory tools and may call only the
 * tools its role allows; ordinary threads and outside clients are untouched.
 * What each factory tool returns is scoped again by `FactoryThreadScope`.
 */
const make = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const execution = yield* FactoryExecution.FactoryExecution;
  const controls = yield* FactoryControlAccess.FactoryControlAccess;
  const resolveMember = FactoryThreadScope.makeThreadMember(store, threads);
  const membership = (threadId: ThreadId) =>
    resolveMember(threadId).pipe(Effect.mapError(unavailable));
  type Member = NonNullable<Effect.Success<ReturnType<typeof membership>>>;

  const authorize = (threadId: ThreadId, member: Member, toolName: string, payload: unknown) =>
    Effect.gen(function* () {
      const integrationLead =
        member.auxiliary === undefined &&
        member.assignment?.integrationId !== undefined &&
        member.assignment.threadId === threadId;
      const mergeOperationTool =
        isTool(toolName, "factory_merge_group_get", "factory_merge_operation_action") ||
        (isTool(toolName, "factory_dispatch") && isMergeOperationRequest(payload));
      yield* controls.assertExecution(threadId).pipe(Effect.mapError(unavailable));
      // Execution admits a frozen lead only so it can inspect and recover its shared merge.
      if (
        integrationLead &&
        member.assignment?.integrationId !== undefined &&
        currentFactoryMergeOperation(
          yield* store.snapshot.pipe(Effect.mapError(unavailable)),
          member.assignment.integrationId,
        ) &&
        !mergeOperationTool &&
        !isTool(toolName, "factory_snapshot")
      )
        return yield* denied();
      if (member.manager.role === "system" && member.assignment === undefined) {
        if (
          threadId !== member.manager.threadId ||
          !isTool(
            toolName,
            "factory_improvement_snapshot",
            "factory_improvement_record",
            "factory_investigation_read",
            "factory_dispatch",
            "factory_snapshot",
            "factory_collaboration_directory",
            "t3_thread_read",
            "t3_thread_send",
            "t3_thread_wait",
            "t3_thread_interrupt",
          )
        )
          return yield* denied();
        const profile = yield* execution
          .runtimePolicyFor(member.ownerThreadId)
          .pipe(Effect.mapError(unavailable));
        if (!profile) return yield* unavailable();
        if (
          isTool(
            toolName,
            "factory_improvement_snapshot",
            "factory_improvement_record",
            "factory_investigation_read",
            "factory_dispatch",
            "factory_snapshot",
            "factory_collaboration_directory",
          )
        )
          return;
      }
      const implementationTeamTool =
        member.auxiliary === undefined &&
        member.assignment !== undefined &&
        member.assignment.kind !== "onboarding" &&
        isTool(
          toolName,
          "orchestrator_capabilities",
          "delegate_task",
          "task_status",
          "task_cancel",
        );
      let scopedCommunication = false;
      if (
        isTool(
          toolName,
          "t3_thread_read",
          "t3_thread_send",
          "t3_thread_wait",
          "t3_thread_interrupt",
        ) &&
        hasThreadTarget(payload)
      ) {
        const target = yield* membership(payload.threadId);
        const targetControls = yield* controls
          .membership(payload.threadId)
          .pipe(Effect.mapError(unavailable));
        const sameManager = target?.manager.id === member.manager.id;
        const sameAssignment =
          member.assignment !== undefined && target?.assignment?.id === member.assignment.id;
        const ownManager =
          target?.assignment === undefined && target?.manager.id === member.manager.id;
        scopedCommunication =
          (member.auxiliary === undefined || isTool(toolName, "t3_thread_read")) &&
          sameManager &&
          (member.auxiliary?.kind !== "retrospective" || sameAssignment) &&
          (member.assignment === undefined ||
            sameAssignment ||
            (ownManager && !isTool(toolName, "t3_thread_interrupt")));
        if (
          scopedCommunication &&
          isTool(toolName, "t3_thread_send") &&
          target?.assignment?.wait != null &&
          (member.assignment === undefined || targetControls?.ancestorThreadIds.includes(threadId))
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "Parent direction is held while this assignment waits. Resolve its recorded prerequisite through the scoped factory workflow before continuing work.",
          });
        if (scopedCommunication && isTool(toolName, "t3_thread_send", "t3_thread_interrupt"))
          yield* controls
            .assertDirection({
              threadId: payload.threadId,
              senderThreadId: threadId,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorMcpFailure({
                    code: "capability_denied",
                    message: cause.message,
                  }),
              ),
            );
      }
      if (
        !isTool(toolName, "factory_snapshot") &&
        !(
          isTool(toolName, "factory_collaboration_directory") &&
          member.assignment === undefined &&
          threadId === member.manager.threadId
        ) &&
        !isTool(toolName, "factory_ticket_read") &&
        !isTool(toolName, "factory_dispatch") &&
        !(
          integrationLead &&
          isTool(
            toolName,
            "factory_merge_group_get",
            "factory_merge_group_review",
            "factory_merge_group_start",
            "factory_merge_operation_action",
          )
        ) &&
        !isTool(
          toolName,
          "factory_integration_get",
          "factory_integration_command",
          "factory_integration_read_patch",
        ) &&
        !(
          member.auxiliary?.kind === "delivery-review" &&
          isTool(
            toolName,
            "factory_preview_action",
            "factory_preview_snapshot",
            "factory_preview_finish",
          )
        ) &&
        !implementationTeamTool &&
        !scopedCommunication
      )
        return yield* denied();
      if (integrationLead && mergeOperationTool) return;
      if (
        isTool(toolName, "factory_integration_get", "factory_integration_read_patch") &&
        member.auxiliary === undefined &&
        member.manager.role === "project"
      )
        return;
      if (
        isTool(toolName, "factory_dispatch", "factory_integration_command") &&
        isIntegrationRefresh(payload) &&
        member.auxiliary === undefined &&
        member.assignment?.integrationId === payload.command.integrationId &&
        threadId === member.assignment.threadId
      )
        return;
      const profile = yield* execution
        .runtimePolicyFor(member.ownerThreadId)
        .pipe(Effect.mapError(unavailable));
      if (profile === undefined) return yield* unavailable();
    });

  return McpToolAccess.CallerPolicy.of({
    grant: (invocation) => {
      const threadId = invocation.thread?.threadId;
      if (threadId === undefined) return Effect.succeed(McpToolAccess.ordinaryGrant);
      return membership(threadId).pipe(
        Effect.match({
          // A thread whose factory record cannot be verified runs nothing.
          onFailure: (error): McpToolAccess.CallerGrant => ({
            grantedTools: true,
            authorize: () => Effect.fail(error),
          }),
          onSuccess: (member): McpToolAccess.CallerGrant =>
            member === undefined
              ? McpToolAccess.ordinaryGrant
              : {
                  grantedTools: true,
                  authorize: (toolName, payload) => authorize(threadId, member, toolName, payload),
                },
        }),
      );
    },
  });
});

export const layer = Layer.effect(McpToolAccess.CallerPolicy, make).pipe(
  Layer.provide(FactoryControlAccess.layer),
);
