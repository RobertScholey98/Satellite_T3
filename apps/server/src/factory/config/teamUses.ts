import {
  FactoryOnboardingResult,
  FactoryOperationError,
  ProjectId,
  type FactoryTeamUses as FactoryTeamUsesResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";

/**
 * Which managers would lose a team if it were removed. Removing stays allowed: this only lets
 * Settings say who is affected.
 */
export class FactoryTeamUses extends Context.Service<
  FactoryTeamUses,
  {
    readonly read: (teamId: string) => Effect.Effect<FactoryTeamUsesResult, FactoryOperationError>;
  }
>()("t3/factory/config/teamUses/FactoryTeamUses") {}

const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(FactoryOnboardingResult));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const projectTitle = (projectId: string) =>
    projects.get(ProjectId.make(projectId), { includeDeleted: true }).pipe(
      Effect.map(Option.match({ onNone: () => projectId, onSome: (project) => project.title })),
      Effect.orElseSucceed(() => projectId),
    );

  const read = Effect.fn("FactoryTeamUses.read")(
    function* (teamId: string) {
      const rows = yield* sql<{
        id: string;
        name: string;
        project_id: string;
        onboarding_result_json: string;
      }>`SELECT id,name,project_id,onboarding_result_json FROM factory_managers
          WHERE state<>'retired' AND onboarding_result_json IS NOT NULL ORDER BY name,id`;
      const managers: Array<FactoryTeamUsesResult["managers"][number]> = [];
      for (const row of rows) {
        // An unreadable result names no team; the warning must not stop the removal it informs.
        const result = decodeResult(row.onboarding_result_json);
        if (Option.isNone(result) || !result.value.teamIds.includes(teamId)) continue;
        managers.push({
          managerId: row.id,
          name: row.name,
          projectTitle: yield* projectTitle(row.project_id),
        });
      }
      return { managers } satisfies FactoryTeamUsesResult;
    },
    Effect.mapError(
      () =>
        new FactoryOperationError({
          reason: "storage",
          message: "Could not read which managers use this team.",
        }),
    ),
  );

  return FactoryTeamUses.of({ read });
});

export const layer = Layer.effect(FactoryTeamUses, make);
