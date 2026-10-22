import type { FactoryOperationError, FactoryRoleBrief } from "@t3tools/contracts";
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
  } satisfies McpToolAccess.Handlers<typeof FactoryToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(FactoryToolkit, make);
