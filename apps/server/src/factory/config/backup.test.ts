import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { backupFactoryConfig } from "./backup.ts";

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-backup-" });
  const directory = path.join(root, "factory");
  const write = (relativePath: string, contents: string) => {
    const file = path.join(directory, ...relativePath.split("/"));
    return fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(file, contents)));
  };
  const filesIn = (backup: string) =>
    fs.readDirectory(backup, { recursive: true }).pipe(
      Effect.flatMap((entries) =>
        Effect.filter(entries, (entry) =>
          fs.stat(path.join(backup, entry)).pipe(Effect.map((info) => info.type === "File")),
        ),
      ),
      Effect.map((files) => files.map((file) => file.replaceAll("\\", "/")).toSorted()),
    );
  return { fs, path, root, directory, write, filesIn };
});

it.layer(NodeServices.layer)("backupFactoryConfig", (it) => {
  it.effect(
    "copies everything under the definition folders, byte for byte, to the next numbered folder",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, directory, write, filesIn } = yield* setup;
        yield* write("factory.yaml", "version: 1\n");
        yield* write("workers/reviewer.md", "---\r\nname: Reviewer\r\n---\r\n");
        yield* write("workers/broken.md", "not frontmatter");
        yield* write("leads/default-lead.md", "---\nname: Default lead\n---\n");
        yield* write("teams/web-ui/team.md", "---\nname: Web UI\n---\n");
        yield* write("teams/web-ui/lead.md", "---\nid: default-lead\n---\n");
        yield* write("teams/web-ui/members/reviewer.md", "---\nname: Reviewer\n---\n");
        yield* write("teams/web-ui/notes.txt", "scratch");
        yield* write("teams/stray.md", "not a team");
        yield* write("teams/.hidden/team.md", "hidden");
        yield* write(".git/config", "[core]\n");
        yield* write("roles/implementer.md", "Old role skill.\n");
        yield* write("workers/scratch.txt", "scratch");

        const first = yield* backupFactoryConfig(directory);
        assert.strictEqual(first, path.join(root, "factory-backups", "1"));
        assert.deepStrictEqual(yield* filesIn(first), [
          "factory.yaml",
          "leads/default-lead.md",
          "teams/stray.md",
          "teams/web-ui/lead.md",
          "teams/web-ui/members/reviewer.md",
          "teams/web-ui/notes.txt",
          "teams/web-ui/team.md",
          "workers/broken.md",
          "workers/reviewer.md",
          "workers/scratch.txt",
        ]);
        assert.strictEqual(
          yield* fs.readFileString(path.join(first, "workers", "reviewer.md")),
          "---\r\nname: Reviewer\r\n---\r\n",
        );

        assert.strictEqual(
          yield* backupFactoryConfig(directory),
          path.join(root, "factory-backups", "2"),
        );
      }),
  );

  it.effect("numbers after the highest existing backup and ignores other folders", () =>
    Effect.gen(function* () {
      const { fs, path, root, directory, write } = yield* setup;
      yield* write("factory.yaml", "version: 1\n");
      yield* fs.makeDirectory(path.join(root, "factory-backups", "7"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "factory-backups", "notes"), { recursive: true });

      assert.strictEqual(
        yield* backupFactoryConfig(directory),
        path.join(root, "factory-backups", "8"),
      );
    }),
  );
});
