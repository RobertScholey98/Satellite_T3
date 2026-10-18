import { OrchestratorMcpFailure, RevdocError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as RevdocService from "../../../revdoc/RevdocService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread } from "../../threadAccess.ts";
import { RevdocToolkit } from "./tools.ts";

/** Revdoc acts on a worktree, so its tools ride upstream's worktree capability. */
const worktreeScope = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("worktree")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot use Revdoc.",
    });
  }
  return scope;
});

const callerScope = (operation: string) =>
  Effect.flatMap(worktreeScope, (scope) =>
    McpInvocationContext.requireThreadScope(scope, operation),
  );

const handlers = {
  revdoc_read: McpToolAccess.reads(({ attentionOnly, ...input }) =>
    Effect.gen(function* () {
      yield* worktreeScope;
      const { projection } = yield* readThread(input.threadId);
      const service = yield* RevdocService.RevdocService;
      return yield* service.read(
        { ...input, threadId: projection.thread.id },
        { attentionOnly: attentionOnly ?? false },
      );
    }),
  ),
  revdoc_generate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope("revdoc_generate");
      const service = yield* RevdocService.RevdocService;
      return yield* service.generate(
        { ...input, threadId: input.threadId ?? scope.thread.threadId },
        { threadId: scope.thread.threadId },
      );
    }),
  ),
  revdoc_test: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope("revdoc_test");
      const service = yield* RevdocService.RevdocService;
      return yield* service.test(
        { ...input, threadId: scope.thread.threadId },
        { threadId: scope.thread.threadId },
      );
    }),
  ),
  revdoc_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope("revdoc_cancel");
      const service = yield* RevdocService.RevdocService;
      yield* service.cancel({ ...input, threadId: input.threadId ?? scope.thread.threadId });
      return {};
    }),
  ),
  revdoc_record_result: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope("revdoc_record_result");
      const service = yield* RevdocService.RevdocService;
      return yield* service.recordResult(input, scope.thread.threadId);
    }),
  ),
  revdoc_capture_evidence: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* callerScope("revdoc_capture_evidence");
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
        Effect.catchTags({
          PreviewAutomationUnavailableError: () =>
            Effect.fail(
              new RevdocError({
                code: "browser_access_off",
                message: "Agent browser access is off. Record this check as blocked.",
              }),
            ),
        }),
      );
      const service = yield* RevdocService.RevdocService;
      return yield* service.captureEvidence(input, scope);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof RevdocToolkit.tools>;

export const layer = McpToolAccess.toLayer(RevdocToolkit, handlers);
