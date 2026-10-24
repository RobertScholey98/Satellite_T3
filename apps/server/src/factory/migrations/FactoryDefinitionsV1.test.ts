import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { FactoryDefinitionsV1 } from "./FactoryDefinitionsV1.ts";
import { FactoryOnboardingResultV1 } from "./FactoryOnboardingResultV1.ts";
import { FactoryV1 } from "./FactoryV1.ts";

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const AT = "2026-10-20T00:00:00.000Z";

describe("FactoryDefinitionsV1", () => {
  it.effect(
    "adds the member name, manager definition and member stats columns, empty for existing rows",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* FactoryV1;
          yield* FactoryOnboardingResultV1;
          yield* sql`INSERT INTO factory_managers(id,project_id,name,state,thread_id,
            control_paths_json,onboarding_notes,created_at,updated_at)
          VALUES('manager-1','project-1','Ada','active','thread-manager','[]','',${AT},${AT})`;

          yield* FactoryDefinitionsV1;
          // A second run, as after an earlier build of this migration, changes nothing.
          yield* FactoryDefinitionsV1;

          const managers = yield* sql<{ id: string; definition_json: string | null }>`
            SELECT id,definition_json FROM factory_managers`;
          assert.deepStrictEqual(managers, [{ id: "manager-1", definition_json: null }]);
          const memberColumns = yield* sql<{ name: string }>`
            SELECT name FROM pragma_table_info('factory_members') WHERE name='member_name'`;
          assert.deepStrictEqual(memberColumns, [{ name: "member_name" }]);
          const statsColumns = yield* sql<{ name: string }>`
            SELECT name FROM pragma_table_info('factory_assignment_stats') WHERE name='by_member_json'`;
          assert.deepStrictEqual(statsColumns, [{ name: "by_member_json" }]);
        }),
      ),
  );
});
