import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_board_snapshots (
      board_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      board_json TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      failed_at TEXT,
      failure TEXT
    )
  `;
});
