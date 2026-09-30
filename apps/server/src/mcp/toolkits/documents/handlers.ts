import { DocumentOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { DocumentService } from "../../../documents/DocumentService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DocumentsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const documents = yield* DocumentService;

  return DocumentsToolkit.of({
    publish_document: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("documents");
        const result = yield* documents.publish(
          { ...input, threadId: scope.threadId },
          `agent:${scope.providerInstanceId}:${scope.providerSessionId}`,
        );
        return result.document;
      }),
    list_documents: () =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("documents");
        return { documents: yield* documents.list({ threadId: scope.threadId }) };
      }),
    read_document: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("documents");
        const visible = yield* documents.list({ threadId: scope.threadId });
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
  });
});

export const DocumentsToolkitHandlersLive = DocumentsToolkit.toLayer(make);
