import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type FactoryAssignment,
  type FactoryClaimCompleteInput,
  type FactoryCommissionInput,
  type FactoryCompleteInput,
  type FactoryCreateTeamFromDefinitionsInput,
  type FactoryTeamDefinition,
  type FactoryDelegateInput,
  type FactoryDefinitionsView,
  type FactoryDelegationPlan,
  type FactoryDependency,
  type FactoryDraftTicketInput,
  type FactoryDraftTicketResult,
  type FactoryFinding,
  type FactoryManager,
  FactoryOperationError,
  type FactoryOnboardingDetected,
  type FactoryOnboardingProposalInput,
  type FactoryPickupInput,
  type FactoryReadyTicket,
  type FactoryRecordFindingInput,
  type FactoryRecoverInput,
  type FactoryReportDependencyInput,
  type FactoryRole,
  type FactoryStatus,
  type FactoryUpdateChecklistInput,
  NodeId,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Tool from "effect/ai/Tool";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import { FactoryConfigStore } from "../config/FactoryConfigStore.ts";
import { FactoryService } from "../FactoryService.ts";
import * as FactoryMcp from "./handlers.ts";
import { FactoryToolkit } from "./tools.ts";

const MANAGER_THREAD = ThreadId.make("thread-manager");
const OTHER_THREAD = ThreadId.make("thread-other");
const ONBOARDED_THREAD = ThreadId.make("thread-onboarded");
const ONBOARDING_FINISHED =
  "This thread's onboarding is finished; the manager now runs in a new thread.";
const LEAD_THREAD = ThreadId.make("thread-lead");
const CHILD_THREAD = ThreadId.make("thread-child");
const WORKER_THREAD = ThreadId.make("thread-worker");

const report: FactoryOnboardingProposalInput = {
  summary: "Turbo monorepo; CI gates on lint and tests.",
  purpose: "A desktop workspace for coding agents.",
  pickup: { enabled: false, guidance: "" },
  rules: [
    {
      id: "docs-review",
      question: "Should docs-only tickets skip review?",
      options: ["Skip review", "Review like code"],
      recommended: 1,
      reason: "Docs mislead agents too.",
    },
  ],
  controlPaths: [{ path: ".github/**", reason: "CI decides what merges." }],
  findings: ["No column for blocked tickets."],
};

const detected: FactoryOnboardingDetected = {
  boards: [
    {
      boardId: "board-1",
      title: "Roadmap",
      readyColumns: [{ id: "ready", title: "Ready" }],
      labels: ["bug"],
    },
  ],
  defaultBranch: "main",
  detectedAt: "2026-10-20T00:00:00.000Z",
};

const manager: FactoryManager = {
  id: "manager-1",
  projectId: ProjectId.make("project-1"),
  name: "Ada",
  state: "onboarding",
  threadId: MANAGER_THREAD,
  onboardingProposal: null,
  onboardingResult: null,
  onboardingThreadId: null,
  primingMessageId: null,
  modelSelection: null,
  activeAssignments: 0,
  waitingOnYou: 0,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
};

const assignment: FactoryAssignment = {
  id: "assignment-1",
  managerId: "manager-1",
  projectId: manager.projectId,
  title: "Fix the flaky login test",
  brief: "Find why login.test.ts flakes and fix it.",
  completionCondition: "login.test.ts passes 20 runs in a row.",
  source: "ticket",
  issue: null,
  attemptId: "attempt-1",
  leadThreadId: LEAD_THREAD,
  complexity: "small",
  state: "active",
  team: { preset: "Default", members: [] },
  recoveryUsed: 0,
  waitingReason: null,
  cancelReason: null,
  claim: null,
  takenOver: false,
  dependencies: [],
  teamVerdict: null,
  checklist: [],
  digest: null,
  controlViolations: [],
  retro: { teamDoneAt: null, managerDoneAt: null },
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  endedAt: null,
};

const readyTicket = (number: number, judged: boolean): FactoryReadyTicket => ({
  issue: {
    ref: {
      hostKind: SourceControlProviderKind.make("github"),
      host: "github.com",
      repository: "acme/app",
      id: `issue-${number}`,
      number,
      url: `https://github.com/acme/app/issues/${number}`,
    },
    title: `Ticket ${number}`,
    state: "open",
    updatedAt: "2026-10-21T00:00:00.000Z",
    labels: [],
  },
  boardId: "board-1",
  columnId: "ready",
  version: null,
  judged,
});

