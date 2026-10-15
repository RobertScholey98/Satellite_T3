import { assert, it } from "@effect/vitest";
import { DocumentOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ideaUploadFailure } from "./http.ts";
import { IdeaRuntimeError } from "./IdeaRuntime.ts";

it.effect("returns fixable idea upload failures to the client with their reason", () =>
  Effect.gen(function* () {
    const failures = yield* Effect.forEach(
      [
        new DocumentOperationError({ reason: "invalid", message: "Document must be UTF-8 text." }),
        new IdeaRuntimeError({ message: "Documents must be 20 MB or smaller." }),
        new DocumentOperationError({ reason: "storage", message: "Disk full." }),
      ],
      (cause) => ideaUploadFailure(cause).pipe(Effect.flip),
    );

    assert.deepEqual(
      failures.map((failure) => [failure._tag, failure.message]),
      [
        ["IdeaUploadRejectedError", "Document must be UTF-8 text."],
        ["IdeaUploadRejectedError", "Documents must be 20 MB or smaller."],
        [
          "EnvironmentInternalError",
          "The environment failed to answer this request (idea_upload_failed).",
        ],
      ],
    );
  }),
);
