import { assert, describe, it } from "@effect/vitest";
import { FactoryOnboardingResult } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { FactoryOnboardingResultV1 } from "./FactoryOnboardingResultV1.ts";
import { FactoryV1 } from "./FactoryV1.ts";

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(FactoryOnboardingResult));
const AT = "2026-10-20T00:00:00.000Z";
const REPORT = JSON.stringify({
  summary: "pnpm workspace.",
  controlPaths: ["AGENTS.md"],
  boardGaps: [],
  openChoices: ["Which tickets count as small?"],
});

const insertManager = (
  id: string,
  projectId: string,
  state: string,
  pausedFrom: string | null,
  controlPaths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO factory_managers(id,project_id,name,state,paused_from,thread_id,
        control_paths_json,onboarding_notes,onboarding_report_json,created_at,updated_at)
      VALUES(${id},${projectId},${id},${state},${pausedFrom},${`thread-${id}`},
        ${JSON.stringify(controlPaths)},'pnpm workspace.',${REPORT},${AT},${AT})`;
  });

describe("FactoryOnboardingResultV1", () => {
  it.effect("gives managers past onboarding a result from what they had, pickup off", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* FactoryV1;
        yield* sql`INSERT INTO factory_config(scope_key,config_json,updated_at) VALUES
          ('environment','{"pickupGuidance":" Small bugs. ","concurrencyCap":3,"modelPool":[]}',${AT}),
          ('project:project-1','{"pickupGuidance":"Only docs.","concurrencyCap":1}',${AT}),
          ('project:project-4','{"recoveryAllowance":2}',${AT})`;
        yield* insertManager("active", "project-1", "active", null, [
          " .github/** ",
          "AGENTS.md",
          ".satellite/factory/",
          "",
          "AGENTS.md",
        ]);
        yield* insertManager("onboarding", "project-2", "onboarding", null, []);
        yield* insertManager("paused-onboarding", "project-3", "manager-paused", "onboarding", []);
        yield* insertManager("paused-active", "project-4", "project-paused", "active", [
          ".satellite/factory/",
        ]);

        yield* FactoryOnboardingResultV1;

        const rows = yield* sql<{
          id: string;
          onboarding_proposal_json: string | null;
          onboarding_result_json: string | null;
          onboarding_report_json: string | null;
        }>`SELECT id,onboarding_proposal_json,onboarding_result_json,onboarding_report_json
            FROM factory_managers ORDER BY id`;
        const results = Object.fromEntries(
          rows.map((row) => [
            row.id,
            row.onboarding_result_json === null ? null : decodeResult(row.onboarding_result_json),
          ]),
        );
        const empty = {
          purpose: "",
          baseBranch: null,
          rules: [],
          teamIds: [],
        };
        assert.deepStrictEqual(results, {
          active: {
            ...empty,
            pickup: { enabled: false, columns: [], labels: [], guidance: "Only docs." },
            controlPaths: [
              { path: ".github/**", reason: "" },
              { path: "AGENTS.md", reason: "" },
            ],
            concurrencyCap: 1,
          },
          onboarding: null,
          "paused-active": {
            ...empty,
            pickup: { enabled: false, columns: [], labels: [], guidance: "Small bugs." },
            controlPaths: [],
            concurrencyCap: 3,
          },
          "paused-onboarding": null,
        });
        for (const row of rows) {
          assert.isNull(row.onboarding_proposal_json, row.id);
          assert.isNull(row.onboarding_report_json, row.id);
        }
      }),
    ),
  );

  it.effect("falls back to the default cap and no guidance with no stored config", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* FactoryV1;
        yield* insertManager("active", "project-1", "active", null, []);

        yield* FactoryOnboardingResultV1;

        const [row] = yield* sql<{ onboarding_result_json: string }>`
            SELECT onboarding_result_json FROM factory_managers`;
        const result = decodeResult(row!.onboarding_result_json);
        assert.strictEqual(result.concurrencyCap, 2);
        assert.strictEqual(result.pickup.guidance, "");
      }),
    ),
  );
});