const status: FactoryStatus = {
  manager: { ...manager, state: "active" },
  concurrencyCap: 3,
  activeCount: 1,
  capacityFree: true,
  assignments: [assignment],
  readyTickets: [readyTicket(4, true), readyTicket(5, false), readyTicket(6, false)],
  pickupEnabled: true,
  pickupGuidance: "Pick up small bug fixes.",
};

const pickupInput: FactoryPickupInput = {
  issueNumber: 5,
  decision: "start",
  complexity: "small",
  reason: "A contained bug fix.",
  brief: assignment.brief,
  completionCondition: assignment.completionCondition,
};

const commissionInput: FactoryCommissionInput = {
  title: assignment.title,
  brief: assignment.brief,
  completionCondition: assignment.completionCondition,
  complexity: "large",
  issueNumber: 5,
};

const claimInput: FactoryClaimCompleteInput = {
  evidence: "login.test.ts passed 20 runs in a row.",
  pullRequests: [{ host: "github.com", repository: "acme/app", number: 12 }],
};

const dependencyInput: FactoryReportDependencyInput = {
  title: "Stable test clock",
  brief: "Give the login test a controllable clock.",
  unblockCondition: "The test harness exposes a fake clock",
};

const dependency: FactoryDependency = {
  id: "dependency-1",
  blockedAssignmentId: assignment.id,
  deliveringAssignmentId: null,
  title: dependencyInput.title,
  unblockCondition: dependencyInput.unblockCondition,
  state: "open",
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
};

const recoverInput: FactoryRecoverInput = {
  assignmentId: assignment.id,
  action: "replace",
  brief: "Quarantine the flaky fixture first.",
};

const completeInput: FactoryCompleteInput = {
  assignmentId: assignment.id,
  teamVerdict: { fit: "good", reason: "One implementer was enough." },
};

const reviewerModel = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-4-6" };

const delegateInput: FactoryDelegateInput = {
  role: "reviewer",
  task: "Review the fix for the flaky login test.",
};

const plan: FactoryDelegationPlan = {
  role: "reviewer",
  title: "Reviewer: Fix the flaky login test",
  task: "# Reviewer skill\n\n# Task\n\nReview the fix for the flaky login test.",
  modelSelection: reviewerModel,
  allowedModels: [reviewerModel],
};

const delegated: OrchestratorMcpDelegateTaskResult = {
  taskId: NodeId.make("task-1"),
  childThreadId: CHILD_THREAD,
  childRunId: null,
  childNodeId: NodeId.make("node-child"),
  status: "queued",
  workState: "working",
  hasPendingChildRuns: false,
  latestTerminalRunId: null,
  latestTerminalStatus: null,
  latestTerminalSummary: null,
  latestTerminalResultContextTransferId: null,
  providerInstanceId: reviewerModel.instanceId,
  model: reviewerModel.model,
  summary: null,
  resultContextTransferId: null,
  hasPendingQuestion: false,
  pendingApproval: null,
  waitTimedOut: false,
};

const checklistInput: FactoryUpdateChecklistInput = {
  steps: [
    { text: "Reproduce the flake", state: "done" },
    { text: "Fix the clock", state: "in-progress" },
  ],
};

const teamInput: FactoryCreateTeamFromDefinitionsInput = {
  name: "Pair",
  useWhen: "Small fixes that need a second pair of eyes.",
  members: [{ workerId: "implementer", count: 1 }],
  workflow: "Implement, then review.",
};

/** A manager whose onboarding result names the teams it may staff. */
const LIMITED_MANAGER_THREAD = ThreadId.make("thread-limited-manager");
const limitedManager: FactoryManager = {
  ...manager,
  id: "manager-2",
  threadId: LIMITED_MANAGER_THREAD,
  state: "active",
  onboardingResult: {
    purpose: "",
    pickup: { enabled: false, columns: [], labels: [], guidance: "" },
    baseBranch: null,
    rules: [],
    controlPaths: [],
    teamIds: ["standard"],
    concurrencyCap: 2,
  },
};

