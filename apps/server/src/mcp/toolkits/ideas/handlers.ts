import * as McpToolAccess from "../../McpToolAccess.ts";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import * as Effect from "effect/Effect";
import { IdeaRuntime, IdeaRuntimeError } from "../../../ideas/IdeaRuntime.ts";
import { IdeaPromotion } from "../../../ideas/IdeaPromotion.ts";
import { DocumentService } from "../../../documents/DocumentService.ts";
import { requireThreadMcpCapability } from "../../McpInvocationContext.ts";
import { IdeasToolkit, IdeasImageToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const runtime = yield* IdeaRuntime;
  const promotion = yield* IdeaPromotion;
  const documents = yield* DocumentService;
  return {
    idea_read: McpToolAccess.readsAsCaller((input) =>
      requireThreadMcpCapability("ideas").pipe(
        Effect.flatMap(({ thread: { threadId } }) => runtime.readContext({ ...input, threadId })),
      ),
    ),
    idea_read_main: McpToolAccess.readsAsCaller((input) =>
      requireThreadMcpCapability("ideas").pipe(
        Effect.flatMap(({ thread: { threadId } }) => runtime.readMain({ ...input, threadId })),
      ),
    ),
    idea_write_document: McpToolAccess.actsAsCaller((input) =>
      requireThreadMcpCapability("ideas").pipe(
        Effect.flatMap(({ thread }) =>
          documents.publishIdeaDocument(
            {
              threadId: thread.threadId,
              name: input.name,
              mediaType: input.mediaType,
              bytes: Buffer.from(input.text),
            },
            `agent:${thread.providerInstanceId}:${thread.providerSessionId}`,
          ),
        ),
      ),
    ),
    idea_propose_issues: McpToolAccess.actsAsCaller((input) =>
      requireThreadMcpCapability("ideas").pipe(
        Effect.flatMap(({ thread: { threadId } }) => promotion.propose({ ...input, threadId })),
      ),
    ),
    idea_publish_issues: McpToolAccess.actsAsCaller(() =>
      requireThreadMcpCapability("ideas").pipe(
        Effect.flatMap(({ thread: { threadId } }) => promotion.publish(threadId)),
      ),
    ),
  } satisfies McpToolAccess.Handlers<typeof IdeasToolkit.tools>;
});

export const IdeasToolkitHandlersLive = McpToolAccess.toLayer(IdeasToolkit, make);

export const IdeasImageToolkitHandlersLive = McpToolAccess.toLayer(
  IdeasImageToolkit,
  Effect.gen(function* () {
    const documents = yield* DocumentService;
    return {
      idea_read_image: McpToolAccess.readsAsCaller((input) =>
        Effect.gen(function* () {
          const {
            thread: { threadId },
          } = yield* requireThreadMcpCapability("ideas");
          const result = yield* documents.readIdeaDocument({
            threadId,
            artifactId: input.artifactId,
          });
          if (
            !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
              result.artifact.mediaType,
            )
          )
            return yield* new IdeaRuntimeError({
              message: "This document is not a supported PNG, JPEG, GIF or WebP image.",
            });
          const dimensions = readImageDimensions(Buffer.from(result.contentBase64, "base64"));
          if (!dimensions)
            return yield* new IdeaRuntimeError({
              message: "The attached image could not be decoded.",
            });
          return {
            artifact: result.artifact,
            screenshot: {
              data: result.contentBase64,
              mimeType: result.artifact.mediaType,
              ...dimensions,
            },
          };
        }),
      ),
    } satisfies McpToolAccess.Handlers<typeof IdeasImageToolkit.tools>;
  }),
);
