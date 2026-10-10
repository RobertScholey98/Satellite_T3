import {
  FactoryCommandResult,
  FactoryDispatchInput,
  FactoryError,
  FactorySnapshot,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as FactoryMcpGuard from "../../../factory/FactoryMcpGuard.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  FactoryMcpGuard.FactoryMcpGuard,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const failure = Schema.Union([FactoryError, OrchestratorMcpFailure]);

export const FactoryToolkit = Toolkit.make(
  Tool.make("factory_snapshot", {
    description:
      "Read this managed thread's manager and assignment state. The server derives scope from your authenticated thread.",
    parameters: Tool.EmptyParams,
    success: FactorySnapshot,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("factory_dispatch", {
    description:
      "Submit a factory command as this authenticated managed thread. Managers commission scoped implementation assignments against a human request; authorizationMessageId selects that request, or defaults to their latest direct human message. Leads and their team use assignment.file.mutate and assignment.verify within their granted scope and epoch. Onboarding leads submit onboarding.report. Human-only decisions cannot be made through this tool.",
    parameters: FactoryDispatchInput,
    success: FactoryCommandResult,
    failure,
    failureMode: "return",
    dependencies,
  }),
);
