import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  FactoryConfig,
  FactoryConfigOverride,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { FactoryV1 } from "../migrations/FactoryV1.ts";
import { DEFAULT_ROLE_SKILLS } from "../roles/index.ts";
import * as FactoryConfigStore from "./FactoryConfigStore.ts";
import {
  migrateFactoryConfigFromDatabase,
  planFactoryConfigMigration,
} from "./migrateFromDatabase.ts";

const DRIVERS: Record<string, string> = {
  claudeAgent: "claudeAgent",
  codex: "codex",
  "codex-work": "codex",
};
const driverOf = (instanceId: string) =>
  DRIVERS[instanceId] === undefined ? null : ProviderDriverKind.make(DRIVERS[instanceId]);

const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const sonnet = { instanceId: "claudeAgent", model: "claude-sonnet-5-5" };
const gpt = { instanceId: "codex", model: "gpt-5.5" };
const gptWork = { instanceId: "codex-work", model: "gpt-5.5" };
const removed = { instanceId: "removed-instance", model: "old-model" };

const liveEnvironment = Schema.decodeSync(FactoryConfig)({
  pickupGuidance: "Pick up small fixes.",
  concurrencyCap: 3,
  recoveryAllowance: 2,
  digestIntervalMinutes: 15,
  modelPool: [opus, gptWork, sonnet, gpt, removed],
  roleModels: {
    manager: opus,
    lead: { small: gptWork, medium: null, large: opus },
    workers: { implementer: [gptWork, gpt], reviewer: [opus], verifier: [] },
  },
  teamPresets: [
    {
      id: "preset-standard",
      name: "Standard",
      useWhen: "Most tickets.",
      workflow: "Implement, then review, then verify.",
      createdBy: "user",
      members: [
        { role: "implementer", count: 1 },
        { role: "reviewer", count: 1, models: [sonnet] },
        { role: "verifier", count: 1 },
      ],
    },
  ],
});

const projectId = ProjectId.make("project-satellite");
const override = Schema.decodeSync(FactoryConfigOverride)({
  pickupGuidance: "Only docs.",
  concurrencyCap: 1,
  recoveryAllowance: 0,
  digestIntervalMinutes: 30,
  modelPool: [opus],
  roleModels: { manager: opus, workers: { implementer: [opus] } },
  teamPresets: [
    {
      id: "preset-own-standard",
      name: "Standard",
      useWhen: "Satellite tickets.",
      workflow: "Implement only.",
      createdBy: "manager",
      members: [{ role: "implementer", count: 2 }],
    },
    {
      id: "preset-docs",
      name: "Docs",
      useWhen: "Docs changes.",
      workflow: "",
      createdBy: "user",
      members: [{ role: "reviewer", count: 1 }],
    },
  ],
});

const POOL = { dynamic: true, models: [] };
const claudeRef = (model: string) => ({ driver: ProviderDriverKind.make("claudeAgent"), model });
const codexRef = { driver: ProviderDriverKind.make("codex"), model: "gpt-5.5" };

describe("planFactoryConfigMigration", () => {
  it.effect("maps the environment config to starter definitions and a team of copies", () =>
    Effect.sync(() => {
      const plan = planFactoryConfigMigration({
        environment: liveEnvironment,
        projectOverrides: [],
        roleSkills: { reviewer: "# Our reviewer\n\nReview hard.\n", lead: "# Lead notes\n" },
        driverOf,
      });
      const implementer = {
        id: "implementer",
        name: "Implementer",
        models: { dynamic: true, models: [codexRef] },
        description: DEFAULT_ROLE_SKILLS.implementer.trim(),
      };
      const reviewer = {
        id: "reviewer",
        name: "Reviewer",
        models: { dynamic: true, models: [claudeRef("claude-opus-5-5")] },
        description: "# Our reviewer\n\nReview hard.",
      };
      const verifier = {
        id: "verifier",
        name: "Verifier",
        models: POOL,
        description: DEFAULT_ROLE_SKILLS.verifier.trim(),
      };
      const lead = {
        id: "default",
        name: "Default lead",
        models: { dynamic: true, models: [codexRef, claudeRef("claude-opus-5-5")] },
        instructions: "# Lead notes",
      };
      assert.deepStrictEqual(plan.definitions, {
        settings: {
          version: 1,
          modelPool: [claudeRef("claude-opus-5-5"), codexRef, claudeRef("claude-sonnet-5-5")],
          recoveryAllowance: 2,
        },
        workers: [implementer, reviewer, verifier],
        leads: [lead],
        managers: [
          {
            id: "default",
            name: "Default manager",
            models: { dynamic: false, models: [claudeRef("claude-opus-5-5")] },
            instructions: "",
          },
        ],
        teams: [
          {
            id: "standard",
            name: "Standard",
            useWhen: "Most tickets.",
            workflow: "Implement, then review, then verify.",
            mayEditProtectedPaths: false,
            createdBy: "user",
            lead,
            members: [
              { ...implementer, count: 1 },
              {
                ...reviewer,
                models: { dynamic: true, models: [claudeRef("claude-sonnet-5-5")] },
                count: 1,
              },
              { ...verifier, count: 1 },
            ],
          },
        ],
      });
      assert.deepStrictEqual(plan.notCarriedOver, [
        { projectId: null, key: "modelPool", value: removed },
      ]);
    }),
  );

  it.effect("suffixes a clashing project team and reports overrides with no new home", () =>
    Effect.sync(() => {
      const plan = planFactoryConfigMigration({
        environment: liveEnvironment,
        projectOverrides: [{ projectId, title: "Satellite", override }],
        roleSkills: {},
        driverOf,
      });
      assert.deepStrictEqual(
        plan.definitions.teams.map((team) => ({
          id: team.id,
          name: team.name,
          createdBy: team.createdBy,
          members: team.members.map((member) => `${member.count}x ${member.id}`),
        })),
        [
          {
            id: "standard",
            name: "Standard",
            createdBy: "user",
            members: ["1x implementer", "1x reviewer", "1x verifier"],
          },
          {
            id: "standard-satellite",
            name: "Standard (Satellite)",
            createdBy: "manager",
            members: ["2x implementer"],
          },
          { id: "docs", name: "Docs", createdBy: "user", members: ["1x reviewer"] },
        ],
      );
      assert.deepStrictEqual(plan.notCarriedOver, [
        { projectId: null, key: "modelPool", value: removed },
        { projectId, key: "modelPool", value: override.modelPool },
        { projectId, key: "roleModels.workers", value: override.roleModels?.workers },
        { projectId, key: "recoveryAllowance", value: 0 },
        { projectId, key: "digestIntervalMinutes", value: 30 },
      ]);
    }),
  );

  it.effect("plans starter definitions from role files alone when no config was saved", () =>
    Effect.sync(() => {
      const plan = planFactoryConfigMigration({
        environment: null,
        projectOverrides: [],
        roleSkills: { manager: "Escalate early." },
        driverOf,
      });
      assert.deepStrictEqual(plan.definitions.settings, {
        version: 1,
        modelPool: [],
        recoveryAllowance: 1,
      });
      assert.deepStrictEqual(
        plan.definitions.workers.map((worker) => [worker.id, worker.models]),
        [
          ["implementer", POOL],
          ["reviewer", POOL],
          ["verifier", POOL],
        ],
      );
      assert.deepStrictEqual(plan.definitions.managers, [
        {
          id: "default",
          name: "Default manager",
          models: { dynamic: false, models: [] },
          instructions: "Escalate early.",
        },
      ]);
      assert.deepStrictEqual(plan.definitions.teams, []);
      assert.deepStrictEqual(plan.notCarriedOver, []);
    }),
  );
});

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(FactoryConfig));

