import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE factory_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE factory_commands (
      command_id TEXT PRIMARY KEY,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE factory_outbox (
      effect_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL REFERENCES factory_commands(command_id),
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'superseded')),
      attempts INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX factory_outbox_pending ON factory_outbox(status, created_at)`;
});
