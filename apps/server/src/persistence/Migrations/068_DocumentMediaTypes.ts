import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Revisions record a declared media type so idea uploads can hold binary media such as images. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE document_revisions ADD COLUMN media_type TEXT`;
});
