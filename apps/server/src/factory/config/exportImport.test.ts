import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  FactoryDefinitions,
  FactoryImportDecision,
  FactoryModelRef,
  type FactoryConfigBundle,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { buildExportBundle, applyImport, planImport, previewImport } from "./exportImport.ts";
import * as FactoryConfigStore from "./FactoryConfigStore.ts";

const decodeDefinitions = Schema.decodeSync(FactoryDefinitions);
const decision = Schema.decodeSync(FactoryImportDecision);
const model = Schema.decodeSync(FactoryModelRef);

const OPUS = model({ driver: "claudeAgent", model: "claude-opus-5-5" });
const GPT = model({ driver: "codex", model: "gpt-6" });
const CLAUDE_X = model({ driver: "opencode", model: "anthropic/claude-x" });
const GROK = model({ driver: "grok", model: "grok-5" });

const worker = (
  id: string,
  name: string,
  ref: FactoryModelRef,
  description = `${name} works.`,
) => ({
  id,
  name,
  models: { models: [ref] },
  description,
});

const LOCAL_INPUT = {
  settings: { version: 1 as const, modelPool: [OPUS, GPT, CLAUDE_X], recoveryAllowance: 2 },
  workers: [
    worker("docs", "Docs", CLAUDE_X),
    worker("implementer", "Implementer", GPT),
    worker("reviewer", "Reviewer", OPUS),
  ],
  leads: [
    { id: "default-lead", name: "Default lead", models: { models: [OPUS] }, instructions: "Lead." },
  ],
  managers: [
    {
      id: "default-manager",
      name: "Default manager",
      models: { models: [CLAUDE_X] },
      instructions: "Manage.",
    },
  ],
  teams: [
    {
      id: "web-ui",
      name: "Web UI",
      useWhen: "Web client work.",
      workflow: "Implement, then review.",
      lead: {
        id: "default-lead",
        name: "Default lead",
        models: { models: [OPUS] },
        instructions: "Lead.",
      },
      members: [
        { ...worker("implementer", "Implementer", GPT), count: 2 },
        { ...worker("reviewer", "Reviewer", OPUS), count: 1 },
      ],
    },
  ],
};
const LOCAL = decodeDefinitions(LOCAL_INPUT);

/** The other machine: implementer and both protocol definitions edited, a new worker and model. */
const REMOTE = decodeDefinitions({
  ...LOCAL_INPUT,
  settings: { version: 1 as const, modelPool: [OPUS, GPT, CLAUDE_X, GROK], recoveryAllowance: 4 },
  workers: [
    worker("implementer", "Implementer", GPT, "Implements carefully."),
    worker("reviewer", "Reviewer", OPUS),
    worker("tester", "Tester", GROK),
  ],
  leads: [{ ...LOCAL_INPUT.leads[0]!, instructions: "Lead with tests." }],
  managers: [{ ...LOCAL_INPUT.managers[0]!, instructions: "Manage closely." }],
});

const bundleOf = (definitions: FactoryDefinitions) =>
  Result.getOrThrow(buildExportBundle(definitions, { scope: "all" }));

const paths = (bundle: FactoryConfigBundle) => bundle.files.map((file) => file.path);

const ALL_PATHS = [
  "factory.yaml",
  "workers/docs.md",
  "workers/implementer.md",
  "workers/reviewer.md",
  "leads/default-lead.md",
  "managers/default-manager.md",
  "teams/web-ui/team.md",
  "teams/web-ui/lead.md",
  "teams/web-ui/members/implementer.md",
  "teams/web-ui/members/reviewer.md",
];

const withStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-import-" });
  const directory = path.join(root, "factory");
  const store = yield* FactoryConfigStore.FactoryConfigStore.pipe(
    Effect.provide(FactoryConfigStore.layerAt(directory)),
  );
  const write = (relativePath: string, contents: string) => {
    const file = path.join(directory, ...relativePath.split("/"));
    return fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(file, contents)));
  };
  const seed = Effect.gen(function* () {
    yield* store.writeSettings(LOCAL.settings);
    for (const definition of LOCAL.workers) yield* store.writeWorker(definition);
    for (const definition of LOCAL.leads) yield* store.writeLead(definition);
    for (const definition of LOCAL.managers) yield* store.writeManager(definition);
    for (const team of LOCAL.teams) yield* store.writeTeam(team);
  });
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(FactoryConfigStore.FactoryConfigStore, store));
  return { fs, path, root, store, write, seed, run };
});

it.layer(NodeServices.layer)("factory config export and import", (it) => {
  it.effect(
    "exports selected teams with the workers and leads they copy, and a narrowed pool",
    () =>
      Effect.sync(() => {
        const bundle = Result.getOrThrow(
          buildExportBundle(LOCAL, { scope: "teams", teamIds: ["web-ui"] }),
        );
        assert.deepStrictEqual(paths(bundle), [
          "factory.yaml",
          "workers/implementer.md",
          "workers/reviewer.md",
          "leads/default-lead.md",
          "teams/web-ui/team.md",
          "teams/web-ui/lead.md",
          "teams/web-ui/members/implementer.md",
          "teams/web-ui/members/reviewer.md",
        ]);
        assert.strictEqual(
          bundle.files[0]!.contents,
          [
            "version: 1",
            "modelPool:",
            "  - model: claudeAgent/claude-opus-5-5",
            "  - model: codex/gpt-6",
            "recoveryAllowance: 2",
            "",
          ].join("\n"),
        );
        const missing = buildExportBundle(LOCAL, { scope: "teams", teamIds: ["missing"] });
        assert.strictEqual(
          Result.isFailure(missing) && missing.failure.message,
          'No team "missing".',
        );
      }),
  );

  it.effect("never exports .git, roles/ or unknown files that sit in the directory", () =>
    Effect.gen(function* () {
      const { store, write, seed } = yield* withStore;
      yield* seed;
      yield* write(".git/config", "[core]\n");
      yield* write("roles/implementer.md", "Old role skill.\n");
      yield* write("notes.txt", "scratch\n");
      yield* write("workers/scratch.txt", "scratch\n");

      const bundle = Result.getOrThrow(buildExportBundle(yield* store.read, { scope: "all" }));
      assert.deepStrictEqual(paths(bundle), ALL_PATHS);
    }),
  );

  it.effect("previews each definition as new, same or differs, with pool additions apart", () =>
    Effect.sync(() => {
      const bundle = bundleOf(REMOTE);
      const preview = previewImport(LOCAL, {
        files: [...bundle.files, { path: "workers/broken.md", contents: "no frontmatter" }],
      });
      assert.deepStrictEqual(preview, {
        items: [
          { kind: "worker", id: "implementer", name: "Implementer", status: "differs" },
          { kind: "worker", id: "reviewer", name: "Reviewer", status: "same" },
          {
            kind: "worker",
            id: "tester",
            name: "Tester",
            status: "new",
            modelsNeedingPool: [GROK],
            skippedUnlessPoolAdded: true,
          },
          { kind: "lead", id: "default-lead", name: "Default lead", status: "differs" },
          { kind: "manager", id: "default-manager", name: "Default manager", status: "differs" },
          { kind: "team", id: "web-ui", name: "Web UI", status: "same" },
        ],
        poolAdditions: [GROK],
        recoveryAllowance: { mine: 2, theirs: 4 },
        problems: [
          { path: "workers/broken.md", message: "Expected YAML frontmatter between --- lines." },
        ],
      });
    }),
  );

  it.effect("merges new definitions and applies each choice for those that differ", () =>
    Effect.gen(function* () {
      const { fs, path, root, store, seed, run } = yield* withStore;
      yield* seed;
      const before = yield* fs.readFileString(
        path.join(root, "factory", "workers", "implementer.md"),
      );
      const view = yield* run(
        applyImport(
          bundleOf(REMOTE),
          decision({
            mode: "merge",
            poolAdditions: [GROK],
            choices: [
              { kind: "worker", id: "implementer", choice: "theirs" },
              { kind: "lead", id: "default-lead", choice: "both" },
              { kind: "manager", id: "default-manager", choice: "mine" },
            ],
          }),
        ),
      );

      assert.deepStrictEqual(
        view.workers.map((definition) => [definition.id, definition.description]),
        [
          ["docs", "Docs works."],
          ["implementer", "Implements carefully."],
          ["reviewer", "Reviewer works."],
          ["tester", "Tester works."],
        ],
      );
      assert.deepStrictEqual(
        view.leads.map((definition) => [definition.id, definition.name, definition.instructions]),
        [
          ["default-lead-imported", "Default lead (imported)", "Lead with tests."],
          ["default-lead", "Default lead", "Lead."],
        ],
      );
      assert.deepStrictEqual(view.managers, LOCAL.managers);
      assert.deepStrictEqual(view.settings, {
        ...LOCAL.settings,
        modelPool: [...LOCAL.settings.modelPool, GROK],
      });
      assert.deepStrictEqual((yield* store.read).problems, []);
      // Taking theirs overwrote implementer, so the merge backed up first.
      assert.strictEqual(
        yield* fs.readFileString(
          path.join(root, "factory-backups", "1", "workers", "implementer.md"),
        ),
        before,
      );
    }),
  );

  it.effect("a merge that only adds definitions makes no backup", () =>
    Effect.gen(function* () {
      const { fs, path, root, seed, run } = yield* withStore;
      yield* seed;
      const view = yield* run(
        applyImport(
          bundleOf(
            decodeDefinitions({
              ...LOCAL_INPUT,
              workers: [...LOCAL_INPUT.workers, worker("tester", "Tester", GPT)],
            }),
          ),
          decision({ mode: "merge" }),
        ),
      );
      assert.deepStrictEqual(
        view.workers.map((definition) => definition.id),
        ["docs", "implementer", "reviewer", "tester"],
      );
      assert.strictEqual(yield* fs.exists(path.join(root, "factory-backups")), false);
    }),
  );

  it.effect("backs up before a new definition replaces a local file that did not decode", () =>
    Effect.gen(function* () {
      const { fs, path, root, seed, write, run } = yield* withStore;
      yield* seed;
      yield* write("workers/tester.md", "a hand edit that lost its frontmatter");
      yield* run(applyImport(bundleOf(REMOTE), decision({ mode: "merge", poolAdditions: [GROK] })));
      assert.strictEqual(
        yield* fs.readFileString(path.join(root, "factory-backups", "1", "workers", "tester.md")),
        "a hand edit that lost its frontmatter",
      );
    }),
  );

  it.effect("drops a declined pool addition from every imported model list", () =>
    Effect.gen(function* () {
      const { seed, run } = yield* withStore;
      yield* seed;
      const qa = decodeDefinitions({
        ...LOCAL_INPUT,
        settings: { version: 1 as const, modelPool: [OPUS, GPT, GROK] },
        teams: [
          {
            ...LOCAL_INPUT.teams[0]!,
            id: "qa",
            name: "QA",
            lead: { ...LOCAL_INPUT.teams[0]!.lead, models: { models: [GROK, OPUS] } },
            members: [
              { ...worker("tester", "Tester", GROK), models: { models: [GROK, GPT] }, count: 1 },
            ],
          },
        ],
      });
      const bundle = bundleOf(qa);
      assert.deepStrictEqual(
        previewImport(LOCAL, bundle).items.find((item) => item.id === "qa"),
        { kind: "team", id: "qa", name: "QA", status: "new", modelsNeedingPool: [GROK] },
      );

      const declined = yield* run(applyImport(bundle, decision({ mode: "merge" })));
      const team = declined.teams.find((candidate) => candidate.id === "qa")!;
      assert.deepStrictEqual(team.members[0]!.models.models, [GPT]);
      assert.deepStrictEqual(team.lead.models.models, [OPUS]);
      assert.deepStrictEqual(declined.settings.modelPool, LOCAL.settings.modelPool);

      const accepted = Result.getOrThrow(
        planImport(LOCAL, bundle, decision({ mode: "merge", poolAdditions: [GROK] })),
      );
      assert.deepStrictEqual(accepted.teams[0]!.members[0]!.models.models, [GROK, GPT]);
    }),
  );

  it.effect("skips a definition rather than empty its model list, which would widen it", () =>
    Effect.gen(function* () {
      const { fs, path, root, seed, run } = yield* withStore;
      yield* seed;
      const pinned = decodeDefinitions({
        ...LOCAL_INPUT,
        settings: { version: 1 as const, modelPool: [OPUS, GPT, GROK] },
        workers: [...LOCAL_INPUT.workers, worker("tester", "Tester", GROK)],
        teams: [
          {
            ...LOCAL_INPUT.teams[0]!,
            id: "qa",
            name: "QA",
            members: [{ ...worker("tester", "Tester", GROK), count: 1 }],
          },
        ],
      });
      const bundle = bundleOf(pinned);
      assert.deepStrictEqual(
        previewImport(LOCAL, bundle).items.filter((item) => item.status === "new"),
        [
          {
            kind: "worker",
            id: "tester",
            name: "Tester",
            status: "new",
            modelsNeedingPool: [GROK],
            skippedUnlessPoolAdded: true,
          },
          {
            kind: "team",
            id: "qa",
            name: "QA",
            status: "new",
            modelsNeedingPool: [GROK],
            skippedUnlessPoolAdded: true,
          },
        ],
      );

      const declined = yield* run(applyImport(bundle, decision({ mode: "merge" })));
      assert.deepStrictEqual(declined.problems, [
        {
          path: "workers/tester.md",
          message: "Tester uses only models you didn't add to the pool, so it wasn't imported.",
        },
        {
          path: "teams/qa",
          message: "QA uses only models you didn't add to the pool, so it wasn't imported.",
        },
      ]);
      assert.strictEqual(
        yield* fs.exists(path.join(root, "factory", "workers", "tester.md")),
        false,
      );
      assert.strictEqual(yield* fs.exists(path.join(root, "factory", "teams", "qa")), false);

      const accepted = Result.getOrThrow(
        planImport(LOCAL, bundle, decision({ mode: "merge", poolAdditions: [GROK] })),
      );
      assert.deepStrictEqual(
        [accepted.workers.map((d) => d.id), accepted.teams.map((d) => d.id), accepted.skipped],
        [["tester"], ["qa"], []],
      );
    }),
  );

  it.effect("refuses a replace that would leave a kind of definition empty", () =>
    Effect.gen(function* () {
      const message = (bundle: FactoryConfigBundle) => {
        const plan = planImport(LOCAL, bundle, decision({ mode: "replace" }));
        return Result.isFailure(plan) && [plan.failure.reason, plan.failure.message];
      };
      assert.deepStrictEqual(message({ files: [] }), [
        "invalid",
        "Replacing would leave the factory config with no workers, leads, managers or teams.",
      ]);
      const teamsOnly = Result.getOrThrow(
        buildExportBundle(LOCAL, { scope: "teams", teamIds: ["web-ui"] }),
      );
      assert.deepStrictEqual(message(teamsOnly), [
        "invalid",
        "Replacing would leave the factory config with no managers.",
      ]);

      const { fs, path, root, seed, run } = yield* withStore;
      yield* seed;
      const error = yield* Effect.flip(
        run(applyImport({ files: [] }, decision({ mode: "replace" }))),
      );
      assert.strictEqual(error.reason, "invalid");
      assert.strictEqual(yield* fs.exists(path.join(root, "factory-backups")), false);
    }),
  );

  it.effect("keeps mine for a differing definition that has no choice", () =>
    Effect.sync(() => {
      const plan = Result.getOrThrow(
        planImport(LOCAL, bundleOf(REMOTE), decision({ mode: "merge", poolAdditions: [GROK] })),
      );
      assert.deepStrictEqual(
        [plan.workers, plan.leads, plan.managers, plan.teams].map((set) => set.map((d) => d.id)),
        [["tester"], [], [], []],
      );
    }),
  );

  it.effect("keeps both under a free suffixed id and a name that fits 80 characters", () =>
    Effect.sync(() => {
      const long = `Reviewer ${"x".repeat(71)}`;
      const local = decodeDefinitions({
        ...LOCAL_INPUT,
        workers: [
          worker("reviewer", "Reviewer", OPUS),
          worker("reviewer-imported", "Reviewer (imported)", OPUS),
          worker("long", long, OPUS),
        ],
      });
      const remote = decodeDefinitions({
        ...LOCAL_INPUT,
        workers: [
          worker("reviewer", "Reviewer", OPUS, "Reviews twice."),
          worker("long", long, OPUS, "Long and different."),
        ],
      });
      const plan = Result.getOrThrow(
        planImport(
          local,
          bundleOf(remote),
          decision({
            mode: "merge",
            choices: [
              { kind: "worker", id: "reviewer", choice: "both" },
              { kind: "worker", id: "long", choice: "both" },
            ],
          }),
        ),
      );
      assert.deepStrictEqual(
        plan.workers.map((definition) => [definition.id, definition.name]),
        [
          ["reviewer-imported-2", "Reviewer (imported)"],
          [`reviewer-${"x".repeat(55)}`, `Reviewer ${"x".repeat(60)} (imported)`],
        ],
      );
      assert.strictEqual(plan.workers[1]!.name.length, 80);
    }),
  );

  it.effect("adds pool models only when chosen", () =>
    Effect.sync(() => {
      const bundle = bundleOf(REMOTE);
      const pool = (poolAdditions: ReadonlyArray<FactoryModelRef>, mode: "merge" | "replace") =>
        Result.getOrThrow(planImport(LOCAL, bundle, decision({ mode, poolAdditions }))).settings
          .modelPool;
      assert.deepStrictEqual(pool([], "merge"), LOCAL.settings.modelPool);
      assert.deepStrictEqual(pool([GROK], "merge"), [...LOCAL.settings.modelPool, GROK]);
      assert.deepStrictEqual(pool([], "replace"), [OPUS, GPT, CLAUDE_X]);
      assert.deepStrictEqual(pool([GROK], "replace"), [OPUS, GPT, CLAUDE_X, GROK]);
    }),
  );

  it.effect("replace backs up the current files, then the config equals the import", () =>
    Effect.gen(function* () {
      const { fs, path, root, seed, run } = yield* withStore;
      yield* seed;
      const before = yield* fs.readFileString(path.join(root, "factory", "workers", "docs.md"));

      const view = yield* run(
        applyImport(bundleOf(REMOTE), decision({ mode: "replace", poolAdditions: [GROK] })),
      );

      assert.deepStrictEqual(
        { ...view, configured: undefined, problems: undefined },
        { ...REMOTE, configured: undefined, problems: undefined },
      );
      assert.deepStrictEqual(view.problems, []);
      assert.strictEqual(
        yield* fs.readFileString(path.join(root, "factory-backups", "1", "workers", "docs.md")),
        before,
      );
    }),
  );

  it.effect("rejects bundle paths outside the layout, traversal and absolute paths included", () =>
    Effect.sync(() => {
      const contents = "---\nname: Sneaky\n---\n";
      const rejected = [
        "../x.md",
        "workers/../../x.md",
        "teams/web-ui/../../x.md",
        "/workers/sneaky.md",
        "C:/workers/sneaky.md",
        "workers\\sneaky.md",
        ".git/config",
        "roles/implementer.md",
      ];
      const preview = previewImport(LOCAL, {
        files: rejected.map((path) => ({ path, contents })),
      });
      assert.deepStrictEqual(preview.items, []);
      assert.deepStrictEqual(preview.problems, [
        ...rejected.map((path) => ({ path, message: "Not a path in the factory config layout." })),
        { path: "factory.yaml", message: "The bundle has no factory.yaml." },
      ]);
    }),
  );
});
