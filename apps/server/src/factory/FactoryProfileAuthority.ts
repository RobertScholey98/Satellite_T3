import { FactoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import type { FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";

const isFactoryError = Schema.is(FactoryError);

export const assertFactoryProfileActive = Effect.fn("assertFactoryProfileActive")(
  function* (profile: FactoryExecutionProfile | undefined) {
    const workspace = profile?.assignmentWorkspace;
    if (workspace === undefined) return;
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(workspace.revocationPath))
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail:
          "This assignment's execution grant was withdrawn. A new execution grant is required before it can resume.",
      });
  },
  Effect.mapError((cause) =>
    isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause }),
  ),
);
