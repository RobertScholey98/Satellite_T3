import { assert, describe, it } from "@effect/vitest";
import { FactoryProtectedPathAsk } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { FactoryProtectedPathAsksV1 } from "./FactoryProtectedPathAsksV1.ts";
import { FactoryV1 } from "./FactoryV1.ts";

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const decodeAsks = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(FactoryProtectedPathAsk)),
);
const AT = "2026-10-24T00:00:00.000Z";

describe("FactoryProtectedPathAsksV1", () => {
  it.effect("gives existing assignments no asks", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* FactoryV1;
        yield* sql`INSERT INTO factory_assignments(id,manager_id,project_id,title,brief,
            completion_condition,source,complexity,state,team_json,control_violations_json,
            created_at,updated_at)
          VALUES('assignment-1','manager-1','project-1','Ticket 1','Fix it.','Tests pass.',
            'ticket','small','waiting-user','{"preset":"custom","members":[]}',
            '[{"pullRequest":{"host":"github.com","repository":"acme/app","number":7},"paths":["AGENTS.md"]}]',
            ${AT},${AT})`;

        yield* FactoryProtectedPathAsksV1;

        const rows = yield* sql<{ protected_path_asks_json: string }>`
            SELECT protected_path_asks_json FROM factory_assignments`;
        assert.deepStrictEqual(
          rows.map((row) => decodeAsks(row.protected_path_asks_json)),
          [[]],
        );
      }),
    ),
  );
});
