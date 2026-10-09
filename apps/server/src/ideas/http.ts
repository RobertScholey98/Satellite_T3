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
import { IdeaRuntime } from "./IdeaRuntime.ts";

export const ideaHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "ideas",
  Effect.fnUntraced(function* (handlers) {
    const runtime = yield* IdeaRuntime;
    return handlers
      .handle(
        "writeArtifact",
        Effect.fn("ideas.upload")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const artifact = yield* runtime
            .writeArtifact({ ...args.payload, threadId: args.params.threadId, source: "upload" })
            .pipe(Effect.catch((cause) => failEnvironmentInternal("idea_upload_failed", cause)));
          return { artifact };
        }),
      )
      .handle(
        "readArtifact",
        Effect.fn("ideas.readArtifact")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* runtime
            .readArtifact(args.params)
            .pipe(
              Effect.catch((cause) => failEnvironmentInternal("idea_document_unavailable", cause)),
            );
        }),
      );
  }),
);
