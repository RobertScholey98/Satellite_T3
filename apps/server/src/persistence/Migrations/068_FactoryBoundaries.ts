import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE factory_state
    SET payload_json = json_set(payload_json, '$.boundaries', json('[]'))
    WHERE json_type(payload_json, '$.boundaries') IS NULL`;
});
