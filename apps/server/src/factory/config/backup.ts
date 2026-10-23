import { FactoryOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { FACTORY_SETTINGS_FILE } from "./definitionFiles.ts";

/** Beside the config directory, so a backup is never part of the config or its repo. */
const FACTORY_BACKUPS_DIRECTORY = "factory-backups";

const DEFINITION_FOLDERS = ["workers", "leads", "managers", "teams"] as const;

const storageError = (action: string) =>
  new FactoryOperationError({
    reason: "storage",
    message: `Could not ${action} while backing up the factory config.`,
  });

/**
 * Copies the config's definition files to `<parent>/factory-backups/<n>/`, where n is the next free
 * integer, and returns that directory. Files are copied byte for byte, so one that no longer decodes
 * is kept. Everything under the definition folders is copied, scratch files included, because
 * replacing a config clears those folders whole; `.git`, `roles/` and dotfiles are not.
 */
export const backupFactoryConfig = Effect.fn("FactoryConfigBackup.backup")(function* (
  configDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = (relativePath: string) => path.join(configDirectory, ...relativePath.split("/"));

  const visibleNames = (relativePath: string) =>
    fs.readDirectory(absolute(relativePath)).pipe(
      Effect.map((names) => names.filter((name) => !name.startsWith(".")).toSorted()),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(() => storageError(`list ${relativePath}`)),
    );
  const existing = (relativePaths: ReadonlyArray<string>) =>
    Effect.filter(relativePaths, (relativePath) =>
      fs.exists(absolute(relativePath)).pipe(Effect.mapError(() => storageError("read"))),
    );
  // Untraced: a recursive walk inside the backup's own span, one call per folder.
  const filesUnder: (
    relativePath: string,
  ) => Effect.Effect<ReadonlyArray<string>, FactoryOperationError> = Effect.fnUntraced(function* (
    relativePath: string,
  ) {
    const found: string[] = [];
    for (const name of yield* visibleNames(relativePath)) {
      const child = `${relativePath}/${name}`;
      const info = yield* fs
        .stat(absolute(child))
        .pipe(Effect.mapError(() => storageError(`read ${child}`)));
      if (info.type === "Directory") found.push(...(yield* filesUnder(child)));
      else if (info.type === "File") found.push(child);
    }
    return found;
  });

  const files: string[] = [...(yield* existing([FACTORY_SETTINGS_FILE]))];
  for (const folder of DEFINITION_FOLDERS) files.push(...(yield* filesUnder(folder)));

  const backupsDirectory = path.join(path.dirname(configDirectory), FACTORY_BACKUPS_DIRECTORY);
  yield* fs
    .makeDirectory(backupsDirectory, { recursive: true })
    .pipe(Effect.mapError(() => storageError("create the backups directory")));
  const taken = (yield* fs
    .readDirectory(backupsDirectory)
    .pipe(Effect.mapError(() => storageError("list the backups directory"))))
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
  // Creating the numbered folder claims it, so two backups at once never share a number.
  let number = Math.max(0, ...taken) + 1;
  let backupDirectory = path.join(backupsDirectory, String(number));
  while (
    yield* fs.makeDirectory(backupDirectory).pipe(
      Effect.as(false),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(true)),
      Effect.mapError(() => storageError("create the backup directory")),
    )
  ) {
    number += 1;
    backupDirectory = path.join(backupsDirectory, String(number));
  }

  for (const relativePath of files) {
    const target = path.join(backupDirectory, ...relativePath.split("/"));
    yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
      Effect.andThen(fs.copyFile(absolute(relativePath), target)),
      Effect.mapError(() => storageError(`copy ${relativePath}`)),
    );
  }
  return backupDirectory;
});
