import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import { authenticateMediaRequest } from "../auth/http.ts";
import { FactoryPreviewEvidence } from "./FactoryPreviewEvidence.ts";
import { FactoryStore } from "./FactoryStore.ts";

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const evidence = yield* FactoryPreviewEvidence;
    const store = yield* FactoryStore;
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    yield* router.add(
      "GET",
      "/api/factory/preview-evidence/*",
      Effect.gen(function* () {
        yield* authenticateMediaRequest(AuthOrchestrationReadScope);
        const url = HttpServerRequest.toURL(yield* HttpServerRequest.HttpServerRequest);
        const match = Option.isSome(url)
          ? /^\/api\/factory\/preview-evidence\/([a-f0-9]{64})\/(\d+)$/.exec(url.value.pathname)
          : null;
        if (!match) return HttpServerResponse.empty({ status: 404 });
        const digest = match[1]!;
        const index = Number(match[2]);
        const state = yield* store.snapshot;
        if (
          !state.assignments.some((assignment) =>
            assignment.delivery?.revisions.some(
              (revision) => revision.uxEvidence?.operationsDigest === digest,
            ),
          )
        )
          return HttpServerResponse.empty({ status: 404 });
        const bundle = yield* evidence.read(digest);
        const artifact = bundle.artifacts[index];
        if (!artifact) return HttpServerResponse.empty({ status: 404 });
        const bytes = yield* fs.readFile(artifact.path);
        const actual = yield* crypto.digest("SHA-256", bytes);
        if (Buffer.from(actual).toString("hex") !== artifact.digest)
          return HttpServerResponse.empty({ status: 409 });
        return HttpServerResponse.uint8Array(bytes, {
          contentType: "image/png",
          headers: {
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        });
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
          FactoryError: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
          PlatformError: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
        }),
      ),
    );
  }),
);
