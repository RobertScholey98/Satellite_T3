import { assert, describe, it } from "@effect/vitest";
import { ProjectId, type FactoryOnboardingResult } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import type { ProjectRow } from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { FactoryDefinitionsV1 } from "../migrations/FactoryDefinitionsV1.ts";
import { FactoryOnboardingResultV1 } from "../migrations/FactoryOnboardingResultV1.ts";
import { FactoryV1 } from "../migrations/FactoryV1.ts";
import * as FactoryTeamUses from "./teamUses.ts";

const AT = "2026-10-20T00:00:00.000Z";

const result = (teamIds: ReadonlyArray<string>): FactoryOnboardingResult => ({
  purpose: "",
  pickup: { enabled: false, columns: [], labels: [], guidance: "" },
  baseBranch: null,
  rules: [],
  controlPaths: [],
  teamIds,
  concurrencyCap: 2,
});

// A project has one manager, so each manager below has its own.
const TITLES: Record<string, string> = { "project-1": "Satellite", "project-2": "Work API" };

const projectRow = (projectId: string): ProjectRow => ({
  projectId: ProjectId.make(projectId),
  title: TITLES[projectId] ?? "Other",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: AT,
  updatedAt: AT,
  deletedAt: null,
});

const insertManager = (
  id: string,
  projectId: string,
  state: string,
  onboardingResult: FactoryOnboardingResult | null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO factory_managers(id,project_id,name,state,thread_id,
        control_paths_json,onboarding_notes,onboarding_result_json,created_at,updated_at)
      VALUES(${id},${projectId},${id},${state},${`thread-${id}`},'[]','',
        ${onboardingResult === null ? null : JSON.stringify(onboardingResult)},${AT},${AT})`;
  });

const withTeamUses = <A, E>(
  body: (
    teamUses: FactoryTeamUses.FactoryTeamUses["Service"],
  ) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    yield* FactoryV1;
    yield* FactoryOnboardingResultV1;
    yield* FactoryDefinitionsV1;
    const teamUses = yield* FactoryTeamUses.FactoryTeamUses.pipe(
      Effect.provide(
        FactoryTeamUses.layer.pipe(
          Layer.provide(
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: (projectId) => Effect.succeedSome(projectRow(projectId)),
            }),
          ),
        ),
      ),
    );
    return yield* body(teamUses);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

describe("FactoryTeamUses", () => {
  it.effect("names the live managers whose team list includes the team, with their project", () =>
    withTeamUses((teamUses) =>
      Effect.gen(function* () {
        yield* insertManager("Ada", "project-1", "active", result(["web-ui", "standard"]));
        yield* insertManager("Bob", "project-2", "manager-paused", result(["web-ui"]));
        // Retired, so it staffs nothing any more.
        yield* insertManager("Cyd", "project-3", "retired", result(["web-ui"]));
        // No list means every team, so removing one leaves it able to work.
        yield* insertManager("Dee", "project-4", "active", result([]));
        yield* insertManager("Eve", "project-5", "active", result(["standard"]));
        // Still onboarding: no result yet.
        yield* insertManager("Fay", "project-6", "onboarding", null);

        assert.deepStrictEqual(yield* teamUses.read("web-ui"), {
          managers: [
            { managerId: "Ada", name: "Ada", projectTitle: "Satellite" },
            { managerId: "Bob", name: "Bob", projectTitle: "Work API" },
          ],
        });
        assert.deepStrictEqual(yield* teamUses.read("docs"), { managers: [] });
      }),
    ),
  );
});
