import type {
  FactoryAssignment,
  FactoryAssignmentState,
  FactoryOperationError,
  FactoryRoleBrief,
  FactoryStatus,
  FactoryWorkerRole,
  OrchestratorMcpDelegateTaskInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import { FactoryService } from "../FactoryService.ts";
import { FactoryToolFailedError, FactoryToolkit } from "./tools.ts";

const toolFailure = ({ reason, message }: FactoryOperationError) =>
  new FactoryToolFailedError({ reason, message });

const briefSource: Record<FactoryRoleBrief["source"], string> = {
  project: "this project's role file",
  environment: "the environment's role file",
  default: "the built-in default",
};

const NOT_A_MANAGER = "This thread is not an engineering manager.";
const NOT_A_LEAD = "This thread is not a factory lead.";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const statusMessage = ({
  activeCount,
  concurrencyCap,
  capacityFree,
  readyTickets,
}: FactoryStatus) => {
  const unjudged = readyTickets.filter((ticket) => !ticket.judged).length;
  const capacity = capacityFree ? "capacity is free" : "no capacity is free";
  return `${activeCount} of ${plural(concurrencyCap, "slot")} in use, so ${capacity}; ${plural(unjudged, "Ready ticket")} await judgement.`;
};

const started = (assignment: FactoryAssignment) =>
  `Started assignment ${assignment.id}, "${assignment.title}". Its lead is launching.`;

const claimMessage = (assignment: FactoryAssignment) =>
  assignment.state === "retro"
    ? "No pull request is left open, so the retro starts. Write your team retro next."
    : `${assignment.waitingReason ?? "The user reviews your pull requests."} The retro starts once they are merged; wait for that message.`;

const recoverMessage = (assignment: FactoryAssignment) =>
  assignment.state === "waiting-user"
    ? `The recovery allowance is spent, so "${assignment.title}" is with the user, with your brief as the recommendation.`
    : `Recovered "${assignment.title}" (${assignment.recoveryUsed} recovery used). Its lead is ${assignment.leadThreadId}.`;

const taskRole: Record<FactoryWorkerRole, NonNullable<OrchestratorMcpDelegateTaskInput["role"]>> = {
  implementer: "implementation",
  reviewer: "review",
  verifier: "test",
};

const endedAs: Partial<Record<FactoryAssignmentState, string>> = {
  completed: "completed",
  cancelled: "ended cancelled",
};

const make = Effect.gen(function* () {
  const factory = yield* FactoryService;

  const callingManager = Effect.fn("FactoryMcp.callingManager")(function* (notMember: string) {
    const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
    const { threadId } = (yield* McpInvocationContext.requireThreadScope(scope, "This tool"))
      .thread;
    const manager = yield* factory.managerForThread(threadId).pipe(Effect.mapError(toolFailure));
    if (manager === null)
      return yield* new FactoryToolFailedError({ reason: "not-found", message: notMember });
    return { threadId, manager };
  });

  const callingLead = Effect.fn("FactoryMcp.callingLead")(function* (notMember: string) {
    const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
    const { threadId } = (yield* McpInvocationContext.requireThreadScope(scope, "This tool"))
      .thread;
    const assignment = yield* factory
      .assignmentForThread(threadId)
      .pipe(Effect.mapError(toolFailure));
    if (
      assignment === null ||
      assignment.leadThreadId !== threadId ||
      assignment.state === "completed" ||
      assignment.state === "cancelled"
    )
      return yield* new FactoryToolFailedError({ reason: "not-found", message: notMember });
    return { threadId, assignment };
  });

  return {
    factory_propose_onboarding: McpToolAccess.actsAsCaller((report) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingManager(NOT_A_MANAGER);
        const manager = yield* factory
          .proposeOnboarding(threadId, report)
          .pipe(Effect.mapError(toolFailure));
        return {
          managerId: manager.id,
          managerName: manager.name,
          state: manager.state,
          controlPaths: manager.onboardingReport?.controlPaths ?? [],
          message:
            "The onboarding report is with the user. Ask them in this thread to review and approve it in Satellite.",
        };
      }),
    ),
    factory_role_brief: McpToolAccess.reads(({ role }) =>
      Effect.gen(function* () {
        const { manager } = yield* callingManager("This thread is not part of the factory.");
        const brief = yield* factory
          .roleBrief(manager.projectId, role, manager.id)
          .pipe(Effect.mapError(toolFailure));
        return {
          ...brief,
          message: `The ${role} brief, from ${briefSource[brief.source]}.`,
        };
      }),
    ),
    factory_status: McpToolAccess.reads(() =>
      Effect.gen(function* () {
        const { manager } = yield* callingManager(NOT_A_MANAGER);
        const status = yield* factory.status(manager.id).pipe(Effect.mapError(toolFailure));
        return { ...status, message: statusMessage(status) };
      }),
    ),
    factory_pickup: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingManager(NOT_A_MANAGER);
        const assignment = yield* factory
          .pickup(threadId, input)
          .pipe(Effect.mapError(toolFailure));
        return {
          decision: input.decision,
          assignment,
          message:
            assignment === null
              ? `Skipped ticket #${input.issueNumber}. It counts as judged until the ticket changes.`
              : started(assignment),
        };
      }),
    ),
    factory_commission: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingManager(NOT_A_MANAGER);
        const assignment = yield* factory
          .commission(threadId, input)
          .pipe(Effect.mapError(toolFailure));
        return {
          assignment,
          message: started(assignment),
        };
      }),
    ),
    factory_claim_complete: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingLead(NOT_A_LEAD);
        const assignment = yield* factory
          .claimComplete(threadId, input)
          .pipe(Effect.mapError(toolFailure));
        return { assignment, message: claimMessage(assignment) };
      }),
    ),
    factory_report_dependency: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingLead(NOT_A_LEAD);
        const dependency = yield* factory
          .reportDependency(threadId, input)
          .pipe(Effect.mapError(toolFailure));
        const assignment = yield* factory
          .assignmentForThread(threadId)
          .pipe(Effect.mapError(toolFailure));
        if (assignment === null)
          return yield* new FactoryToolFailedError({ reason: "not-found", message: NOT_A_LEAD });
        return {
          dependency,
          assignment,
          message: `Recorded "${dependency.title}". The manager is told; this assignment waits as blocked until it is delivered.`,
        };
      }),
    ),
    factory_recover: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingManager(NOT_A_MANAGER);
        const assignment = yield* factory
          .recover(threadId, input)
          .pipe(Effect.mapError(toolFailure));
        return { assignment, message: recoverMessage(assignment) };
      }),
    ),
    factory_complete: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingManager(NOT_A_MANAGER);
        const assignment = yield* factory
          .complete(threadId, input)
          .pipe(Effect.mapError(toolFailure));
        return {
          assignment,
          message: `"${assignment.title}" ${endedAs[assignment.state] ?? assignment.state}.`,
        };
      }),
    ),
    factory_delegate: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingLead(NOT_A_LEAD);
        const plan = yield* factory
          .planDelegation(threadId, input)
          .pipe(Effect.mapError(toolFailure));
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
        const task = yield* orchestrator.delegateTask(scope, {
          task: plan.task,
          title: plan.title,
          target: {
            providerInstanceId: plan.modelSelection.instanceId,
            model: plan.modelSelection.model,
          },
          role: taskRole[plan.role],
          isolation: "shared",
          mode: "async",
        });
        yield* factory
          .recordMember(threadId, {
            threadId: task.childThreadId,
            role: plan.role,
            modelSelection: plan.modelSelection,
            joined: "created",
          })
          .pipe(
            // The child already runs, so say so; a retry would start a second one.
            Effect.mapError(
              (error) =>
                new FactoryToolFailedError({
                  reason: error.reason,
                  message: `Started ${task.childThreadId} (task ${task.taskId}), but could not record it on the team: ${error.message}`,
                }),
            ),
          );
        return {
          taskId: task.taskId,
          childThreadId: task.childThreadId,
          role: plan.role,
          model: plan.modelSelection,
          message: `Started a ${plan.role} on ${plan.modelSelection.model}, task ${task.taskId}. Its completion wakes this thread.`,
        };
      }),
    ),
    factory_update_checklist: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingLead(NOT_A_LEAD);
        const assignment = yield* factory
          .updateChecklist(threadId, input)
          .pipe(Effect.mapError(toolFailure));
        return {
          checklist: assignment.checklist,
          message: `The checklist has ${plural(assignment.checklist.length, "step")}.`,
        };
      }),
    ),
    factory_create_team: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingManager(NOT_A_MANAGER);
        const preset = yield* factory
          .createTeam(threadId, input)
          .pipe(Effect.mapError(toolFailure));
        return {
          preset,
          message: `Added the team preset "${preset.name}". Name it as the team when you pick up or commission work.`,
        };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof FactoryToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(FactoryToolkit, make);
