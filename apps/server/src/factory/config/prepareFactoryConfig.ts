import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { FactoryConfigStore } from "./FactoryConfigStore.ts";
import { migrateFactoryConfigFromDatabase } from "./migrateFromDatabase.ts";
import { retireLegacyRoles } from "./retireLegacyRoles.ts";

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause);
  return failure instanceof Error && failure.message !== ""
    ? failure.message
    : "The migration failed unexpectedly.";
};

/**
 * What startup does with the factory config before the factory runs: migrate it from the
 * database once, then retire the old role files. Neither stops startup. A failed migration leaves
 * `factory.yaml` missing, so it runs again at the next start; until then the store reports why,
 * so nothing writes `factory.yaml` over the config still waiting in the database.
 */
export const prepareFactoryConfig = Effect.fn("FactoryConfig.prepare")(function* () {
  const store = yield* FactoryConfigStore;
  const configuredBefore = yield* store.read.pipe(
    Effect.map((view) => view.configured),
    // Unreadable means unknown; assume set up, so the retirement warns rather than reassures.
    Effect.orElseSucceed(() => true),
  );
  const failure = yield* migrateFactoryConfigFromDatabase().pipe(
    Effect.as(null),
    Effect.catchCause((cause) =>
      Effect.logWarning("factory config migration failed", { cause }).pipe(
        Effect.as(failureMessage(cause)),
      ),
    ),
  );
  yield* store.recordMigrationFailure(failure);
  yield* retireLegacyRoles(store, { migratedThisStart: !configuredBefore }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("factory role files could not be moved to a backup", { cause }),
    ),
  );
});
