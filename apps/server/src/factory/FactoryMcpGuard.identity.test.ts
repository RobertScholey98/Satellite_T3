import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactoryAssignmentId,
  FactoryControlId,
  FactoryDependencyId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type FactorySnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryMcpGuard from "./FactoryMcpGuard.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { decide, initialFactorySnapshot } from "./FactoryState.ts";

const managerId = ThreadId.make("manager");
const leadId = ThreadId.make("lead");
const workerId = ThreadId.make("worker");
const diagnosisId = ThreadId.make("diagnosis");
const projectId = ProjectId.make("project");
const assignmentId = FactoryAssignmentId.make("assignment");
const commandId = CommandId.make("command");
const now = "2026-10-10T12:00:00.000Z";
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "approved" };
const created = Result.getOrThrow(
  decide({
    state: initialFactorySnapshot(),
    actor: { kind: "human" },
    now,
    command: {
      type: "manager.create",
      commandId,
      projectId,
      modelSelection: selection,
      workflow: { repositoryRoot: "/owned", revision: "pinned" },
    },
    allocation: { managerThreadId: managerId, leadThreadId: leadId, assignmentId },
    qualification: { status: "qualified", profileId: "profile", checkedAt: now },
  }),
).state;
const state: FactorySnapshot = {
  ...created,
  assignments: created.assignments.map((entry) => ({
    ...entry,
    kind: "implementation",
    modelSelection: selection,
    modelPolicy: { approvedModels: [selection], preferences: [] },
    oversight: {
      recovery: {
        cyclesUsed: 1,
        history: [],
        incident: {
          id: "incident",
          phase: "diagnosing",
          diagnosisThreadId: diagnosisId,
          reason: "Investigate the stopped team",
          evidence: [],
        },
      },
    },
  })),
  auxiliaryThreads: [
    {
      threadId: diagnosisId,
      assignmentId,
      managerId,
      projectId,
      kind: "diagnosis",
      incidentId: "incident",
      cycle: 1,
      status: "running",
      modelSelection: selection,
      qualification: { status: "qualified", profileId: "inspection", checkedAt: now },
      sourceDigest: "bytes",
      createdAt: now,
      updatedAt: now,
    },
  ],
};
const invocation = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  requestNamespace: `identity:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session:${threadId}`,
    providerInstanceId: selection.instanceId,
  },
  client: undefined,
});
const scenario = <A, E>(
  snapshot: FactorySnapshot,
  test: (
    guard: FactoryMcpGuard.FactoryMcpGuard["Service"],
    dispatches: string[],
  ) => Effect.Effect<A, E>,
) => {
  const dispatches: string[] = [];
  const shells = new Map(
    [managerId, leadId, diagnosisId, workerId].map((id) => [
      id,
      {
        ...liveThreadShell(id),
        projectId,
        ...(id === workerId
          ? {
              lineage: {
                rootThreadId: leadId,
                parentThreadId: leadId,
                relationshipToParent: "subagent" as const,
              },
            }
          : {}),
      },
    ]),
  );
  const getThreadShell = (id: ThreadId) => Effect.succeed(shells.get(id) ?? null);
  return FactoryMcpGuard.FactoryMcpGuard.pipe(
    Effect.flatMap((guard) => test(guard, dispatches)),
    Effect.provide(
      FactoryMcpGuard.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(FactoryStore.FactoryStore)({ snapshot: Effect.succeed(snapshot) }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThreadShell }),
            Layer.mock(ThreadManagement.ThreadManagementService)({ getThreadShell }),
            Layer.mock(FactoryExecution.FactoryExecution)({
              runtimePolicyFor: () =>
                Effect.succeed({
                  boundaryId: "inspection",
                  dockerContext: "test",
                  imageId: "image",
                  projectSnapshotPath: "/readonly-project",
                  workflowSnapshotPath: "/readonly-workflow",
                  runtimePath: "/runtime",
                  inspection: { sourceDigest: "bytes", evidencePath: "/evidence" },
                }),
            }),
            Layer.mock(FactoryService.FactoryService)({
              snapshot: () => Effect.succeed(snapshot),
              dispatch: (_, command) =>
                Effect.sync(() => {
                  dispatches.push(command.type);
                  return { revision: 1 };
                }),
            }),
          ),
        ),
      ),
    ),
  );
};

