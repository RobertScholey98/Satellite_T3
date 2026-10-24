import type {
  FactoryAssignment,
  FactoryAssignmentState,
  FactoryDefinitionsView,
  FactoryDraftTicketResult,
  FactoryOperationError,
  FactoryRoleBrief,
  FactoryStatus,
  FactoryRole,
  OrchestratorMcpDelegateTaskInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import { FactoryConfigStore } from "../config/FactoryConfigStore.ts";
import { FactoryService } from "../FactoryService.ts";
import { FactoryToolFailedError, FactoryToolkit } from "./tools.ts";

const toolFailure = ({ reason, message }: FactoryOperationError) =>
  new FactoryToolFailedError({ reason, message });

const briefSource: Record<FactoryRoleBrief["source"], string> = {
  project: "this project's role file",
  environment: "the environment's role file",
  default: "the built-in protocol",
  definition: "the factory config's definition",
};

const NOT_A_MANAGER = "This thread is not an engineering manager.";
const NOT_A_LEAD = "This thread is not a factory lead.";
const NOT_A_MANAGER_OR_LEAD = "This thread is not an engineering manager or a factory lead.";
const NOT_A_MEMBER = "This thread is not a member of a live factory team.";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const statusMessage = ({
  activeCount,
  concurrencyCap,
  capacityFree,
  readyTickets,
}: FactoryStatus) => {
  const unjudged = readyTickets.filter((ticket) => !ticket.judged).length;
  // `capacityFree` covers the environment's cap too, so no room while under the manager's own cap
  // means the environment, shared by every project, is full.
  const capacity = capacityFree
    ? "capacity is free"
    : activeCount < concurrencyCap
      ? "no capacity is free: this environment's cap, shared by every project, is full"
      : "no capacity is free";
  return `${activeCount} of ${plural(concurrencyCap, "slot")} in use, so ${capacity}; ${plural(unjudged, "Ready ticket")} await judgement.`;
};

const definitionsMessage = ({ configured, workers, teams, problems }: FactoryDefinitionsView) => {
  if (!configured) return "No factory config is saved on this environment yet.";
  const unread =
    problems.length === 0 ? "" : ` ${plural(problems.length, "file")} could not be read.`;
  return `${plural(teams.length, "team")} and ${plural(workers.length, "worker")}.${unread}`;
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

/** A member copied from a worker definition does whatever its description says: implementation. */
const taskRole = (role: FactoryRole): NonNullable<OrchestratorMcpDelegateTaskInput["role"]> =>
  role === "reviewer" ? "review" : role === "verifier" ? "test" : "implementation";

const draftMessage = ({ draft, similar }: FactoryDraftTicketResult) =>
  similar.length === 0
    ? `Drafted "${draft.title}" into Retro triage. Nothing similar is open.`
    : `Drafted "${draft.title}" into Retro triage. ${similar.length === 1 ? "1 similar draft or ticket is" : `${similar.length} similar drafts or tickets are`} open: if one covers the same work, tell the user which to merge.`;

const endedAs: Partial<Record<FactoryAssignmentState, string>> = {
  completed: "completed",
  cancelled: "ended cancelled",
};

const make = Effect.gen(function* () {
  const factory = yield* FactoryService;
  const configStore = yield* FactoryConfigStore;

  const callingManager = Effect.fn("FactoryMcp.callingManager")(function* (notMember: string) {
    const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
    const { threadId } = (yield* McpInvocationContext.requireThreadScope(scope, "This tool"))
      .thread;
    const manager = yield* factory.managerForThread(threadId).pipe(Effect.mapError(toolFailure));
    if (manager === null) {
      const finished = yield* factory
        .finishedOnboardingMessage(threadId)
        .pipe(Effect.mapError(toolFailure));
      return yield* new FactoryToolFailedError({
        reason: "not-found",
        message: finished ?? notMember,
      });
    }
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

  const callingManagerOrLead = () =>
    callingManager(NOT_A_MANAGER_OR_LEAD).pipe(
      Effect.catch(() => callingLead(NOT_A_MANAGER_OR_LEAD)),
      Effect.asVoid,
    );

  /** A lead or worker. The service still refuses a member whose own thread has ended. */
  const callingMember = Effect.fn("FactoryMcp.callingMember")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
    const { threadId } = (yield* McpInvocationContext.requireThreadScope(scope, "This tool"))
      .thread;
    const assignment = yield* factory
      .assignmentForThread(threadId)
      .pipe(Effect.mapError(toolFailure));
    if (assignment === null || assignment.state === "completed" || assignment.state === "cancelled")
      return yield* new FactoryToolFailedError({ reason: "not-found", message: NOT_A_MEMBER });
    return { threadId, assignment };
  });

  /** A manager reads any of its assignments, a lead only the one it leads. */
  const readableAssignment = Effect.fn("FactoryMcp.readableAssignment")(function* (
    assignmentId: string,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
    const { threadId } = (yield* McpInvocationContext.requireThreadScope(scope, "This tool"))
      .thread;
    const notFound = new FactoryToolFailedError({
      reason: "not-found",
      message: `No assignment ${assignmentId} is yours to read.`,
    });
    const manager = yield* factory.managerForThread(threadId).pipe(Effect.mapError(toolFailure));
    if (manager !== null) {
      const assignments = yield* factory
        .listAssignments({ managerId: manager.id, includeEnded: true })
        .pipe(Effect.mapError(toolFailure));
      const assignment = assignments.find((candidate) => candidate.id === assignmentId);
      if (assignment === undefined) return yield* notFound;
      return assignment;
    }
    const led = yield* factory.assignmentForThread(threadId).pipe(Effect.mapError(toolFailure));
    if (led === null || led.leadThreadId !== threadId)
      return yield* new FactoryToolFailedError({
        reason: "not-found",
        message: NOT_A_MANAGER_OR_LEAD,
      });
    if (led.id !== assignmentId) return yield* notFound;
    return led;
  });

  return {
    factory_propose_onboarding: McpToolAccess.actsAsCaller((proposal) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingManager(NOT_A_MANAGER);
        const manager = yield* factory
          .proposeOnboarding(threadId, proposal)
          .pipe(Effect.mapError(toolFailure));
        return {
          managerId: manager.id,
          managerName: manager.name,
          state: manager.state,
          // The service just stored the proposal, so it is present.
          detected: manager.onboardingProposal!.detected,
          message:
            "The proposal is with the user. Tell them in this thread that it is ready for review in Satellite.",
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
    factory_definitions: McpToolAccess.reads(() =>
      Effect.gen(function* () {
        yield* callingManagerOrLead();
        const view = yield* configStore.read.pipe(Effect.mapError(toolFailure));
        return { ...view, message: definitionsMessage(view) };
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
          role: taskRole(plan.role),
          isolation: "shared",
          mode: "async",
        });
        yield* factory
          .recordMember(threadId, {
            threadId: task.childThreadId,
            role: plan.role,
            ...(plan.member === undefined ? {} : { memberName: plan.member }),
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
        const { threadId, manager } = yield* callingManager(NOT_A_MANAGER);
        const team = yield* factory.createTeam(threadId, input).pipe(Effect.mapError(toolFailure));
        // An onboarding result that lists teams limits this manager to them; an empty list allows all.
        const teamIds = manager.onboardingResult?.teamIds ?? [];
        const staffable = teamIds.length === 0 || teamIds.includes(team.id);
        return {
          team,
          message: staffable
            ? `Added the team "${team.name}" with the id ${team.id}. Pass it as teamId when you pick up or commission work.`
            : `Added the team "${team.name}" with the id ${team.id}, but you cannot staff it yet: your onboarding result limits you to other teams. Ask the user to add ${team.id} to your teams in Satellite.`,
        };
      }),
    ),
    factory_record_finding: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingMember();
        const finding = yield* factory
          .recordFinding(threadId, input)
          .pipe(Effect.mapError(toolFailure));
        return {
          finding,
          message: finding.escalated
            ? "Recorded the finding and woke the manager to decide on it."
            : "Recorded the finding. The manager reads it at the retro.",
        };
      }),
    ),
    factory_findings: McpToolAccess.reads(({ assignmentId }) =>
      Effect.gen(function* () {
        const assignment = yield* readableAssignment(assignmentId);
        const findings = yield* factory
          .listFindings({ assignmentId: assignment.id })
          .pipe(Effect.mapError(toolFailure));
        return {
          findings,
          message: `${plural(findings.length, "finding")} on "${assignment.title}".`,
        };
      }),
    ),
    factory_retro_done: McpToolAccess.actsAsCaller(() =>
      Effect.gen(function* () {
        const { threadId } = yield* callingLead(NOT_A_LEAD);
        const assignment = yield* factory.retroDone(threadId).pipe(Effect.mapError(toolFailure));
        return {
          assignment,
          message: "The team retro is done. The manager is woken for its retro; stop here.",
        };
      }),
    ),
    factory_draft_ticket: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingManager(NOT_A_MANAGER);
        const result = yield* factory
          .draftTicket(threadId, input)
          .pipe(Effect.mapError(toolFailure));
        return { ...result, message: draftMessage(result) };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof FactoryToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(FactoryToolkit, make);
