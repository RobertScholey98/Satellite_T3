import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  CommitRecommendation,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  SetCommitRecommendationInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import {
  CommitRecommendationError,
  CommitRecommendationService,
} from "../../../git/CommitRecommendationService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const SetCommitRecommendation = Tool.make("set_commit_recommendation", {
  description:
    "Set this thread's commit guidance. Use recommended when a coherent, verified piece of work is ready to commit (amber). Use overdue only when accumulated uncommitted work should be checkpointed before continuing (red); explain the concrete risk in reason. Use none to withdraw advice when work is unfinished or no longer ready. This is advisory and never commits or stages files. The signal expires when HEAD or the branch changes, or the checkout is clean. Reassess before finishing a coding turn; do not escalate based on elapsed time alone.",
  parameters: SetCommitRecommendationInput,
  success: Schema.Struct({ recommendation: Schema.NullOr(CommitRecommendation) }),
  failure: Schema.Union([
    CommitRecommendationError,
    McpCapabilityUnavailableError,
    OrchestratorMcpFailure,
  ]),
  dependencies: [ThreadManagementService, McpInvocationContext, CommitRecommendationService],
})
  .annotate(Tool.Title, "Set commit recommendation")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const CommitsToolkit = Toolkit.make(SetCommitRecommendation);
