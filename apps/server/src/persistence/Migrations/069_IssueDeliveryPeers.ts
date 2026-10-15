import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE issue_delivery_peers (
    destination_environment_id TEXT PRIMARY KEY, endpoints_json TEXT NOT NULL,
    public_key TEXT NOT NULL, credential_expires_at TEXT NOT NULL,
    preferred_endpoint TEXT, state TEXT NOT NULL, last_error TEXT, last_attempt_at TEXT,
    last_delivered_at TEXT, failures INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0, registered_at TEXT NOT NULL
  )`;
  yield* sql`ALTER TABLE issue_attempts ADD COLUMN completed_at TEXT`;
  yield* sql`CREATE TABLE issue_peer_grants (
    source_environment_id TEXT PRIMARY KEY, public_key TEXT NOT NULL
  )`;
});
