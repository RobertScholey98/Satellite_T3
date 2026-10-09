import * as McpToolAccess from "../../McpToolAccess.ts";
import { DocumentOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { DocumentService } from "../../../documents/DocumentService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DocumentsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const documents = yield* DocumentService;

  return {
    publish_document: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireThreadMcpCapability("documents");
        const result = yield* documents.publish(
          { ...input, threadId: scope.thread.threadId },
          `agent:${scope.thread.providerInstanceId}:${scope.thread.providerSessionId}`,
        );
        return result.document;
      }),
    ),
    list_documents: McpToolAccess.readsAsCaller(() =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireThreadMcpCapability("documents");
        return { documents: yield* documents.list({ threadId: scope.thread.threadId }) };
      }),
    ),
    read_document: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireThreadMcpCapability("documents");
        const visible = yield* documents.list({ threadId: scope.thread.threadId });
        if (!visible.some((document) => document.id === input.documentId)) {
          return yield* new DocumentOperationError({
            reason: "not-found",
            message: "This document is not registered to the current thread.",
          });
        }
        const detail = yield* documents.get(input);
        return {
          ...detail,
          content: detail.content.slice(0, 20_000),
          contentTruncated: detail.content.length > 20_000,
        };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof DocumentsToolkit.tools>;
});

export const DocumentsToolkitHandlersLive = McpToolAccess.toLayer(DocumentsToolkit, make);
