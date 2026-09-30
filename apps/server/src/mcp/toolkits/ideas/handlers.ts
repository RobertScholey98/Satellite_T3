import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import * as Effect from "effect/Effect";
import { IdeaRuntime, IdeaRuntimeError } from "../../../ideas/IdeaRuntime.ts";
import { IdeaPromotion } from "../../../ideas/IdeaPromotion.ts";
import { requireMcpCapability } from "../../McpInvocationContext.ts";
import { IdeasToolkit, IdeasImageToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const runtime = yield* IdeaRuntime;
  const promotion = yield* IdeaPromotion;
  return IdeasToolkit.of({
    idea_read: (input) =>
      requireMcpCapability("ideas").pipe(
        Effect.flatMap(({ threadId }) => runtime.readContext({ ...input, threadId })),
      ),
    idea_read_main: (input) =>
      requireMcpCapability("ideas").pipe(
        Effect.flatMap(({ threadId }) => runtime.readMain({ ...input, threadId })),
      ),
    idea_write_document: (input) =>
      requireMcpCapability("ideas").pipe(
        Effect.flatMap(({ threadId }) =>
          runtime.writeArtifact({
            threadId,
            name: input.name,
            mediaType: input.mediaType,
            contentBase64: Buffer.from(input.text).toString("base64"),
            source: "agent",
          }),
        ),
      ),
    idea_propose_issues: (input) =>
      requireMcpCapability("ideas").pipe(
        Effect.flatMap(({ threadId }) => promotion.propose({ ...input, threadId })),
      ),
    idea_publish_issues: () =>
      requireMcpCapability("ideas").pipe(
        Effect.flatMap(({ threadId }) => promotion.publish(threadId)),
      ),
  });
});

export const IdeasToolkitHandlersLive = IdeasToolkit.toLayer(make);

export const IdeasImageToolkitHandlersLive = IdeasImageToolkit.toLayer(
  Effect.gen(function* () {
    const runtime = yield* IdeaRuntime;
    return IdeasImageToolkit.of({
      idea_read_image: (input) =>
        Effect.gen(function* () {
          const { threadId } = yield* requireMcpCapability("ideas");
          const result = yield* runtime.readArtifact({ threadId, artifactId: input.artifactId });
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
    });
  }),
);
