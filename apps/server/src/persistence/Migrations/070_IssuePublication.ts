import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE issue_publications (
    request_id TEXT PRIMARY KEY NOT NULL,
    request_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    create_attempted INTEGER NOT NULL DEFAULT 0
  )`;
});
