import { FactoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  FactoryExecutionSuspension,
  FactoryDeliveryExecutionHold,
  type FactoryExecutionProfile,
} from "./FactoryExecutionProfile.ts";

const isFactoryError = Schema.is(FactoryError);
const decodeDeliveryHold = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FactoryDeliveryExecutionHold),
);

export const assertFactoryProfileActive = Effect.fn("assertFactoryProfileActive")(
  function* (profile: FactoryExecutionProfile | undefined) {
    if (profile?.integration !== undefined) {
      const fs = yield* FileSystem.FileSystem;
      if (
        (yield* fs.exists(profile.integration.stopPath)) &&
        (yield* fs.readDirectory(profile.integration.stopPath)).length > 0
      )
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail:
            "This integration preparation is held. Refresh its approved inputs before continuing.",
        });
    }
    if (profile?.retro !== undefined) {
      const fs = yield* FileSystem.FileSystem;
      if (yield* fs.exists(profile.retro.stopPath))
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail: "This retrospective runtime has stopped. Its evidence remains available.",
        });
    }
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
    const incidentDirectory = path.join(path.dirname(workspace.revocationPath), "incidents");
    if (
      (yield* fs.exists(incidentDirectory)) &&
      (yield* fs.readDirectory(incidentDirectory)).length > 0
    )
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail: "An incident restriction holds this assignment.",
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
    const holdPath = path.join(path.dirname(workspace.revocationPath), "delivery-hold.json");
    const hold = (yield* fs.exists(holdPath))
      ? yield* fs.readFileString(holdPath).pipe(Effect.flatMap(decodeDeliveryHold))
      : undefined;
    if (
      (hold?.state === "held" &&
        (hold.epoch !== workspace.grantEpoch ||
          profile?.inspection?.deliveryHoldId !== hold.holdId ||
          (profile.profileId ?? profile.boundaryId) !== hold.profileId)) ||
      (profile?.inspection?.deliveryHoldId !== undefined &&
        (hold?.state !== "held" || hold.holdId !== profile.inspection.deliveryHoldId))
    )
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail:
          "Implementation is held for the current UI flow decision. Only its bounded read-only planning context may run.",
      });
  },
  Effect.mapError((cause) =>
    isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause }),
  ),
);
