import {
  DEFAULT_FACTORY_CONFIG,
  type FactoryConfig,
  type FactoryConfigOverride,
  type FactoryConfigView,
  type FactoryRole,
  type FactoryTeamMember,
  type FactoryTeamPreset,
  type FactoryWorkerRole,
  type ModelSelection,
  type ProviderDriverKind,
  type ProjectId,
  type ServerProvider,
  resolveFactoryConfig,
} from "@t3tools/contracts";

import { deriveProviderInstanceEntries } from "~/providerInstances";

/** A model the factory can be given, as the environment reports it. */
export interface FactoryModelOption {
  readonly selection: ModelSelection;
  readonly label: string;
  readonly driverKind: ProviderDriverKind;
}

export const factoryModelKey = (model: Pick<ModelSelection, "instanceId" | "model">) =>
  `${model.instanceId}\n${model.model}`;

/** Every current model of the environment's enabled, available provider instances. */
export function factoryModelOptions(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<FactoryModelOption> {
  return deriveProviderInstanceEntries(providers)
    .filter((entry) => entry.enabled && entry.isAvailable)
    .flatMap((entry) =>
      entry.models
        .filter((model) => model.isLegacy !== true)
        .map((model) => ({
          selection: { instanceId: entry.instanceId, model: model.slug },
          label: `${entry.displayName} · ${model.name}`,
          driverKind: entry.driverKind,
        })),
    );
}

const STARTER_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/**
 * What Configuration offers before the environment config is first saved: the enabled Claude
 * and Codex models as the pool, and one Standard team.
 */
export function buildFactoryStarterConfig(
  options: ReadonlyArray<FactoryModelOption>,
): FactoryConfig {
  return {
    ...DEFAULT_FACTORY_CONFIG,
    modelPool: options
      .filter((option) => STARTER_DRIVERS.has(option.driverKind))
      .map((option) => option.selection),
    teamPresets: [
      {
        id: "standard",
        name: "Standard",
        useWhen: "Most tickets",
        members: [
          { role: "implementer", count: 1 },
          { role: "reviewer", count: 1 },
          { role: "verifier", count: 1 },
        ],
        workflow:
          "The implementer builds the change, the reviewer reviews the pull request, and the verifier checks the result against the ticket before the lead claims it done.",
        createdBy: "user",
      },
    ],
  };
}

/** The settings being edited: the environment config, or one project's overrides. */
export type FactoryConfigDraft =
  | { readonly kind: "environment"; readonly config: FactoryConfig }
  | {
      readonly kind: "project";
      readonly projectId: ProjectId;
      readonly override: FactoryConfigOverride;
    };

export type FactoryOverridableKey = Exclude<keyof FactoryConfigOverride, "teamPresets">;

export function initialFactoryDraft(
  view: FactoryConfigView,
  projectId: ProjectId | null,
  options: ReadonlyArray<FactoryModelOption>,
): FactoryConfigDraft {
  if (projectId !== null) return { kind: "project", projectId, override: view.override ?? {} };
  return {
    kind: "environment",
    config: view.configured ? view.environment : buildFactoryStarterConfig(options),
  };
}

export function effectiveFactoryConfig(
  view: FactoryConfigView,
  draft: FactoryConfigDraft,
): FactoryConfig {
  return draft.kind === "environment"
    ? draft.config
    : resolveFactoryConfig(view.environment, draft.override);
}

export function setFactoryField<K extends FactoryOverridableKey>(
  draft: FactoryConfigDraft,
  key: K,
  value: FactoryConfig[K],
): FactoryConfigDraft {
  return draft.kind === "environment"
    ? { ...draft, config: { ...draft.config, [key]: value } }
    : { ...draft, override: { ...draft.override, [key]: value } };
}

/** A project inherits the environment value again; the environment returns to the default. */
export function resetFactoryField(
  draft: FactoryConfigDraft,
  key: FactoryOverridableKey,
): FactoryConfigDraft {
  if (draft.kind === "environment") {
    return { ...draft, config: { ...draft.config, [key]: DEFAULT_FACTORY_CONFIG[key] } };
  }
  const { [key]: _cleared, ...override } = draft.override;
  return { ...draft, override };
}

/** Whether the field differs from what reset would give it. */
export function factoryFieldIsSet(draft: FactoryConfigDraft, key: FactoryOverridableKey): boolean {
  return draft.kind === "environment"
    ? JSON.stringify(draft.config[key]) !== JSON.stringify(DEFAULT_FACTORY_CONFIG[key])
    : draft.override[key] !== undefined;
}

const keepInPool = (pool: ReadonlySet<string>, model: ModelSelection | null) =>
  model !== null && pool.has(factoryModelKey(model)) ? model : null;

/**
 * Narrows role models and member allow-lists to a new pool, since the server refuses a config
 * that names a model outside it.
 */
function withFactoryModelPool(
  config: FactoryConfig,
  modelPool: ReadonlyArray<ModelSelection>,
): FactoryConfig {
  const pool = new Set(modelPool.map(factoryModelKey));
  const inPool = (models: ReadonlyArray<ModelSelection>) =>
    models.filter((model) => pool.has(factoryModelKey(model)));
  const { manager, lead, workers } = config.roleModels;
  return {
    ...config,
    modelPool,
    roleModels: {
      manager: keepInPool(pool, manager),
      lead: {
        small: keepInPool(pool, lead.small),
        medium: keepInPool(pool, lead.medium),
        large: keepInPool(pool, lead.large),
      },
      workers: {
        implementer: inPool(workers.implementer),
        reviewer: inPool(workers.reviewer),
        verifier: inPool(workers.verifier),
      },
    },
    teamPresets: config.teamPresets.map((preset) => ({
      ...preset,
      members: preset.members.map(({ models, ...member }) => {
        const kept = models === undefined ? undefined : inPool(models);
        return kept === undefined || kept.length === 0 ? member : { ...member, models: kept };
      }),
    })),
  };
}

export function setFactoryModelPool(
  view: FactoryConfigView,
  draft: FactoryConfigDraft,
  modelPool: ReadonlyArray<ModelSelection>,
): FactoryConfigDraft {
  if (draft.kind === "environment") {
    return { ...draft, config: withFactoryModelPool(draft.config, modelPool) };
  }
  const before = effectiveFactoryConfig(view, draft);
  const after = withFactoryModelPool(before, modelPool);
  const roleModelsChanged = JSON.stringify(before.roleModels) !== JSON.stringify(after.roleModels);
  return {
    ...draft,
    override: {
      ...draft.override,
      modelPool,
      ...(roleModelsChanged ? { roleModels: after.roleModels } : {}),
    },
  };
}

/** Where a preset in the effective list comes from, seen from the scope being edited. */
export type FactoryPresetOrigin = "environment" | "project" | "replaces";

export interface FactoryPresetEntry {
  readonly preset: FactoryTeamPreset;
  readonly origin: FactoryPresetOrigin;
  /** The scope being edited can delete it. */
  readonly removable: boolean;
}

export function factoryPresetEntries(
  view: FactoryConfigView,
  draft: FactoryConfigDraft,
): ReadonlyArray<FactoryPresetEntry> {
  if (draft.kind === "environment") {
    return draft.config.teamPresets.map((preset) => ({
      preset,
      origin: "environment",
      removable: true,
    }));
  }
  const own = draft.override.teamPresets ?? [];
  return resolveFactoryConfig(view.environment, draft.override).teamPresets.map((preset) => {
    if (!own.some((candidate) => candidate.id === preset.id)) {
      return { preset, origin: "environment", removable: false };
    }
    const replaces = view.environment.teamPresets.some(
      (candidate) => candidate.name === preset.name,
    );
    return { preset, origin: replaces ? "replaces" : "project", removable: true };
  });
}

/**
 * Saves a preset in the scope being edited. Editing an environment preset from a project adds
 * the project's own copy, which replaces it by name.
 */
export function upsertFactoryPreset(
  draft: FactoryConfigDraft,
  previousId: string | null,
  preset: FactoryTeamPreset,
): FactoryConfigDraft {
  const upsert = (presets: ReadonlyArray<FactoryTeamPreset>) =>
    previousId !== null && presets.some((candidate) => candidate.id === previousId)
      ? presets.map((candidate) => (candidate.id === previousId ? preset : candidate))
      : [...presets, preset];
  return draft.kind === "environment"
    ? { ...draft, config: { ...draft.config, teamPresets: upsert(draft.config.teamPresets) } }
    : {
        ...draft,
        override: { ...draft.override, teamPresets: upsert(draft.override.teamPresets ?? []) },
      };
}

export function removeFactoryPreset(draft: FactoryConfigDraft, id: string): FactoryConfigDraft {
  if (draft.kind === "environment") {
    return {
      ...draft,
      config: {
        ...draft.config,
        teamPresets: draft.config.teamPresets.filter((preset) => preset.id !== id),
      },
    };
  }
  const { teamPresets = [], ...rest } = draft.override;
  const kept = teamPresets.filter((preset) => preset.id !== id);
  return { ...draft, override: kept.length === 0 ? rest : { ...rest, teamPresets: kept } };
}

/** A preset name already taken in the scope being edited, other than by `id`. */
export function factoryPresetNameTaken(
  draft: FactoryConfigDraft,
  name: string,
  id: string | null,
): boolean {
  const presets =
    draft.kind === "environment" ? draft.config.teamPresets : (draft.override.teamPresets ?? []);
  const wanted = name.trim();
  return presets.some((preset) => preset.id !== id && preset.name === wanted);
}

const ROLE_NOUNS: Record<FactoryRole, string> = {
  manager: "manager",
  lead: "lead",
  implementer: "implementer",
  reviewer: "reviewer",
  verifier: "verifier",
  worker: "worker",
};

export const FACTORY_ROLE_LABELS: Record<FactoryRole, string> = {
  manager: "Manager",
  lead: "Lead",
  implementer: "Implementer",
  reviewer: "Reviewer",
  verifier: "Verifier",
  worker: "Worker",
};

export const FACTORY_WORKER_ROLES: ReadonlyArray<FactoryWorkerRole> = [
  "implementer",
  "reviewer",
  "verifier",
];

/** One count per worker role; the editor shows one row each. */
export function factoryMemberCounts(members: ReadonlyArray<FactoryTeamMember>): ReadonlyArray<{
  role: FactoryWorkerRole;
  count: number;
  models: ReadonlyArray<ModelSelection>;
}> {
  return FACTORY_WORKER_ROLES.map((role) => {
    const own = members.filter((member) => member.role === role);
    return {
      role,
      count: own.reduce((sum, member) => sum + member.count, 0),
      models: own.find((member) => member.models !== undefined)?.models ?? [],
    };
  });
}

/** For example "Lead, 2 implementers, reviewer · used 12 times · Added by manager". */
export function factoryPresetSummary(preset: FactoryTeamPreset, uses: number | null): string {
  const members = factoryMemberCounts(preset.members)
    .filter((member) => member.count > 0)
    .map((member) =>
      member.count === 1 ? ROLE_NOUNS[member.role] : `${member.count} ${ROLE_NOUNS[member.role]}s`,
    );
  return [
    ["Lead", ...members].join(", "),
    uses === null ? null : uses === 1 ? "used once" : `used ${uses} times`,
    preset.createdBy === "manager" ? "Added by manager" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** What Save sends for a project: null when nothing is overridden any more. */
export function factoryOverrideToSave(
  override: FactoryConfigOverride,
): FactoryConfigOverride | null {
  return Object.keys(override).length === 0 ? null : override;
}