it.effect(
  "diagnosis can read assigned evidence and submit its own report but cannot run implementation tools",
  () =>
    scenario(state, (guard, dispatches) =>
      Effect.gen(function* () {
        const caller = invocation(diagnosisId);
        yield* guard.authorize(caller, "factory_snapshot");
        yield* guard.authorize(caller, "t3_thread_read", { threadId: leadId });
        yield* guard.authorize(caller, "t3_thread_read", { threadId: workerId });
        for (const tool of [
          "delegate_task",
          "task_cancel",
          "task_status",
          "t3_thread_send",
          "t3_thread_interrupt",
          "t3_thread_wait",
          "host_effect",
        ]) {
          assert.equal(
            (yield* guard.authorize(caller, tool, { threadId: leadId }).pipe(Effect.flip)).code,
            "capability_denied",
          );
        }
        for (const command of [
          { type: "assignment.verify", commandId, assignmentId, expectedEpoch: 0 } as const,
          {
            type: "assignment.file.mutate",
            commandId,
            assignmentId,
            expectedEpoch: 0,
            operation: { kind: "write", path: "src/app.ts", content: "change" },
          } as const,
          {
            type: "assignment.progress",
            commandId,
            assignmentId,
            summary: "Pretend to be the lead",
            remainingWork: "None",
            evidence: [],
          } as const,
          {
            type: "auxiliary.report",
            commandId,
            threadId: leadId,
            summary: "Wrong identity",
            evidence: [],
          } as const,
        ])
          assert.equal(
            (yield* guard.dispatch(caller, command).pipe(Effect.flip))._tag,
            "OrchestratorMcpFailure",
          );
        assert.deepStrictEqual(dispatches, []);
        yield* guard.dispatch(caller, {
          type: "auxiliary.report",
          commandId,
          threadId: diagnosisId,
          summary: "Scoped diagnosis",
          evidence: [{ label: "finding", location: "/evidence/assignment.json" }],
        });
        assert.deepStrictEqual(dispatches, ["auxiliary.report"]);
      }),
    ),
);

it.effect("retired leads and their descendants cannot escape through direct MCP dispatch", () => {
  const replaced = {
    ...state,
    assignments: state.assignments.map((entry) => ({
      ...entry,
      threadId: ThreadId.make("replacement"),
      previousLeadThreadIds: [leadId],
    })),
  };
  return scenario(replaced, (guard, dispatches) =>
    Effect.gen(function* () {
      for (const id of [leadId, workerId]) {
        const caller = invocation(id);
        assert.equal(
          (yield* guard.authorize(caller, "host_effect").pipe(Effect.flip)).code,
          "capability_denied",
        );
        assert.equal(
          (yield* guard.authorize(caller, "factory_dispatch").pipe(Effect.flip)).code,
          "capability_denied",
        );
        assert.equal(
          (yield* guard
            .dispatch(caller, {
              type: "assignment.file.mutate",
              commandId,
              assignmentId,
              expectedEpoch: 0,
              operation: { kind: "write", path: "src/app.ts", content: "change" },
            })
            .pipe(Effect.flip))._tag,
          "OrchestratorMcpFailure",
        );
      }
      assert.deepStrictEqual(dispatches, []);
    }),
  );
});

