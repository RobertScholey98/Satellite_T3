import type { FactoryConfig, FactoryConfigOverride, ModelSelection } from "@t3tools/contracts";

const modelKey = (model: ModelSelection) => `${model.instanceId}\n${model.model}`;

const notInPool = (pool: ReadonlySet<string>, models: ReadonlyArray<ModelSelection | null>) =>
  models.filter((model): model is ModelSelection => model !== null && !pool.has(modelKey(model)));

/**
 * Why a saved config would let managed work escape the pool or name a team it cannot staff, or
 * null when it is sound. Checked on the effective config, since an override can narrow the pool
 * under role models the environment set.
 */
export const factoryConfigProblem = (config: FactoryConfig): string | null => {
  const pool = new Set(config.modelPool.map(modelKey));
  const { manager, lead, workers } = config.roleModels;
  const escaped = notInPool(pool, [
    manager,
    lead.small,
    lead.medium,
    lead.large,
    ...workers.implementer,
    ...workers.reviewer,
    ...workers.verifier,
    ...config.teamPresets.flatMap((preset) =>
      preset.members.flatMap((member) => member.models ?? []),
    ),
  ]);
  if (escaped.length > 0) {
    const first = escaped[0]!;
    return `${first.model} (${first.instanceId}) is not in the model pool.`;
  }
  const names = new Set<string>();
  for (const preset of config.teamPresets) {
    if (names.has(preset.name)) return `Two team presets are named "${preset.name}".`;
    names.add(preset.name);
  }
  return null;
};

/** Narrower than the environment, never wider: an override cannot add a model to the pool. */
export const overrideWidensPool = (
  environment: FactoryConfig,
  override: FactoryConfigOverride,
): boolean => {
  if (override.modelPool === undefined) return false;
  const pool = new Set(environment.modelPool.map(modelKey));
  return override.modelPool.some((model) => !pool.has(modelKey(model)));
};
