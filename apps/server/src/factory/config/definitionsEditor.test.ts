import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_FACTORY_CONFIG,
  FactoryConfig,
  ProviderDriverKind,
  type FactoryDefinitionSaveInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { FactoryV1 } from "../migrations/FactoryV1.ts";
import { DEFAULT_ROLE_SKILLS } from "../roles/index.ts";
import * as FactoryDefinitionsEditor from "./definitionsEditor.ts";
import * as FactoryConfigStore from "./FactoryConfigStore.ts";
import { migrateFactoryConfigFromDatabase } from "./migrateFromDatabase.ts";

const opus = { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" };
const codex = { driver: ProviderDriverKind.make("codex"), model: "gpt-5.5" };

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-editor-" });
  const editor = yield* FactoryDefinitionsEditor.FactoryDefinitionsEditor.pipe(
    Effect.provide(
      FactoryDefinitionsEditor.layer.pipe(Layer.provide(FactoryConfigStore.layerAt(directory))),
    ),
  );
  yield* editor.saveSettings({ version: 1, modelPool: [opus], recoveryAllowance: 1 });
  return editor;
});

const reviewer = (name: string): FactoryDefinitionSaveInput => ({
  kind: "worker",
  definition: {
    name,
    models: { dynamic: false, models: [opus] },
    description: "Reviews the diff.",
  },
});

const lead = {
  id: "default",
  name: "Default lead",
  models: { dynamic: true, models: [opus] },
  instructions: "",
};

const member = (name: string, models = [opus]) => ({
  name,
  count: 1,
  models: { dynamic: false, models },
  description: `${name} brief.`,
});

const team = (members: ReadonlyArray<ReturnType<typeof member>>): FactoryDefinitionSaveInput => ({
  kind: "team",
  definition: {
    name: "Web UI",
    useWhen: "The ticket changes the web client.",
    workflow: "Implement, then review.",
    mayEditProtectedPaths: false,
    createdBy: "user",
    lead,
    members,
  },
});

it.layer(NodeServices.layer)("FactoryDefinitionsEditor", (it) => {
  it.effect("creates a definition with an id from its name, never reusing one", () =>
    Effect.gen(function* () {
      const editor = yield* setup;
      const first = yield* editor.save(reviewer("Code Reviewer"));
      const second = yield* editor.save(reviewer("Code Reviewer"));

      assert.strictEqual(first.id, "code-reviewer");
      assert.strictEqual(second.id, "code-reviewer-2");
      assert.deepStrictEqual(
        second.view.workers.map((worker) => [worker.id, worker.name]).toSorted(),
        [
          ["code-reviewer", "Code Reviewer"],
          ["code-reviewer-2", "Code Reviewer"],
        ],
      );
    }),
  );

  it.effect("keeps the id when a definition is renamed", () =>
    Effect.gen(function* () {
      const editor = yield* setup;
      const { id } = yield* editor.save(reviewer("Code Reviewer"));
      const renamed = yield* editor.save({ ...reviewer("Strict Reviewer"), id });

      assert.strictEqual(renamed.id, "code-reviewer");
      assert.deepStrictEqual(
        renamed.view.workers.map((worker) => [worker.id, worker.name]),
        [["code-reviewer", "Strict Reviewer"]],
      );
    }),
  );

  it.effect("refuses a model the pool lacks, but lets the pool drop a model in use", () =>
    Effect.gen(function* () {
      const editor = yield* setup;
      const refused = yield* editor
        .save(team([member("Implementer"), member("Reviewer", [codex])]))
        .pipe(Effect.flip);
      assert.deepInclude(refused, {
        reason: "invalid",
        message:
          'codex/gpt-5.5 is not in the model pool. Add it to the pool first, or remove it from the member "Reviewer".',
      });

      yield* editor.save(reviewer("Code Reviewer"));
      const view = yield* editor.saveSettings({ version: 1, modelPool: [], recoveryAllowance: 1 });
      assert.deepStrictEqual(view.settings.modelPool, []);
      assert.deepStrictEqual(view.workers[0]?.models.models, [opus]);
    }),
  );

  it.effect("refuses two members with one name and names new members' files", () =>
    Effect.gen(function* () {
      const editor = yield* setup;
      const refused = yield* editor
        .save(team([member("Reviewer"), member("Reviewer")]))
        .pipe(Effect.flip);
      assert.deepInclude(refused, {
        reason: "invalid",
        message: 'Two members are named "Reviewer". Give each member its own name.',
      });

      const saved = yield* editor.save(team([member("Implementer"), member("Senior Reviewer")]));
      assert.strictEqual(saved.id, "web-ui");
      assert.deepStrictEqual(
        saved.view.teams[0]?.members.map((saved) => [saved.id, saved.name]),
        [
          ["implementer", "Implementer"],
          ["senior-reviewer", "Senior Reviewer"],
        ],
      );
    }),
  );

  it.effect("refuses member names that differ only in case, since a lead delegates by name", () =>
    Effect.gen(function* () {
      const editor = yield* setup;
      const refused = yield* editor
        .save(team([member("Reviewer"), member("reviewer")]))
        .pipe(Effect.flip);
      assert.deepInclude(refused, {
        reason: "invalid",
        message: 'Two members are named "reviewer". Give each member its own name.',
      });
      assert.deepStrictEqual((yield* editor.remove({ kind: "team", id: "web-ui" })).teams, []);
    }),
  );

  it.effect("removes a definition", () =>
    Effect.gen(function* () {
      const editor = yield* setup;
      const { id } = yield* editor.save(reviewer("Code Reviewer"));
      const view = yield* editor.remove({ kind: "worker", id });
      assert.deepStrictEqual(view.workers, []);
    }),
  );
});

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(FactoryConfig));