const createdTeam: FactoryTeamDefinition = {
  id: "pair",
  name: "Pair",
  useWhen: teamInput.useWhen,
  workflow: teamInput.workflow,
  mayEditProtectedPaths: false,
  createdBy: "manager",
  lead: {
    id: "default",
    name: "Default lead",
    models: { dynamic: true, models: [] },
    instructions: "",
  },
  members: [
    {
      id: "implementer",
      name: "Implementer",
      models: { dynamic: true, models: [] },
      description: "Implement it.",
      count: 1,
    },
  ],
};

const findingInput: FactoryRecordFindingInput = {
  class: "reusable",
  summary: "The login fixture is copied in three suites",
  evidence: "a.test.ts, b.test.ts and c.test.ts each build it.",
};

const finding: FactoryFinding = {
  ...findingInput,
  id: "finding-1",
  assignmentId: assignment.id,
  threadId: WORKER_THREAD,
  uncertainty: null,
  workaround: null,
  escalated: false,
  draftId: null,
  createdAt: "2026-10-21T00:00:00.000Z",
};

const draftInput: FactoryDraftTicketInput = {
  scope: "project",
  title: "Share the login fixture",
  body: "Three suites build the same login fixture.",
  acceptanceCriteria: ["One shared fixture"],
  findingIds: [finding.id],
};

const drafted: FactoryDraftTicketResult = {
  draft: {
    id: "draft-1",
    managerId: manager.id,
    projectId: manager.projectId,
    assignmentId: assignment.id,
    scope: "project",
    title: draftInput.title,
    body: draftInput.body,
    acceptanceCriteria: draftInput.acceptanceCriteria,
    findingIds: [finding.id],
    state: "pending",
    issue: null,
    proposedChange: null,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  },
  similar: [{ kind: "ticket", id: "issue-9", title: "Share test fixtures", url: null }],
};

const definitions: FactoryDefinitionsView = {
  configured: true,
  settings: { version: 1, modelPool: [], recoveryAllowance: 1 },
  workers: [
    {
      id: "reviewer",
      name: "reviewer",
      models: { dynamic: true, models: [] },
      description: "Review the diff.",
    },
  ],
  leads: [],
  managers: [],
  teams: [],
  problems: [{ path: "teams/broken/team.md", message: "Missing name." }],
};

type LifecycleCall =
  | { readonly method: "claimComplete"; readonly threadId: ThreadId; readonly input: unknown }
  | { readonly method: "reportDependency"; readonly threadId: ThreadId; readonly input: unknown }
  | { readonly method: "recover"; readonly threadId: ThreadId; readonly input: unknown }
  | { readonly method: "complete"; readonly threadId: ThreadId; readonly input: unknown }
  | { readonly method: "planDelegation"; readonly threadId: ThreadId; readonly input: unknown }
  | { readonly method: "delegateTask"; readonly threadId: ThreadId; readonly input: unknown }
  | { readonly method: "recordMember"; readonly threadId: ThreadId; readonly input: unknown }
  | { readonly method: "updateChecklist"; readonly threadId: ThreadId; readonly input: unknown }
  | { readonly method: "createTeam"; readonly threadId: ThreadId; readonly input: unknown }
  | { readonly method: "recordFinding"; readonly threadId: ThreadId; readonly input: unknown }
  | { readonly method: "listFindings"; readonly input: unknown }
  | { readonly method: "retroDone"; readonly threadId: ThreadId }
  | { readonly method: "draftTicket"; readonly threadId: ThreadId; readonly input: unknown };

