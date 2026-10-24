import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type FactoryConfigSettings,
  type FactoryModelRef,
} from "@t3tools/contracts";

import {
  ambiguousDrivers,
  chooseModel,
  resolveModelList,
  resolveModelRef,
  stalePreferences,
  usableModelPool,
  withInstancePreferences,
  type FactoryModelCatalog,
  type InstancePreferences,
} from "./modelResolution.ts";

const prefer = (preferences: Record<string, string>): InstancePreferences =>
  Object.fromEntries(
    Object.entries(preferences).map(([driver, instanceId]) => [
      ProviderDriverKind.make(driver),
      ProviderInstanceId.make(instanceId),
    ]),
  );

const ref = (driver: string, model: string): FactoryModelRef => ({
  driver: ProviderDriverKind.make(driver),
  model,
});
const selection = (instanceId: string, model: string) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const OPUS = ref("claudeAgent", "claude-opus-5-5");
const SONNET = ref("claudeAgent", "claude-sonnet-5");
const GPT = ref("codex", "gpt-6");
const GROK = ref("grok", "grok-5");

/** Two Claude instances: the first one lacks Sonnet. Grok is not installed. */
const CATALOG: FactoryModelCatalog = [
  {
    instanceId: ProviderInstanceId.make("claude-work"),
    driver: ProviderDriverKind.make("claudeAgent"),
    models: ["claude-opus-5-5"],
  },
  {
    instanceId: ProviderInstanceId.make("claude-home"),
    driver: ProviderDriverKind.make("claudeAgent"),
    models: ["claude-opus-5-5", "claude-sonnet-5"],
  },
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    models: ["gpt-6"],
  },
];

const SETTINGS: FactoryConfigSettings = {
  version: 1,
  modelPool: [OPUS, SONNET, GPT, GROK],
  recoveryAllowance: 1,
};

describe("factory model resolution", () => {
  it("resolves a ref to the first instance of its driver that offers the model", () => {
    assert.deepStrictEqual(
      resolveModelRef(OPUS, CATALOG),
      selection("claude-work", "claude-opus-5-5"),
    );
    assert.deepStrictEqual(
      resolveModelRef(SONNET, CATALOG),
      selection("claude-home", "claude-sonnet-5"),
    );
    assert.deepStrictEqual(
      resolveModelRef({ ...GPT, options: [{ id: "effort", value: "max" }] }, CATALOG),
      { ...selection("codex", "gpt-6"), options: [{ id: "effort", value: "max" }] },
    );
    assert.strictEqual(resolveModelRef(GROK, CATALOG), null);
  });

  it("names each driver that more than one instance can serve and no preference settles", () => {
    assert.deepStrictEqual(ambiguousDrivers(CATALOG), [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        instanceIds: [
          ProviderInstanceId.make("claude-work"),
          ProviderInstanceId.make("claude-home"),
        ],
      },
    ]);
    assert.deepStrictEqual(ambiguousDrivers(CATALOG, prefer({ claudeAgent: "claude-home" })), []);
  });

  it("runs a driver's models on its preferred instance, then on the first that serves them", () => {
    const home = withInstancePreferences(CATALOG, prefer({ claudeAgent: "claude-home" }));
    assert.deepStrictEqual(
      resolveModelRef(OPUS, home),
      selection("claude-home", "claude-opus-5-5"),
    );
    assert.deepStrictEqual(
      resolveModelRef(GPT, home),
      selection("codex", "gpt-6"),
      "other drivers are untouched",
    );
    // claude-work lacks Sonnet, so Sonnet falls back to the first instance that has it.
    const work = withInstancePreferences(CATALOG, prefer({ claudeAgent: "claude-work" }));
    assert.deepStrictEqual(
      resolveModelRef(OPUS, work),
      selection("claude-work", "claude-opus-5-5"),
    );
    assert.deepStrictEqual(
      resolveModelRef(SONNET, work),
      selection("claude-home", "claude-sonnet-5"),
    );
  });

  it("falls back from a preference it cannot honour, and reports it as stale", () => {
    // One instance is gone; the other belongs to a different driver.
    const preferences = prefer({ claudeAgent: "claude-gone", codex: "claude-home" });
    const catalog = withInstancePreferences(CATALOG, preferences);
    assert.deepStrictEqual(
      resolveModelRef(OPUS, catalog),
      selection("claude-work", "claude-opus-5-5"),
    );
    assert.deepStrictEqual(resolveModelRef(GPT, catalog), selection("codex", "gpt-6"));
    assert.deepStrictEqual(stalePreferences(preferences, CATALOG), [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        instanceId: ProviderInstanceId.make("claude-gone"),
      },
      {
        driver: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("claude-home"),
      },
    ]);
    assert.deepStrictEqual(stalePreferences(prefer({ claudeAgent: "claude-home" }), CATALOG), []);
  });

  it("narrows the pool to what this environment can run", () => {
    assert.deepStrictEqual(usableModelPool(SETTINGS, CATALOG), [
      selection("claude-work", "claude-opus-5-5"),
      selection("claude-home", "claude-sonnet-5"),
      selection("codex", "gpt-6"),
    ]);
  });

  it("keeps a list's order, skipping models it cannot run or the pool lacks", () => {
    const settings = { ...SETTINGS, modelPool: [OPUS, GPT, GROK] };
    assert.deepStrictEqual(
      resolveModelList({ dynamic: false, models: [GROK, SONNET, GPT, OPUS] }, settings, CATALOG),
      {
        dynamic: false,
        models: [selection("codex", "gpt-6"), selection("claude-work", "claude-opus-5-5")],
      },
    );
  });

  it("reads an empty list as the whole usable pool", () => {
    assert.deepStrictEqual(resolveModelList({ dynamic: true, models: [] }, SETTINGS, CATALOG), {
      dynamic: true,
      models: usableModelPool(SETTINGS, CATALOG),
    });
  });

  it("runs a priority list's first model and refuses another", () => {
    const resolved = resolveModelList({ dynamic: false, models: [GPT, OPUS] }, SETTINGS, CATALOG);
    assert.deepStrictEqual(chooseModel(resolved, undefined), {
      kind: "chosen",
      model: selection("codex", "gpt-6"),
    });
    assert.deepStrictEqual(chooseModel(resolved, selection("claude-work", "claude-opus-5-5")), {
      kind: "not-first",
      first: selection("codex", "gpt-6"),
    });
  });

  it("lets a dynamic list's starter pick any entry, defaulting to the first", () => {
    const resolved = resolveModelList({ dynamic: true, models: [GPT, OPUS] }, SETTINGS, CATALOG);
    assert.deepStrictEqual(chooseModel(resolved, selection("claude-work", "claude-opus-5-5")), {
      kind: "chosen",
      model: selection("claude-work", "claude-opus-5-5"),
    });
    assert.deepStrictEqual(chooseModel(resolved, selection("claude-home", "claude-sonnet-5")), {
      kind: "not-listed",
    });
    assert.deepStrictEqual(
      chooseModel(
        resolveModelList({ dynamic: true, models: [GROK] }, SETTINGS, CATALOG),
        undefined,
      ),
      { kind: "none" },
    );
  });
});
