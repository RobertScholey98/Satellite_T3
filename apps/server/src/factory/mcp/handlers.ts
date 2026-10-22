import type {
  FactoryAssignment,
  FactoryOperationError,
  FactoryRoleBrief,
  FactoryStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { FactoryService } from "../FactoryService.ts";
import { FactoryToolFailedError, FactoryToolkit } from "./tools.ts";

const toolFailure = ({ reason, message }: FactoryOperationError) =>
  new FactoryToolFailedError({ reason, message });

const briefSource: Record<FactoryRoleBrief["source"], string> = {
  project: "this project's role file",
  environment: "the environment's role file",
  default: "the built-in default",
};

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

  return {
    factory_propose_onboarding: McpToolAccess.actsAsCaller((report) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingManager("This thread is not an engineering manager.");
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
        const { manager } = yield* callingManager("This thread is not an engineering manager.");
        const status = yield* factory.status(manager.id).pipe(Effect.mapError(toolFailure));
        return { ...status, message: statusMessage(status) };
      }),
    ),
    factory_pickup: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingManager("This thread is not an engineering manager.");
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
        const { threadId } = yield* callingManager("This thread is not an engineering manager.");
        const assignment = yield* factory
          .commission(threadId, input)
          .pipe(Effect.mapError(toolFailure));
        return {
          assignment,
          message: started(assignment),
        };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof FactoryToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(FactoryToolkit, make);