const invocation = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = Effect.gen(function* () {
  const proposals = yield* Ref.make<ReadonlyArray<FactoryOnboardingProposalInput>>([]);
  const briefRequests = yield* Ref.make<
    ReadonlyArray<{ projectId: ProjectId; role: FactoryRole; managerId: string }>
  >([]);
  const statusRequests = yield* Ref.make<ReadonlyArray<string>>([]);
  const statusValue = yield* Ref.make<FactoryStatus>(status);
  const pickups = yield* Ref.make<ReadonlyArray<{ threadId: ThreadId; input: FactoryPickupInput }>>(
    [],
  );
  const commissions = yield* Ref.make<
    ReadonlyArray<{ threadId: ThreadId; input: FactoryCommissionInput }>
  >([]);
  const pickupConflict = yield* Ref.make(false);
  const delegationConflict = yield* Ref.make(false);
  /** What planning a delegation returns; a role plan unless a test plans a team member. */
  const delegationPlan = yield* Ref.make<FactoryDelegationPlan>(plan);
  const lifecycle = yield* Ref.make<ReadonlyArray<LifecycleCall>>([]);
  const recordLifecycle = (call: LifecycleCall) =>
    Ref.update(lifecycle, (recorded) => [...recorded, call]);
  const dependencies = Layer.mergeAll(
    Layer.mock(FactoryService)({
      managerForThread: (threadId) =>
        Effect.succeed(
          threadId === MANAGER_THREAD
            ? manager
            : threadId === LIMITED_MANAGER_THREAD
              ? limitedManager
              : null,
        ),
      finishedOnboardingMessage: (threadId) =>
        Effect.succeed(threadId === ONBOARDED_THREAD ? ONBOARDING_FINISHED : null),
      proposeOnboarding: (_threadId, proposed) =>
        Ref.update(proposals, (recorded) => [...recorded, proposed]).pipe(
          Effect.as({
            ...manager,
            onboardingProposal: { ...proposed, detected, proposedAt: detected.detectedAt },
          }),
        ),
      roleBrief: (projectId, role, managerId) =>
        Ref.update(briefRequests, (recorded) => [...recorded, { projectId, role, managerId }]).pipe(
          Effect.as({ role, text: `# ${role} brief`, source: "definition" as const }),
        ),
      status: (managerId) =>
        Ref.update(statusRequests, (recorded) => [...recorded, managerId]).pipe(
          Effect.andThen(Ref.get(statusValue)),
        ),
      pickup: (threadId, input) =>
        Effect.gen(function* () {
          if (yield* Ref.get(pickupConflict))
            return yield* new FactoryOperationError({
              reason: "conflict",
              message: "Every slot under the concurrency cap is taken.",
            });
          yield* Ref.update(pickups, (recorded) => [...recorded, { threadId, input }]);
          return input.decision === "skip" ? null : assignment;
        }),
      commission: (threadId, input) =>
        Ref.update(commissions, (recorded) => [...recorded, { threadId, input }]).pipe(
          Effect.as({ ...assignment, source: "user" as const, complexity: input.complexity }),
        ),
      assignmentForThread: (threadId) =>
        Effect.succeed(threadId === LEAD_THREAD || threadId === WORKER_THREAD ? assignment : null),
      listAssignments: (input) =>
        Effect.succeed(input.managerId === manager.id ? [assignment] : []),
      claimComplete: (threadId, input) =>
        recordLifecycle({ method: "claimComplete", threadId, input }).pipe(
          Effect.as({
            ...assignment,
            state: "waiting-user" as const,
            waitingReason: "Pull requests await the user's review: #12.",
          }),
        ),
      reportDependency: (threadId, input) =>
        recordLifecycle({ method: "reportDependency", threadId, input }).pipe(
          Effect.as(dependency),
        ),
      recover: (threadId, input) =>
        recordLifecycle({ method: "recover", threadId, input }).pipe(
          Effect.as({ ...assignment, recoveryUsed: 1 }),
        ),
      complete: (threadId, input) =>
        recordLifecycle({ method: "complete", threadId, input }).pipe(
          Effect.as({ ...assignment, state: "completed" as const }),
        ),
      planDelegation: (threadId, input) =>
        Effect.gen(function* () {
          if (yield* Ref.get(delegationConflict))
            return yield* new FactoryOperationError({
              reason: "conflict",
              message: "The team allows 1 reviewer and all are busy.",
            });
          yield* recordLifecycle({ method: "planDelegation", threadId, input });
          return yield* Ref.get(delegationPlan);
        }),
      recordMember: (threadId, input) =>
        recordLifecycle({ method: "recordMember", threadId, input }).pipe(
          Effect.as({
            threadId: input.threadId,
            managerId: manager.id,
            assignmentId: assignment.id,
            role: input.role,
            parentThreadId: threadId,
            joined: input.joined,
            takenOver: false,
            offPool: false,
            endedAt: null,
          }),
        ),
      updateChecklist: (threadId, input) =>
        recordLifecycle({ method: "updateChecklist", threadId, input }).pipe(
          Effect.as({ ...assignment, checklist: input.steps }),
        ),
      createTeam: (threadId, input) =>
        recordLifecycle({ method: "createTeam", threadId, input }).pipe(Effect.as(createdTeam)),
      recordFinding: (threadId, input) =>
        recordLifecycle({ method: "recordFinding", threadId, input }).pipe(
          Effect.as({ ...finding, threadId }),
        ),
      listFindings: (input) =>
        recordLifecycle({ method: "listFindings", input }).pipe(Effect.as([finding])),
      retroDone: (threadId) =>
        recordLifecycle({ method: "retroDone", threadId }).pipe(
          Effect.as({
            ...assignment,
            state: "retro" as const,
            retro: { teamDoneAt: "2026-10-21T00:00:00.000Z", managerDoneAt: null },
          }),
        ),
      draftTicket: (threadId, input) =>
        recordLifecycle({ method: "draftTicket", threadId, input }).pipe(Effect.as(drafted)),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      delegateTask: (scope, input: OrchestratorMcpDelegateTaskInput) =>
        recordLifecycle({
          method: "delegateTask",
          threadId: scope.thread!.threadId,
          input,
        }).pipe(Effect.as(delegated)),
    }),
    Layer.mock(FactoryConfigStore)({ directory: "factory", read: Effect.succeed(definitions) }),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* FactoryToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(FactoryMcp.layer).pipe(Layer.provide(dependencies)),
    ),
  );
  const call = <Name extends keyof typeof FactoryToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    threadId: ThreadId = MANAGER_THREAD,
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof FactoryToolkit.tools)[Name]>,
      ),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(threadId, capabilities),
      ),
      Effect.provide(dependencies),
    );
  return {
    proposals,
    briefRequests,
    statusRequests,
    statusValue,
    pickups,
    commissions,
    pickupConflict,
    delegationConflict,
    delegationPlan,
    lifecycle,
    call,
  };
});

