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

const decodeFactoryConfig = Schema.decodeSync(FactoryConfig);
const liveEnvironment = decodeFactoryConfig({
  concurrencyCap: 3,
  recoveryAllowance: 2,
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
  concurrencyCap: 1,
  recoveryAllowance: 0,
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

  it.effect("prefers the instance an old pool named for a driver, unless it is the default", () =>
    Effect.sync(() => {
      // Read as plain strings, so the expectations can be literals.
      const plan = (modelPool: ReadonlyArray<typeof opus>): Readonly<Record<string, string>> =>
        planFactoryConfigMigration({
          environment: decodeFactoryConfig({ modelPool }),
          projectOverrides: [],
          roleSkills: {},
          driverOf,
        }).instancePreferences;
      // The default Codex instance comes first, so the first other one is the preference.
      assert.deepStrictEqual(plan([opus, gpt, gptWork]), { codex: "codex-work" });
      assert.deepStrictEqual(plan([opus, sonnet, gpt]), {});
      // An instance with no known driver is reported elsewhere and preferred for nothing.
      assert.deepStrictEqual(plan([removed]), {});
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
const encodeOverride = Schema.encodeSync(Schema.fromJsonString(FactoryConfigOverride));

const projectRow = (projectId: ProjectId, title: string): ProjectStore.ProjectRow => ({
  projectId,
  title,
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  deletedAt: null,
});

/** Runs the migration against a store in `directory`, as the server does at startup. */
const migrate = (directory: string, titles: Readonly<Record<string, string>> = {}) =>
  migrateFactoryConfigFromDatabase().pipe(
    Effect.provide(
      Layer.mergeAll(
        FactoryConfigStore.layerAt(directory),
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("codex-work")]: { driver: ProviderDriverKind.make("codex") },
          },
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: (projectId) =>
            titles[projectId] === undefined
              ? Effect.succeedNone
              : Effect.succeedSome(projectRow(projectId, titles[projectId])),
        }),
      ),
    ),
  );

const readStore = (directory: string) =>
  Effect.gen(function* () {
    const store = yield* FactoryConfigStore.FactoryConfigStore;
    return yield* store.read;
  }).pipe(Effect.provide(FactoryConfigStore.layerAt(directory)));

const saveRow = (scopeKey: string, configJson: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO factory_config(scope_key,config_json,updated_at)
        VALUES(${scopeKey},${configJson},'2026-10-20T00:00:00.000Z')`;
  });

const savedRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ scope_key: string; config_json: string }>`
      SELECT scope_key,config_json FROM factory_config ORDER BY scope_key`;
});

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

const docsPreset = {
  id: "preset-docs",
  name: "Docs",
  useWhen: "Docs changes.",
  workflow: "Review the wording.",
  createdBy: "user" as const,
  members: [{ role: "reviewer" as const, count: 1 }],
};

describe("migrateFactoryConfigFromDatabase", () => {
  it.effect("writes the saved config as files and keeps the role files", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        // Rows saved before pickup guidance moved onto the manager still carry it.
        const saved = JSON.stringify({
          ...JSON.parse(encodeConfig(liveEnvironment)),
          pickupGuidance: "Pick up small fixes.",
        });
        yield* saveRow("environment", saved);
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
        // Live briefs still read the role files until they switch to definitions.
        assert.strictEqual(
          yield* fs.readFileString(path.join(directory, "roles", "reviewer.md")),
          "# Our reviewer\n",
        );
        // The row gains which instance the pool's Codex models ran on, and keeps everything else
        // as stored, the retired pickup guidance included: it stays the rollback copy.
        const rows = yield* savedRows;
        assert.deepStrictEqual(
          rows.map((row) => [row.scope_key, JSON.parse(row.config_json)]),
          [["environment", { ...JSON.parse(saved), instancePreferences: { codex: "codex-work" } }]],
        );
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
        yield* saveRow("environment", encodeConfig(liveEnvironment));
        yield* migrate(directory);
        const first = yield* readStore(directory);

        yield* sql`UPDATE factory_config SET config_json=${encodeConfig({ ...liveEnvironment, teamPresets: [] })}`;
        yield* fs.makeDirectory(path.join(directory, "roles"));
        yield* fs.writeFileString(path.join(directory, "roles", "lead.md"), "Changed.");
        yield* migrate(directory);

        assert.deepStrictEqual(yield* readStore(directory), first);
      }),
    ),
  );

  it.effect("finishes a run that stopped before factory.yaml", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* saveRow("environment", encodeConfig(liveEnvironment));
        const clean = yield* fs.makeTempDirectoryScoped();
        yield* migrate(clean);
        const expected = yield* readStore(clean);

        const interrupted = yield* fs.makeTempDirectoryScoped();
        const [implementer, reviewer] = expected.workers;
        yield* Effect.gen(function* () {
          const store = yield* FactoryConfigStore.FactoryConfigStore;
          yield* store.writeWorker(implementer!);
          yield* store.writeWorker({ ...reviewer!, description: "Half-written." });
        }).pipe(Effect.provide(FactoryConfigStore.layerAt(interrupted)));
        assert.strictEqual((yield* readStore(interrupted)).configured, false);

        yield* migrate(interrupted);

        assert.deepStrictEqual(yield* readStore(interrupted), expected);
      }),
    ),
  );

  it.effect("migrates a project's own team when the environment saved nothing", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* saveRow("project:x", encodeOverride({ teamPresets: [docsPreset] }));

        yield* migrate(directory);

        const view = yield* readStore(directory);
        assert.strictEqual(view.configured, true);
        assert.deepStrictEqual(
          view.teams.map((team) => ({
            id: team.id,
            name: team.name,
            members: team.members.map((member) => `${member.count}x ${member.name}`),
          })),
          [{ id: "docs", name: "Docs", members: ["1x Reviewer"] }],
        );
      }),
    ),
  );

  it.effect("keeps a clashing team's name within the limit for a long project title", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* saveRow("environment", encodeConfig(liveEnvironment));
        yield* saveRow(
          "project:x",
          encodeOverride({ teamPresets: [{ ...docsPreset, name: "Standard" }] }),
        );

        yield* migrate(directory, { x: "A".repeat(85) });

        const view = yield* readStore(directory);
        assert.deepStrictEqual(view.problems, []);
        assert.deepStrictEqual(
          view.teams.map((team) => team.name),
          ["Standard", `Standard (${"A".repeat(68)}…)`],
        );
      }),
    ),
  );

  it.effect("fails and writes nothing when the saved config is not JSON", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* saveRow("environment", "{not json");

        const failure = yield* migrate(directory).pipe(Effect.flip);

        assert.deepInclude(failure, {
          reason: "storage",
          message: "The saved factory config could not be read.",
        });
        assert.deepStrictEqual(yield* fs.readDirectory(directory), []);
        assert.deepStrictEqual(yield* savedRows, [
          { scope_key: "environment", config_json: "{not json" },
        ]);
      }),
    ),
  );

  it.effect("fails and writes nothing when a project override does not decode", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* saveRow("environment", encodeConfig(liveEnvironment));
        yield* saveRow("project:x", '{"concurrencyCap":99}');

        const failure = yield* migrate(directory).pipe(Effect.flip);

        assert.deepInclude(failure, {
          reason: "storage",
          message: "The saved factory config of project x could not be read.",
        });
        assert.deepStrictEqual(yield* fs.readDirectory(directory), []);
      }),
    ),
  );

  it.effect("fails and writes nothing when a definition would not load back", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(directory, "roles"));
        yield* fs.writeFileString(
          path.join(directory, "roles", "implementer.md"),
          "x".repeat(20_001),
        );

        const failure = yield* migrate(directory).pipe(Effect.flip);

        assert.deepInclude(failure, { reason: "storage" });
        assert.isTrue(
          failure.message.startsWith(
            "The migrated workers/implementer.md would not load, so nothing was written:",
          ),
        );
        assert.deepStrictEqual(yield* fs.readDirectory(directory), ["roles"]);
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
