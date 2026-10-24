import { FactoryOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { backupFactoryConfig } from "./backup.ts";
import type { FactoryConfigStore } from "./FactoryConfigStore.ts";

const LEGACY_ROLES_DIRECTORY = "roles";

/**
 * Moves the retired role-skill overrides out of the config into the next backup folder, and
 * returns where they went, or null when there were none. Briefs no longer read them. A config
 * still unmigrated keeps them, so a migration that failed can read them again at the next start.
 * Moving rather than deleting keeps text a config pulled from elsewhere never migrated.
 */
export const retireLegacyRoles = Effect.fn("FactoryConfig.retireLegacyRoles")(function* (
  store: FactoryConfigStore["Service"],
  options: {
    /** Whether this start migrated the config, and so carried the role text into definitions. */
    readonly migratedThisStart: boolean;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roles = path.join(store.directory, LEGACY_ROLES_DIRECTORY);
  const exists = yield* fs.exists(roles).pipe(Effect.mapError(failed));
  if (!exists || !(yield* store.read).configured) return null;
  const backup = yield* backupFactoryConfig(store.directory);
  const target = path.join(backup, LEGACY_ROLES_DIRECTORY);
  yield* fs.rename(roles, target).pipe(
    // The folder holds only a copy of the definitions then; left behind, each restart adds one.
    Effect.tapError(() => fs.remove(backup, { recursive: true }).pipe(Effect.ignore)),
    Effect.mapError(failed),
  );
  if (options.migratedThisStart) {
    yield* Effect.logInfo("factory role files moved to a backup", { movedTo: target });
  } else {
    yield* Effect.logWarning(
      "factory role files moved to a backup; the factory config was set up without migrating them, so their text may be in no definition",
      { movedTo: target },
    );
  }
  return target;
});

const failed = () =>
  new FactoryOperationError({
    reason: "storage",
    message: "Could not move the retired factory role files into a backup.",
  });