describe("factory_propose_onboarding", () => {
  it.effect("refuses a thread that is not a manager without storing anything", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_propose_onboarding", report, OTHER_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(failure, {
        _tag: "FactoryToolFailedError",
        reason: "not-found",
        message: "This thread is not an engineering manager.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.proposals), []);
    }),
  );

  it.effect("forwards the manager's proposal and returns what Satellite detected", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_propose_onboarding", report);
      assert.deepStrictEqual(yield* Ref.get(harness.proposals), [report]);
      assert.deepStrictEqual(result, {
        managerId: "manager-1",
        managerName: "Ada",
        state: "onboarding",
        detected,
        message:
          "The proposal is with the user. Tell them in this thread that it is ready for review in Satellite.",
      });
    }),
  );

  it.effect("refuses a credential without the orchestration capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_propose_onboarding", report, MANAGER_THREAD, ["preview"])
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "McpCapabilityUnavailableError");
      assert.deepStrictEqual(yield* Ref.get(harness.proposals), []);
    }),
  );
});

describe("factory_role_brief", () => {
  it.effect("reads the brief for the calling manager's project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_role_brief", { role: "reviewer" });
      assert.deepStrictEqual(yield* Ref.get(harness.briefRequests), [
        { projectId: manager.projectId, role: "reviewer", managerId: "manager-1" },
      ]);
      assert.deepStrictEqual(result, {
        role: "reviewer",
        text: "# reviewer brief",
        source: "definition",
        message: "The reviewer brief, from the factory config's definition.",
      });
    }),
  );

  it.effect("refuses a thread outside the factory", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_role_brief", { role: "lead" }, OTHER_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(failure, {
        _tag: "FactoryToolFailedError",
        reason: "not-found",
        message: "This thread is not part of the factory.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.briefRequests), []);
    }),
  );

  it.effect("refuses a credential without the orchestration capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_role_brief", { role: "lead" }, MANAGER_THREAD, ["preview"])
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "McpCapabilityUnavailableError");
    }),
  );
});

describe("factory_definitions", () => {
  it.effect("returns the factory config to a manager and to a lead", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const expected = {
        ...definitions,
        message: "0 teams and 1 worker. 1 file could not be read.",
      };
      assert.deepStrictEqual(yield* harness.call("factory_definitions", {}), expected);
      assert.deepStrictEqual(yield* harness.call("factory_definitions", {}, LEAD_THREAD), expected);
    }),
  );

  it.effect("refuses a worker", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_definitions", {}, WORKER_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(failure, {
        _tag: "FactoryToolFailedError",
        reason: "not-found",
        message: "This thread is not an engineering manager or a factory lead.",
      });
    }),
  );
});

