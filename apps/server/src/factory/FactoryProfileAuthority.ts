import { FactoryError, isFactoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  FactoryExecutionSuspension,
  FactoryDeliveryExecutionHold,
  type FactoryExecutionProfile,
} from "./FactoryExecutionProfile.ts";

const decodeDeliveryHold = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FactoryDeliveryExecutionHold),
);
const decodeIntegrationHold = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ holdId: Schema.String })),
);

/**
 * Host-side check of the authority holds a boundary's files record, run before a container
 * launch or boundary operation. Fails with `execution-unavailable` while the profile's
 * integration preparation, retrospective runtime or assignment workspace is held. A held delivery
 * flow admits only the inspection profile bound to that hold, and an inspection profile is
 * refused once its hold is gone. The volume helper repeats these checks inside its container,
 * so a new kind of hold needs both. A profile with none of these scopes always passes.
 */
export const assertFactoryProfileActive = Effect.fn("assertFactoryProfileActive")(
  function* (profile: FactoryExecutionProfile | undefined) {
    if (profile?.integration !== undefined) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stopPath = profile.integration.stopPath;
      for (const marker of (yield* fs.exists(stopPath)) ? yield* fs.readDirectory(stopPath) : []) {
        // A shared merge freeze stops the team through state admission, so its frozen lead can
        // still recover the operation. Volume helpers and checks refuse every marker.
        const hold = yield* fs
          .readFileString(path.join(stopPath, marker))
          .pipe(Effect.flatMap(decodeIntegrationHold), Effect.option);
        if (Option.isSome(hold) && hold.value.holdId.startsWith("merge-operation:")) continue;
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail:
            "This integration preparation is held. Refresh its approved inputs before continuing.",
        });
      }
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
