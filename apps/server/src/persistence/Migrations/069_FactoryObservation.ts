import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE factory_observers (
    name TEXT PRIMARY KEY NOT NULL,
    sequence INTEGER NOT NULL
  )`;
});