describe("factory_status", () => {
  it.effect("refuses a thread that is not a manager", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness.call("factory_status", {}, OTHER_THREAD).pipe(Effect.flip);
      assert.deepInclude(failure, {
        _tag: "FactoryToolFailedError",
        reason: "not-found",
        message: "This thread is not an engineering manager.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.statusRequests), []);
    }),
  );

  it.effect("tells a finished onboarding thread where its manager went", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness.call("factory_status", {}, ONBOARDED_THREAD).pipe(Effect.flip);
      assert.deepInclude(failure, { reason: "not-found", message: ONBOARDING_FINISHED });
    }),
  );

  it.effect("returns the calling manager's status with a one-line summary", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_status", {});
      assert.deepStrictEqual(yield* Ref.get(harness.statusRequests), ["manager-1"]);
      assert.deepStrictEqual(result, {
        ...status,
        message: "1 of 3 slots in use, so capacity is free; 2 Ready tickets await judgement.",
      });
    }),
  );

  it.effect("says when the environment's cap, not the manager's, is the one that is full", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.statusValue, { ...status, capacityFree: false });
      const result = yield* harness.call("factory_status", {});
      assert.strictEqual(
        result.message,
        "1 of 3 slots in use, so no capacity is free: this environment's cap, shared by every project, is full; 2 Ready tickets await judgement.",
      );
    }),
  );
});

describe("factory_pickup", () => {
  it.effect("forwards the manager thread and judgement and returns the started assignment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_pickup", pickupInput);
      assert.deepStrictEqual(yield* Ref.get(harness.pickups), [
        { threadId: MANAGER_THREAD, input: pickupInput },
      ]);
      assert.deepStrictEqual(result, {
        decision: "start",
        assignment,
        message:
          'Started assignment assignment-1, "Fix the flaky login test". Its lead is launching.',
      });
    }),
  );

  it.effect("a skip returns no assignment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const skip: FactoryPickupInput = {
        issueNumber: 6,
        decision: "skip",
        complexity: "large",
        reason: "Too large to start without the user.",
      };
      const result = yield* harness.call("factory_pickup", skip);
      assert.deepStrictEqual(result, {
        decision: "skip",
        assignment: null,
        message: "Skipped ticket #6. It counts as judged until the ticket changes.",
      });
    }),
  );

  it.effect("surfaces the service's refusal with its reason", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.pickupConflict, true);
      const failure = yield* harness.call("factory_pickup", pickupInput).pipe(Effect.flip);
      assert.deepInclude(failure, {
        _tag: "FactoryToolFailedError",
        reason: "conflict",
        message: "Every slot under the concurrency cap is taken.",
      });
    }),
  );
});

describe("factory_commission", () => {
  it.effect("forwards the manager thread and request and returns the assignment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_commission", commissionInput);
      assert.deepStrictEqual(yield* Ref.get(harness.commissions), [
        { threadId: MANAGER_THREAD, input: commissionInput },
      ]);
      assert.deepStrictEqual(result, {
        assignment: { ...assignment, source: "user", complexity: "large" },
        message:
          'Started assignment assignment-1, "Fix the flaky login test". Its lead is launching.',
      });
    }),
  );
});

describe("factory_claim_complete", () => {
  it.effect("forwards the lead thread and claim", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_claim_complete", claimInput, LEAD_THREAD);
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), [
        { method: "claimComplete", threadId: LEAD_THREAD, input: claimInput },
      ]);
      assert.strictEqual(result.assignment.state, "waiting-user");
      assert.strictEqual(
        result.message,
        "Pull requests await the user's review: #12. The retro starts once they are merged; wait for that message.",
      );
    }),
  );

  it.effect("refuses a thread that does not lead an assignment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      for (const threadId of [OTHER_THREAD, MANAGER_THREAD]) {
        const failure = yield* harness
          .call("factory_claim_complete", claimInput, threadId)
          .pipe(Effect.flip);
        assert.deepInclude(failure, {
          _tag: "FactoryToolFailedError",
          reason: "not-found",
          message: "This thread is not a factory lead.",
        });
      }
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), []);
    }),
  );
});

