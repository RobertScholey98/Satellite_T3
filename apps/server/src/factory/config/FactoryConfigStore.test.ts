import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  FactoryConfigSettings,
  FactoryLeadDefinition,
  FactoryManagerDefinition,
  FactoryTeamDefinition,
  FactoryWorkerDefinition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as FactoryConfigStore from "./FactoryConfigStore.ts";

const WORKER = Schema.decodeSync(FactoryWorkerDefinition)({
  id: "reviewer",
  name: "Reviewer",
  models: { models: [{ driver: "opencode", model: "anthropic/claude-x" }] },
  description: "Reviews the diff.",
});

const LEAD = Schema.decodeSync(FactoryLeadDefinition)({
  id: "default-lead",
  name: "Default lead",
  models: { dynamic: true },
  instructions: "Keep PRs small.",
});

const MANAGER = Schema.decodeSync(FactoryManagerDefinition)({
  id: "default-manager",
  name: "Default manager",
  models: {},
  instructions: "Pick up bugs first.",
});

const TEAM = Schema.decodeSync(FactoryTeamDefinition)({
  id: "web-ui",
  name: "Web UI",
  useWhen: "The ticket changes the web client.",
  workflow: "Implement, then review.",
  lead: LEAD,
  members: [
    { ...WORKER, id: "implementer", name: "Implementer", count: 2 },
    { ...WORKER, count: 1 },
  ],
});

const SETTINGS = Schema.decodeSync(FactoryConfigSettings)({
  version: 1,
  modelPool: [{ driver: "opencode", model: "anthropic/claude-x" }],
});

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-config-" });
  const store = yield* FactoryConfigStore.FactoryConfigStore.pipe(
    Effect.provide(FactoryConfigStore.layerAt(directory)),
  );
  const file = (relativePath: string) => path.join(directory, ...relativePath.split("/"));
  const write = (relativePath: string, contents: string) =>
    fs
      .makeDirectory(path.dirname(file(relativePath)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(file(relativePath), contents)));
  return { fs, store, file, write };
});

it.layer(NodeServices.layer)("FactoryConfigStore", (it) => {
  it.effect("reads an empty directory as unconfigured with default settings", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      assert.deepStrictEqual(yield* store.read, {
        configured: false,
        settings: { version: 1, modelPool: [], recoveryAllowance: 1 },
        workers: [],
        leads: [],
        managers: [],
        teams: [],
        problems: [],
      });
    }),
  );

  it.effect("reads back every kind it wrote", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.writeSettings(SETTINGS);
      yield* store.writeWorker(WORKER);
      yield* store.writeLead(LEAD);
      yield* store.writeManager(MANAGER);
      yield* store.writeTeam(TEAM);

      assert.deepStrictEqual(yield* store.read, {
        configured: true,
        settings: SETTINGS,
        workers: [WORKER],
        leads: [LEAD],
        managers: [MANAGER],
        teams: [TEAM],
        problems: [],
      });
    }),
  );

  it.effect("skips a bad file and still loads the rest", () =>
    Effect.gen(function* () {
      const { store, write } = yield* setup;
      yield* store.writeWorker(WORKER);
      yield* write("workers/broken.md", "---\nname: [unclosed\n---\n");
      yield* write("workers/notes.txt", "not a definition");
      yield* write("factory.yaml", "version: 2\n");

      const view = yield* store.read;
      assert.deepStrictEqual(view.workers, [WORKER]);
      assert.strictEqual(view.configured, true);
      assert.deepStrictEqual(view.settings, { version: 1, modelPool: [], recoveryAllowance: 1 });
      assert.deepStrictEqual(
        view.problems.map((problem) => problem.path),
        ["factory.yaml", "workers/broken.md"],
      );
    }),
  );

  it.effect("reports an entry it cannot read and still loads the rest", () =>
    Effect.gen(function* () {
      const { fs, store, file } = yield* setup;
      yield* store.writeWorker(WORKER);
      yield* fs.makeDirectory(file("workers/notes.md"), { recursive: true });

      const view = yield* store.read;
      assert.deepStrictEqual(view.workers, [WORKER]);
      assert.deepStrictEqual(view.problems, [
        { path: "workers/notes.md", message: "Could not be read." },
      ]);
    }),
  );

  it.effect("reports duplicate member names in a team", () =>
    Effect.gen(function* () {
      const { store, write } = yield* setup;
      yield* store.writeTeam(TEAM);
      yield* write(
        "teams/web-ui/members/second-reviewer.md",
        "---\nname: Reviewer\ncount: 1\n---\n\nAlso reviews.\n",
      );

      const view = yield* store.read;
      assert.deepStrictEqual(view.teams, [TEAM]);
      assert.deepStrictEqual(view.problems, [
        {
          path: "teams/web-ui/members/second-reviewer.md",
          message: 'Another member of this team is named "Reviewer"; a lead delegates by name.',
        },
      ]);
    }),
  );

  it.effect("leaves a file untouched when its bytes would not change", () =>
    Effect.gen(function* () {
      const { fs, store, file } = yield* setup;
      yield* store.writeWorker(WORKER);
      const mtime = Effect.map(fs.stat(file("workers/reviewer.md")), (info) =>
        Option.getOrThrow(info.mtime).getTime(),
      );
      // Seconds since the epoch: 2020-01-01T00:00:00Z.
      yield* fs.utimes(file("workers/reviewer.md"), 1_577_836_800, 1_577_836_800);

      yield* store.writeWorker(WORKER);
      assert.strictEqual(yield* mtime, 1_577_836_800_000);

      yield* store.writeWorker({ ...WORKER, description: "Reviews the whole diff." });
      assert.notStrictEqual(yield* mtime, 1_577_836_800_000);
    }),
  );

  it.effect("writeTeam deletes the files of members no longer in the team", () =>
    Effect.gen(function* () {
      const { fs, store } = yield* setup;
      yield* store.writeTeam(TEAM);
      yield* store.writeTeam({ ...TEAM, members: [TEAM.members[1]!] });

      assert.deepStrictEqual(
        (yield* fs.readDirectory(`${store.directory}/teams/web-ui/members`)).toSorted(),
        ["reviewer.md"],
      );
      assert.deepStrictEqual((yield* store.read).teams, [{ ...TEAM, members: [TEAM.members[1]!] }]);
    }),
  );

  it.effect("ignores dot folders such as .git", () =>
    Effect.gen(function* () {
      const { store, write } = yield* setup;
      yield* store.writeWorker(WORKER);
      yield* write(".git/config", "[core]\n");
      yield* write("workers/.draft.md", "not frontmatter");
      yield* write("teams/.git/team.md", "not frontmatter");

      const view = yield* store.read;
      assert.deepStrictEqual(view.workers, [WORKER]);
      assert.deepStrictEqual(view.teams, []);
      assert.deepStrictEqual(view.problems, []);
    }),
  );

  it.effect("removes a definition, and a team's whole folder", () =>
    Effect.gen(function* () {
      const { fs, store, file } = yield* setup;
      yield* store.writeWorker(WORKER);
      yield* store.writeTeam(TEAM);

      yield* store.remove("worker", WORKER.id);
      yield* store.remove("team", TEAM.id);
      yield* store.remove("lead", "never-written");

      assert.strictEqual(yield* fs.exists(file("workers/reviewer.md")), false);
      assert.strictEqual(yield* fs.exists(file("teams/web-ui")), false);
    }),
  );
});
