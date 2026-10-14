import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { DocumentService } from "../documents/DocumentService.ts";
import { decodeIdeaArtifactContent } from "./IdeaRuntime.ts";

export const ideaHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "ideas",
  Effect.fnUntraced(function* (handlers) {
    const documents = yield* DocumentService;
    return handlers
      .handle(
        "writeArtifact",
        Effect.fn("ideas.upload")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const artifact = yield* Effect.try(() =>
            decodeIdeaArtifactContent(args.payload.contentBase64),
          ).pipe(
            Effect.flatMap((bytes) =>
              documents.publishIdeaDocument(
                {
                  threadId: args.params.threadId,
                  name: args.payload.name,
                  mediaType: args.payload.mediaType,
                  bytes,
                },
                "upload",
              ),
            ),
            Effect.catch((cause) => failEnvironmentInternal("idea_upload_failed", cause)),
          );
          return { artifact };
        }),
      )
      .handle(
        "readArtifact",
        Effect.fn("ideas.readArtifact")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* documents
            .readIdeaDocument(args.params)
            .pipe(
              Effect.catch((cause) => failEnvironmentInternal("idea_document_unavailable", cause)),
            );
        }),
      );
  }),
);
