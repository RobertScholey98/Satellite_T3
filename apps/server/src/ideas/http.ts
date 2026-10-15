import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  DocumentOperationError,
  EnvironmentHttpApi,
  type EnvironmentInternalError,
  IdeaUploadRejectedError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { DocumentService } from "../documents/DocumentService.ts";
import { IdeaRuntimeError, decodeIdeaArtifactContent } from "./IdeaRuntime.ts";

const isDocumentOperationError = Schema.is(DocumentOperationError);
const isIdeaRuntimeError = Schema.is(IdeaRuntimeError);

/** Upload failures the user can fix, such as size, encoding or remote HTML resources, return the reason. */
export const ideaUploadFailure = (
  cause: unknown,
): Effect.Effect<never, IdeaUploadRejectedError | EnvironmentInternalError> =>
  (isDocumentOperationError(cause) && cause.reason === "invalid") || isIdeaRuntimeError(cause)
    ? Effect.fail(new IdeaUploadRejectedError({ detail: cause.message }))
    : failEnvironmentInternal("idea_upload_failed", cause);

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
          const artifact = yield* Effect.try({
            try: () => decodeIdeaArtifactContent(args.payload.contentBase64),
            catch: (cause) =>
              isIdeaRuntimeError(cause)
                ? cause
                : new IdeaRuntimeError({ message: "The document contains invalid data." }),
          }).pipe(
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
            Effect.catch(ideaUploadFailure),
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
