import {
  DEFAULT_FACTORY_CONFIG,
  type FactoryConfigView,
  type FactoryTeamPreset,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type FactoryModelOption,
  buildFactoryStarterConfig,
  effectiveFactoryConfig,
  factoryOverrideToSave,
  factoryPresetEntries,
  factoryPresetSummary,
  initialFactoryDraft,
  removeFactoryPreset,
  resetFactoryField,
  setFactoryModelPool,
  upsertFactoryPreset,
} from "./FactoryPageConfig";

const option = (driver: string, model: string): FactoryModelOption => ({
  selection: { instanceId: ProviderInstanceId.make(driver), model },
  label: `${driver} · ${model}`,
  driverKind: ProviderDriverKind.make(driver),
});

const preset = (name: string, overrides: Partial<FactoryTeamPreset> = {}): FactoryTeamPreset => ({
  id: name.toLowerCase(),
  name,
  useWhen: "",
  members: [{ role: "implementer", count: 1 }],
  workflow: "",
  createdBy: "user",
  ...overrides,
});

const projectId = ProjectId.make("project");

describe("buildFactoryStarterConfig", () => {
  it("pools only the enabled Claude and Codex models and adds one Standard team", () => {
    const starter = buildFactoryStarterConfig([
      option("claudeAgent", "claude-opus"),
      option("cursor", "composer"),
      option("codex", "gpt-5"),
    ]);
    expect(starter.modelPool.map((model) => model.model)).toEqual(["claude-opus", "gpt-5"]);
    expect(starter.teamPresets).toHaveLength(1);
    expect(starter.teamPresets[0]).toMatchObject({
      name: "Standard",
      useWhen: "Most tickets",
      members: [
        { role: "implementer", count: 1 },
        { role: "reviewer", count: 1 },
        { role: "verifier", count: 1 },
      ],
    });
    expect(starter.digestIntervalMinutes).toBe(10);
  });

  it("is offered only for an unsaved environment config", () => {
    const options = [option("codex", "gpt-5")];
    const unsaved = initialFactoryDraft(
      {
        environment: DEFAULT_FACTORY_CONFIG,
        effective: DEFAULT_FACTORY_CONFIG,
        configured: false,
      },
      null,
      options,
    );
    expect(unsaved.kind === "environment" && unsaved.config.teamPresets[0]?.name).toBe("Standard");

    const saved = initialFactoryDraft(
      { environment: DEFAULT_FACTORY_CONFIG, effective: DEFAULT_FACTORY_CONFIG, configured: true },
      null,
      options,
    );
    expect(saved.kind === "environment" && saved.config.teamPresets).toEqual([]);
  });
});

describe("project overrides", () => {
  const environment = {
    ...DEFAULT_FACTORY_CONFIG,
    modelPool: [option("codex", "gpt-5").selection, option("codex", "gpt-5-mini").selection],
    roleModels: {
      ...DEFAULT_FACTORY_CONFIG.roleModels,
      manager: option("codex", "gpt-5-mini").selection,
    },
    teamPresets: [preset("Standard"), preset("Solo")],
  };
  const view: FactoryConfigView = {
    environment,
    override: null,
    effective: environment,
    configured: true,
  };

  it("narrows the pool and drops role models that left it", () => {
    const draft = setFactoryModelPool(view, initialFactoryDraft(view, projectId, []), [
      option("codex", "gpt-5").selection,
    ]);
    expect(draft.kind === "project" && draft.override).toEqual({
      modelPool: [option("codex", "gpt-5").selection],
      roleModels: { ...DEFAULT_FACTORY_CONFIG.roleModels, manager: null },
    });
  });

  it("replaces an environment preset by name and inherits again once removed", () => {
    const copy = preset("Standard", { id: "copy", workflow: "Review twice." });
    const draft = upsertFactoryPreset(initialFactoryDraft(view, projectId, []), null, copy);
    expect(
      factoryPresetEntries(view, draft).map((entry) => [entry.preset.id, entry.origin]),
    ).toEqual([
      ["solo", "environment"],
      ["copy", "replaces"],
    ]);
    const removed = removeFactoryPreset(draft, "copy");
    expect(removed.kind === "project" && factoryOverrideToSave(removed.override)).toBeNull();
    expect(effectiveFactoryConfig(view, removed).teamPresets.map((entry) => entry.id)).toEqual([
      "standard",
      "solo",
    ]);
  });

  it("clears one override and saves null when none is left", () => {
    const draft = resetFactoryField(
      { kind: "project", projectId, override: { concurrencyCap: 4 } },
      "concurrencyCap",
    );
    expect(draft.kind === "project" && factoryOverrideToSave(draft.override)).toBeNull();
  });
});

describe("factoryPresetSummary", () => {
  it("names the members, the uses and who added it", () => {
    const summary = factoryPresetSummary(
      preset("Pair", {
        members: [
          { role: "implementer", count: 2 },
          { role: "reviewer", count: 1 },
        ],
        createdBy: "manager",
      }),
      12,
    );
    expect(summary).toBe("Lead, 2 implementers, reviewer · used 12 times · Added by manager");
    expect(factoryPresetSummary(preset("Solo"), null)).toBe("Lead, implementer");
  });
});
