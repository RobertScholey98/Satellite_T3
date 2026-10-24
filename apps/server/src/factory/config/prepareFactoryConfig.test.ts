import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { FactoryV1 } from "../migrations/FactoryV1.ts";
import * as FactoryConfigStore from "./FactoryConfigStore.ts";
import { prepareFactoryConfig } from "./prepareFactoryConfig.ts";

/** One store for the whole test: the migration failure it holds lives in memory. */
const withStartup = <A, E>(
  body: (
    store: FactoryConfigStore.FactoryConfigStore["Service"],
    directory: string,
  ) => Effect.Effect<
    A,
    E,
    | FactoryConfigStore.FactoryConfigStore
    | ProjectStore.ProjectStoreV2
    | ServerSettings.ServerSettingsService
    | FileSystem.FileSystem
    | Path.Path
    | SqlClient.SqlClient
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    yield* FactoryV1;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-startup-" });
    const directory = path.join(root, "factory");
    return yield* Effect.gen(function* () {
      return yield* body(yield* FactoryConfigStore.FactoryConfigStore, directory);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FactoryConfigStore.layerAt(directory),
          ServerSettings.ServerSettingsService.layerTest({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  );

describe("prepareFactoryConfig", () => {
  it.effect("reports a failed migration on factory.yaml until a start migrates the config", () =>
    withStartup((store) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO factory_config(scope_key,config_json,updated_at)
            VALUES('environment','{not json','2026-10-20T00:00:00.000Z')`;

        yield* prepareFactoryConfig();

        const failure = "The saved factory config could not be read.";
        assert.strictEqual(yield* store.migrationFailure, failure);
        const view = yield* store.read;
        assert.strictEqual(view.configured, false);
        assert.deepStrictEqual(view.problems, [
          {
            path: "factory.yaml",
            message: FactoryConfigStore.unmigratedConfigMessage(failure),
          },
        ]);

        // The next start migrates the repaired row and clears the report.
        yield* sql`UPDATE factory_config SET config_json='{}' WHERE scope_key='environment'`;
        yield* prepareFactoryConfig();
        assert.isNull(yield* store.migrationFailure);
        const migrated = yield* store.read;
        assert.strictEqual(migrated.configured, true);
        assert.deepStrictEqual(migrated.problems, []);
      }),
    ),
  );
});