it.effect("a save on an unconfigured store is never migrated over at the next startup", () =>
  Effect.gen(function* () {
    yield* FactoryV1;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-editor-" });
    const storeLayer = FactoryConfigStore.layerAt(directory);
    const editor = yield* FactoryDefinitionsEditor.FactoryDefinitionsEditor.pipe(
      Effect.provide(FactoryDefinitionsEditor.layer.pipe(Layer.provide(storeLayer))),
    );
    const saved = yield* editor.save({
      kind: "worker",
      definition: {
        name: "Code Reviewer",
        models: { dynamic: false, models: [] },
        description: "Reviews the diff.",
      },
    });
    assert.strictEqual(saved.view.configured, true);
    const workerFile = path.join(directory, "workers", "code-reviewer.md");
    const before = yield* fs.readFileString(workerFile);

    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO factory_config(scope_key,config_json,updated_at)
        VALUES('environment',${encodeConfig(DEFAULT_FACTORY_CONFIG)},'2026-10-20T00:00:00.000Z')`;
    yield* migrateFactoryConfigFromDatabase().pipe(
      Effect.provide(
        Layer.mergeAll(
          storeLayer,
          ServerSettings.ServerSettingsService.layerTest({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
        ),
      ),
    );

    assert.strictEqual(yield* fs.readFileString(workerFile), before);
    const entries = yield* fs.readDirectory(directory, { recursive: true });
    const files = yield* Effect.filter(entries, (entry) =>
      fs.stat(path.join(directory, entry)).pipe(Effect.map((info) => info.type === "File")),
    );
    assert.deepStrictEqual(files.map((file) => file.replaceAll("\\", "/")).toSorted(), [
      "factory.yaml",
      "workers/code-reviewer.md",
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
);

it.layer(NodeServices.layer)("FactoryDefinitionsEditor starter set", (it) => {
  it.effect("writes the starter set on an empty config, then refuses a second one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-starter-" });
      const editor = yield* FactoryDefinitionsEditor.FactoryDefinitionsEditor.pipe(
        Effect.provide(
          FactoryDefinitionsEditor.layer.pipe(Layer.provide(FactoryConfigStore.layerAt(directory))),
        ),
      );

      const view = yield* editor.createStarter([opus, codex]);

      const pool = { dynamic: true, models: [] };
      const lead = { id: "default", name: "Default lead", models: pool, instructions: "" };
      const workers = (["implementer", "reviewer", "verifier"] as const).map((role) => ({
        id: role,
        name: `${role[0]!.toUpperCase()}${role.slice(1)}`,
        models: pool,
        description: DEFAULT_ROLE_SKILLS[role].trim(),
      }));
      assert.deepStrictEqual(view, {
        configured: true,
        settings: { version: 1, modelPool: [opus, codex], recoveryAllowance: 1 },
        workers,
        leads: [lead],
        managers: [
          {
            id: "default",
            name: "Default manager",
            models: { dynamic: false, models: [] },
            instructions: "",
          },
        ],
        teams: [
          {
            id: "standard",
            name: "Standard",
            useWhen: "Most tickets",
            workflow:
              "The implementer builds the change, the reviewer reviews the pull request, and the verifier checks the result against the ticket before the lead claims it done.",
            mayEditProtectedPaths: false,
            createdBy: "user",
            lead,
            members: workers.map((worker) => ({ ...worker, count: 1 })),
          },
        ],
        problems: [],
      });

      const again = yield* editor.createStarter([opus]).pipe(Effect.flip);
      assert.deepInclude(again, {
        reason: "conflict",
        message: "The factory config already exists.",
      });
    }),
  );
});
