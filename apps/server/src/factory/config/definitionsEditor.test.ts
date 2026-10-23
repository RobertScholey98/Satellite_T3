import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, type FactoryDefinitionSaveInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as FactoryDefinitionsEditor from "./definitionsEditor.ts";
import * as FactoryConfigStore from "./FactoryConfigStore.ts";

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

  it.effect("removes a definition", () =>
    Effect.gen(function* () {
      const editor = yield* setup;
      const { id } = yield* editor.save(reviewer("Code Reviewer"));
      const view = yield* editor.remove({ kind: "worker", id });
      assert.deepStrictEqual(view.workers, []);
    }),
  );
});
