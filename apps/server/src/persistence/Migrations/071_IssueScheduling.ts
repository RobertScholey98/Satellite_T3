import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE issue_schedule_reservations (
    candidate_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, issue_key TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL UNIQUE, board_id TEXT NOT NULL,
    status TEXT NOT NULL, admission_json TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX issue_schedule_claim ON issue_schedule_reservations(issue_key)
    WHERE status <> 'released'`;
});
