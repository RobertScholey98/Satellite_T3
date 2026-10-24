import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Satellite 105. A project may have several engineering managers, so the index that allowed one
 * unretired manager per project goes.
 */
export const FactoryManagersPerProjectV1 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS factory_managers_current`;
  yield* sql`CREATE INDEX IF NOT EXISTS factory_managers_project
    ON factory_managers(project_id, state)`;
});
