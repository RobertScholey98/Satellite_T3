import { FactoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  FactoryExecutionSuspension,
  type FactoryExecutionProfile,
} from "./FactoryExecutionProfile.ts";

const isFactoryError = Schema.is(FactoryError);

export const assertFactoryProfileActive = Effect.fn("assertFactoryProfileActive")(
  function* (profile: FactoryExecutionProfile | undefined) {
    const workspace = profile?.assignmentWorkspace;
    if (workspace === undefined) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (yield* fs.exists(workspace.revocationPath))
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail:
          "This assignment's execution grant was withdrawn. A new execution grant is required before it can resume.",
      });
    const suspensionPath = path.join(path.dirname(workspace.revocationPath), "suspension.json");
    if (yield* fs.exists(suspensionPath)) {
      const suspension = yield* fs
        .readFileString(suspensionPath)
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionSuspension)),
          ),
        );
      if (suspension.state === "suspended")
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail: "This assignment is paused. Resume its project before continuing managed work.",
        });
    }
  },
  Effect.mapError((cause) =>
    isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause }),
  ),
);