describe("factory_report_dependency", () => {
  it.effect("forwards the lead thread and blocker and returns the blocked assignment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_report_dependency", dependencyInput, LEAD_THREAD);
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), [
        { method: "reportDependency", threadId: LEAD_THREAD, input: dependencyInput },
      ]);
      assert.deepStrictEqual(result.dependency, dependency);
      assert.deepStrictEqual(result.assignment, assignment);
    }),
  );

  it.effect("refuses a thread that does not lead an assignment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_report_dependency", dependencyInput, OTHER_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(failure, {
        reason: "not-found",
        message: "This thread is not a factory lead.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), []);
    }),
  );
});

describe("factory_recover", () => {
  it.effect("forwards the manager thread and diagnosis", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_recover", recoverInput);
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), [
        { method: "recover", threadId: MANAGER_THREAD, input: recoverInput },
      ]);
      assert.strictEqual(result.assignment.recoveryUsed, 1);
    }),
  );

  it.effect("refuses a lead calling a manager tool", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_recover", recoverInput, LEAD_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(failure, {
        reason: "not-found",
        message: "This thread is not an engineering manager.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), []);
    }),
  );
});

describe("factory_complete", () => {
  it.effect("forwards the manager thread and team verdict", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_complete", completeInput);
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), [
        { method: "complete", threadId: MANAGER_THREAD, input: completeInput },
      ]);
      assert.deepStrictEqual(result, {
        assignment: { ...assignment, state: "completed" },
        message: '"Fix the flaky login test" completed.',
      });
    }),
  );

  it.effect("refuses a lead calling a manager tool", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_complete", completeInput, LEAD_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(failure, {
        reason: "not-found",
        message: "This thread is not an engineering manager.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), []);
    }),
  );
});

describe("factory_delegate", () => {
  it.effect("plans, delegates with the mapped role and target, and records the member", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_delegate", delegateInput, LEAD_THREAD);
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), [
        { method: "planDelegation", threadId: LEAD_THREAD, input: delegateInput },
        {
          method: "delegateTask",
          threadId: LEAD_THREAD,
          input: {
            task: plan.task,
            title: plan.title,
            target: { providerInstanceId: reviewerModel.instanceId, model: reviewerModel.model },
            role: "review",
            isolation: "shared",
            mode: "async",
          },
        },
        {
          method: "recordMember",
          threadId: LEAD_THREAD,
          input: {
            threadId: CHILD_THREAD,
            role: "reviewer",
            modelSelection: reviewerModel,
            joined: "created",
          },
        },
      ]);
      assert.deepInclude(result, {
        taskId: delegated.taskId,
        childThreadId: CHILD_THREAD,
        role: "reviewer",
        model: reviewerModel,
      });
    }),
  );

  it.effect("records a team member under the name its plan gives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.delegationPlan, {
        ...plan,
        role: "worker",
        member: "Second opinion",
        title: "Second opinion: Fix the flaky login test",
      });
      const input: FactoryDelegateInput = {
        member: "second opinion",
        task: "Review the fix for the flaky login test.",
      };
      yield* harness.call("factory_delegate", input, LEAD_THREAD);
      const calls = yield* Ref.get(harness.lifecycle);
      assert.deepStrictEqual(
        calls.map((call) => call.method),
        ["planDelegation", "delegateTask", "recordMember"],
      );
      assert.deepStrictEqual(calls[2], {
        method: "recordMember",
        threadId: LEAD_THREAD,
        input: {
          threadId: CHILD_THREAD,
          role: "worker",
          memberName: "Second opinion",
          modelSelection: reviewerModel,
          joined: "created",
        },
      });
    }),
  );

  it.effect("surfaces a plan refusal without delegating", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.delegationConflict, true);
      const failure = yield* harness
        .call("factory_delegate", delegateInput, LEAD_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(failure, {
        _tag: "FactoryToolFailedError",
        reason: "conflict",
        message: "The team allows 1 reviewer and all are busy.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), []);
    }),
  );

  it.effect("refuses a thread that does not lead an assignment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_delegate", delegateInput, MANAGER_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(failure, {
        reason: "not-found",
        message: "This thread is not a factory lead.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), []);
    }),
  );
});

describe("factory_update_checklist", () => {
  it.effect("forwards the lead thread and steps and returns the stored checklist", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_update_checklist", checklistInput, LEAD_THREAD);
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), [
        { method: "updateChecklist", threadId: LEAD_THREAD, input: checklistInput },
      ]);
      assert.deepStrictEqual(result.checklist, checklistInput.steps);
    }),
  );
});