it.effect(
  "assignment snapshots exclude sibling guidance and controls without hiding shared pauses",
  () => {
    const siblingId = FactoryAssignmentId.make("sibling-assignment");
    const siblingLead = ThreadId.make("sibling-lead");
    const retroId = ThreadId.make("retro");
    const controlFields = {
      generation: 1,
      requestedAt: now,
      updatedAt: now,
    };
    const pauseFields = {
      ...controlFields,
      status: "released" as const,
      stop: { status: "confirmed" as const, stoppedAt: now },
      resumeThreadIds: [leadId, siblingLead],
      resumeQueues: [{ threadId: siblingLead, runIds: [RunId.make("sibling-run")] }],
    };
    const dependency = {
      description: "Supporting work",
      unblockCondition: { kind: "pull-request-merged" as const, projectId },
      requestedBy: managerId,
      evidence: [],
      state: "requested" as const,
      createdAt: now,
      updatedAt: now,
    };
    const snapshot: FactorySnapshot = {
      ...state,
      assignments: [
        ...state.assignments,
        { ...state.assignments[0]!, id: siblingId, threadId: siblingLead },
      ],
      auxiliaryThreads: [
        ...state.auxiliaryThreads,
        {
          ...state.auxiliaryThreads[0]!,
          threadId: retroId,
          kind: "retrospective",
          incidentId: "retro",
        },
      ],
      guidance: [
        {
          assignmentId,
          threadId: workerId,
          messageId: MessageId.make("own-message"),
          observedAt: now,
        },
        {
          assignmentId: siblingId,
          threadId: siblingLead,
          messageId: MessageId.make("sibling-message"),
          observedAt: now,
        },
      ],
      controls: [
        ...[assignmentId, siblingId].flatMap((id) => [
          {
            ...controlFields,
            kind: "cancellation" as const,
            id: FactoryControlId.make(`cancel:${id}`),
            assignmentId: id,
            managerId,
            stop: { status: "confirmed" as const, stoppedAt: now },
          },
          {
            ...controlFields,
            kind: "takeover" as const,
            id: FactoryControlId.make(`takeover:${id}`),
            assignmentId: id,
            managerId,
            threadId: id === assignmentId ? workerId : siblingLead,
            parentThreadId: managerId,
            status: "released" as const,
          },
        ]),
        {
          ...pauseFields,
          kind: "manager-pause",
          id: FactoryControlId.make("manager-pause"),
          managerId,
          priorStatus: "active",
        },
        {
          ...pauseFields,
          kind: "manager-pause",
          id: FactoryControlId.make("other-manager-pause"),
          managerId: ThreadId.make("other-manager"),
          priorStatus: "active",
        },
        {
          ...pauseFields,
          kind: "project-pause",
          id: FactoryControlId.make("project-pause"),
          projectId,
        },
      ],
      dependencies: [
        {
          ...dependency,
          id: FactoryDependencyId.make("requested"),
          assignmentId,
          supportingAssignmentId: siblingId,
        },
        {
          ...dependency,
          id: FactoryDependencyId.make("supporting"),
          assignmentId: siblingId,
          supportingAssignmentId: assignmentId,
        },
        { ...dependency, id: FactoryDependencyId.make("unrelated"), assignmentId: siblingId },
      ],
    };
    return scenario(snapshot, (guard) =>
      Effect.gen(function* () {
        for (const caller of [leadId, workerId, diagnosisId, retroId]) {
          const visible = yield* guard.snapshot(invocation(caller));
          assert.deepStrictEqual(
            visible.guidance.map((entry) => entry.messageId),
            ["own-message"],
          );
          assert.deepStrictEqual(
            visible.controls.map((entry) => entry.id),
            [
              `cancel:${assignmentId}`,
              `takeover:${assignmentId}`,
              "manager-pause",
              "project-pause",
            ],
          );
          for (const control of visible.controls) {
            assert.notProperty(control, "resumeThreadIds");
            assert.notProperty(control, "resumeQueues");
          }
          assert.deepStrictEqual(
            visible.assignments.map((entry) => entry.id),
            [assignmentId],
          );
          assert.deepStrictEqual(
            visible.dependencies.map((entry) => entry.id),
            ["requested", "supporting"],
          );
        }
        const managed = yield* guard.snapshot(invocation(managerId));
        assert.deepStrictEqual(managed.guidance, snapshot.guidance);
        assert.deepStrictEqual(managed.controls, snapshot.controls);
        assert.deepStrictEqual(managed.dependencies, snapshot.dependencies);
        assert.deepStrictEqual(managed.assignments, snapshot.assignments);
      }),
    );
  },
);
