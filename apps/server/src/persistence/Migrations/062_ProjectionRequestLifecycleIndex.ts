import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_request_lifecycle
    ON projection_thread_activities(thread_id, kind)
    WHERE kind IN (
      'approval.requested', 'approval.resolved', 'provider.approval.respond.failed',
      'user-input.requested', 'user-input.resolved', 'provider.user-input.respond.failed'
    )
  `;
});
