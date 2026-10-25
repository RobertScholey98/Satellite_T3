import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Satellite 106. Each assignment keeps the protected files its team asked to edit and the user's
 * answers, so an allowed file stops holding the assignment. Existing assignments have no asks.
 */
export const FactoryProtectedPathAsksV1 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE factory_assignments
    ADD COLUMN protected_path_asks_json TEXT NOT NULL DEFAULT '[]'`;
});