/** Runs the migration against a store in `directory`, as the server does at startup. */
const migrate = (directory: string) =>
  migrateFactoryConfigFromDatabase().pipe(
    Effect.provide(
      Layer.mergeAll(
        FactoryConfigStore.layerAt(directory),
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("codex-work")]: { driver: ProviderDriverKind.make("codex") },
          },
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
      ),
    ),
  );

const readStore = (directory: string) =>
  Effect.gen(function* () {
    const store = yield* FactoryConfigStore.FactoryConfigStore;
    return yield* store.read;
  }).pipe(Effect.provide(FactoryConfigStore.layerAt(directory)));

const withEnvironment = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | SqlClient.SqlClient | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    yield* FactoryV1;
    return yield* effect;
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  );

describe("migrateFactoryConfigFromDatabase", () => {
  it.effect("writes the saved config as files and removes the retired role files", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* fs.makeTempDirectoryScoped();
        const saved = encodeConfig(liveEnvironment);
        yield* sql`INSERT INTO factory_config(scope_key,config_json,updated_at)
            VALUES('environment',${saved},'2026-10-20T00:00:00.000Z')`;
        yield* fs.makeDirectory(path.join(directory, "roles"));
        yield* fs.writeFileString(path.join(directory, "roles", "reviewer.md"), "# Our reviewer\n");

        yield* migrate(directory);

        const view = yield* readStore(directory);
        assert.strictEqual(view.configured, true);
        assert.deepStrictEqual(view.problems, []);
        assert.deepStrictEqual(view.settings, {
          version: 1,
          modelPool: [claudeRef("claude-opus-5-5"), codexRef, claudeRef("claude-sonnet-5-5")],
          recoveryAllowance: 2,
        });
        assert.deepStrictEqual(
          view.workers.map((worker) => [worker.id, worker.description.split("\n")[0]]),
          [
            ["implementer", "# Implementer"],
            ["reviewer", "# Our reviewer"],
            ["verifier", "# Verifier"],
          ],
        );
        assert.deepStrictEqual(
          view.teams.map((team) => [team.id, team.members.map((member) => member.id)]),
          [["standard", ["implementer", "reviewer", "verifier"]]],
        );
        assert.strictEqual(yield* fs.exists(path.join(directory, "roles")), false);
        const rows = yield* sql<{ config_json: string }>`SELECT config_json FROM factory_config`;
        assert.deepStrictEqual(rows, [{ config_json: saved }]);
      }),
    ),
  );

  it.effect("does nothing once factory.yaml exists", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* sql`INSERT INTO factory_config(scope_key,config_json,updated_at)
            VALUES('environment',${encodeConfig(liveEnvironment)},'2026-10-20T00:00:00.000Z')`;
        yield* migrate(directory);
        const first = yield* readStore(directory);

        yield* sql`UPDATE factory_config SET config_json=${encodeConfig({ ...liveEnvironment, teamPresets: [] })}`;
        yield* fs.makeDirectory(path.join(directory, "roles"));
        yield* fs.writeFileString(path.join(directory, "roles", "lead.md"), "Changed.");
        yield* migrate(directory);

        assert.deepStrictEqual(yield* readStore(directory), first);
        assert.strictEqual(
          yield* fs.readFileString(path.join(directory, "roles", "lead.md")),
          "Changed.",
        );
      }),
    ),
  );

  it.effect("writes nothing with no saved config and no role files", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* migrate(directory);
        assert.deepStrictEqual(yield* fs.readDirectory(directory), []);
      }),
    ),
  );
});
