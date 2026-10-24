import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as FactoryConfigStore from "./FactoryConfigStore.ts";
import { retireLegacyRoles } from "./retireLegacyRoles.ts";

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-roles-" });
  const directory = path.join(root, "factory");
  const store = yield* FactoryConfigStore.FactoryConfigStore.pipe(
    Effect.provide(FactoryConfigStore.layerAt(directory)),
  );
  yield* fs.makeDirectory(path.join(directory, "roles"), { recursive: true });
  yield* fs.writeFileString(path.join(directory, "roles", "lead.md"), "Keep PRs small.\n");
  return { fs, path, root, directory, store };
});

/** Warnings logged while `effect` runs, by message. */
const warningsOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const warnings: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(Array.isArray(message) ? message[0] : message));
    });
    const result = yield* effect.pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
    return { result, warnings };
  });

it.layer(NodeServices.layer)("retireLegacyRoles", (it) => {
  it.effect("moves the role files into the next backup once the config exists", () =>
    Effect.gen(function* () {
      const { fs, path, root, directory, store } = yield* setup;
      yield* store.writeSettings({ version: 1, modelPool: [], recoveryAllowance: 1 });

      const { result: moved, warnings } = yield* warningsOf(
        retireLegacyRoles(store, { migratedThisStart: true }),
      );

      assert.strictEqual(moved, path.join(root, "factory-backups", "1", "roles"));
      assert.deepStrictEqual(warnings, []);
      assert.strictEqual(yield* fs.exists(path.join(directory, "roles")), false);
      assert.strictEqual(
        yield* fs.readFileString(path.join(root, "factory-backups", "1", "roles", "lead.md")),
        "Keep PRs small.\n",
      );
      assert.strictEqual(yield* retireLegacyRoles(store, { migratedThisStart: true }), null);
    }),
  );

  it.effect("warns, naming the backup, when this start did not migrate the role text", () =>
    Effect.gen(function* () {
      const { root, path, store } = yield* setup;
      yield* store.writeSettings({ version: 1, modelPool: [], recoveryAllowance: 1 });

      const { result: moved, warnings } = yield* warningsOf(
        retireLegacyRoles(store, { migratedThisStart: false }),
      );

      assert.strictEqual(moved, path.join(root, "factory-backups", "1", "roles"));
      assert.deepStrictEqual(warnings, [
        "factory role files moved to a backup; the factory config was set up without migrating them, so their text may be in no definition",
      ]);
    }),
  );

  it.effect("leaves them while the config is unmigrated, for the next migration", () =>
    Effect.gen(function* () {
      const { fs, path, directory, store } = yield* setup;
      assert.strictEqual(yield* retireLegacyRoles(store, { migratedThisStart: false }), null);
      assert.strictEqual(
        yield* fs.readFileString(path.join(directory, "roles", "lead.md")),
        "Keep PRs small.\n",
      );
    }),
  );
});

/** The real file system, except that moving a `roles` folder fails, as when a file in it is open. */
const renameFails = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      ...fileSystem,
      rename: (oldPath, newPath) =>
        /[\\/]roles$/.test(oldPath)
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Busy",
                module: "FileSystem",
                method: "rename",
                pathOrDescriptor: oldPath,
                description: "The folder is in use.",
              }),
            )
          : fileSystem.rename(oldPath, newPath),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(renameFails)("retireLegacyRoles when the move fails", (it) => {
  it.effect("removes the backup it started, so restarts do not pile them up", () =>
    Effect.gen(function* () {
      const { fs, path, root, directory, store } = yield* setup;
      yield* store.writeSettings({ version: 1, modelPool: [], recoveryAllowance: 1 });

      const failed = yield* retireLegacyRoles(store, { migratedThisStart: true }).pipe(Effect.flip);

      assert.strictEqual(failed.reason, "storage");
      assert.deepStrictEqual(yield* fs.readDirectory(path.join(root, "factory-backups")), []);
      assert.strictEqual(
        yield* fs.readFileString(path.join(directory, "roles", "lead.md")),
        "Keep PRs small.\n",
      );
    }),
  );
});
