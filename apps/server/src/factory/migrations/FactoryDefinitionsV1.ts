import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Satellite 104. Teams come from the factory config's definition files. A member records the
 * team member name it was delegated as, a manager its own copy of a manager definition, and an
 * ended assignment its cost per team member. All start empty: existing rows predate
 * definitions. Each column is added only when missing, so running this again is safe.
 */
export const FactoryDefinitionsV1 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = (table: string) =>
    sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.name))),
    );

  if (!(yield* columns("factory_members")).has("member_name")) {
    yield* sql`ALTER TABLE factory_members ADD COLUMN member_name TEXT`;
  }
  if (!(yield* columns("factory_managers")).has("definition_json")) {
    yield* sql`ALTER TABLE factory_managers ADD COLUMN definition_json TEXT`;
  }
  if (!(yield* columns("factory_assignment_stats")).has("by_member_json")) {
    yield* sql`ALTER TABLE factory_assignment_stats ADD COLUMN by_member_json TEXT`;
  }
});