describe("factory_create_team", () => {
  it.effect("forwards the manager thread and the team, and returns the team with its id", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_create_team", teamInput);
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), [
        { method: "createTeam", threadId: MANAGER_THREAD, input: teamInput },
      ]);
      assert.deepStrictEqual(result, {
        team: createdTeam,
        message:
          'Added the team "Pair" with the id pair. Pass it as teamId when you pick up or commission work.',
      });
    }),
  );

  it.effect("warns a manager limited to other teams that it cannot staff the new one yet", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_create_team", teamInput, LIMITED_MANAGER_THREAD);
      assert.strictEqual(
        result.message,
        'Added the team "Pair" with the id pair, but you cannot staff it yet: your onboarding result limits you to other teams. Ask the user to add pair to your teams in Satellite.',
      );
    }),
  );
});

describe("factory_record_finding", () => {
  it.effect("forwards a worker's or the lead's own thread and the finding", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const fromWorker = yield* harness.call("factory_record_finding", findingInput, WORKER_THREAD);
      yield* harness.call(
        "factory_record_finding",
        { ...findingInput, escalate: true },
        LEAD_THREAD,
      );
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), [
        { method: "recordFinding", threadId: WORKER_THREAD, input: findingInput },
        {
          method: "recordFinding",
          threadId: LEAD_THREAD,
          input: { ...findingInput, escalate: true },
        },
      ]);
      assert.deepStrictEqual(fromWorker.finding, finding);
    }),
  );

  it.effect("refuses a thread on no team", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_record_finding", findingInput, OTHER_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(failure, {
        reason: "not-found",
        message: "This thread is not a member of a live factory team.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), []);
    }),
  );
});

describe("factory_findings", () => {
  it.effect("lets the manager and the assignment's lead read its findings", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const read = yield* harness.call("factory_findings", { assignmentId: assignment.id });
      yield* harness.call("factory_findings", { assignmentId: assignment.id }, LEAD_THREAD);
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), [
        { method: "listFindings", input: { assignmentId: assignment.id } },
        { method: "listFindings", input: { assignmentId: assignment.id } },
      ]);
      assert.deepStrictEqual(read.findings, [finding]);
    }),
  );

  it.effect("refuses another assignment, and a worker", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      for (const threadId of [MANAGER_THREAD, LEAD_THREAD]) {
        const failure = yield* harness
          .call("factory_findings", { assignmentId: "assignment-2" }, threadId)
          .pipe(Effect.flip);
        assert.deepInclude(failure, {
          reason: "not-found",
          message: "No assignment assignment-2 is yours to read.",
        });
      }
      const worker = yield* harness
        .call("factory_findings", { assignmentId: assignment.id }, WORKER_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(worker, {
        reason: "not-found",
        message: "This thread is not an engineering manager or a factory lead.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), []);
    }),
  );
});

describe("factory_retro_done", () => {
  it.effect("forwards the lead thread and refuses anyone else", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_retro_done", {}, LEAD_THREAD);
      assert.isNotNull(result.assignment.retro.teamDoneAt);
      const worker = yield* harness.call("factory_retro_done", {}, WORKER_THREAD).pipe(Effect.flip);
      assert.deepInclude(worker, {
        reason: "not-found",
        message: "This thread is not a factory lead.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), [
        { method: "retroDone", threadId: LEAD_THREAD },
      ]);
    }),
  );
});

describe("factory_draft_ticket", () => {
  it.effect("forwards the manager thread and draft and returns the similar tickets", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.call("factory_draft_ticket", draftInput);
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), [
        { method: "draftTicket", threadId: MANAGER_THREAD, input: draftInput },
      ]);
      assert.deepStrictEqual(result.draft, drafted.draft);
      assert.deepStrictEqual(result.similar, drafted.similar);
    }),
  );

  it.effect("refuses a lead", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const failure = yield* harness
        .call("factory_draft_ticket", draftInput, LEAD_THREAD)
        .pipe(Effect.flip);
      assert.deepInclude(failure, {
        reason: "not-found",
        message: "This thread is not an engineering manager.",
      });
      assert.deepStrictEqual(yield* Ref.get(harness.lifecycle), []);
    }),
  );
});
