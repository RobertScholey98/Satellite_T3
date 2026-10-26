import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Kept apart from the service's constant: a migration records the shape it ran against.
const FACTORY_CONTROL_PATH = ".satellite/factory/";
const DEFAULT_CONCURRENCY_CAP = 2;

// Only the two settings this migration carries over; anything unreadable reads as unset.
const decodeStoredConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      pickupGuidance: Schema.optional(Schema.String),
      concurrencyCap: Schema.optional(Schema.Number),
    }),
  ),
);
const readStored = (text: string | undefined) =>
  text === undefined ? undefined : Option.getOrUndefined(decodeStoredConfig(text));
const decodeControlPaths = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Satellite 103. Managers past onboarding get a result from their approved control paths and
 * their project's pickup guidance and cap, with pickup off so nothing starts unasked. Managers
 * still onboarding re-propose. `control_paths_json` and `onboarding_notes` stay but are unread.
 */
export const FactoryOnboardingResultV1 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE factory_managers ADD COLUMN onboarding_proposal_json TEXT`;
  yield* sql`ALTER TABLE factory_managers ADD COLUMN onboarding_result_json TEXT`;

  const configs = new Map(
    (yield* sql<{ scope_key: string; config_json: string }>`
      SELECT scope_key,config_json FROM factory_config`).map((row) => [
      row.scope_key,
      row.config_json,
    ]),
  );
  const environment = readStored(configs.get("environment"));
  const managers = yield* sql<{
    id: string;
    project_id: string;
    state: string;
    paused_from: string | null;
    control_paths_json: string;
  }>`SELECT id,project_id,state,paused_from,control_paths_json FROM factory_managers`;

  for (const manager of managers) {
    const onboarding =
      manager.state === "onboarding" ||
      ((manager.state === "manager-paused" || manager.state === "project-paused") &&
        manager.paused_from === "onboarding");
    if (onboarding) continue;
    const override = readStored(configs.get(`project:${manager.project_id}`));
    const guidance = override?.pickupGuidance ?? environment?.pickupGuidance;
    const cap = override?.concurrencyCap ?? environment?.concurrencyCap;
    const paths = [
      ...new Set(
        Option.getOrElse(decodeControlPaths(manager.control_paths_json), () => [])
          .map((path) => path.trim())
          .filter((path) => path !== "" && path !== FACTORY_CONTROL_PATH),
      ),
    ];
    const result = {
      purpose: "",
      pickup: {
        enabled: false,
        columns: [],
        labels: [],
        guidance: guidance?.trim() ?? "",
      },
      baseBranch: null,
      rules: [],
      controlPaths: paths.map((path) => ({ path, reason: "" })),
      teamIds: [],
      concurrencyCap: cap ?? DEFAULT_CONCURRENCY_CAP,
    };
    yield* sql`UPDATE factory_managers SET onboarding_result_json=${encodeJson(result)}
      WHERE id=${manager.id}`;
  }

  yield* sql`UPDATE factory_managers SET onboarding_report_json=NULL`;
});
