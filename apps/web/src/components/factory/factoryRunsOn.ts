import {
  type FactoryConfig,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import type { FactoryModelOption } from "./FactoryPageConfig";

/** One driver's "Runs on" choice: its usable instances and what the config prefers. */
export interface FactoryInstancePicker {
  readonly driver: ProviderDriverKind;
  readonly driverLabel: string;
  readonly instances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly label: string;
  }>;
  /** Null runs on the first available instance. */
  readonly preferred: ProviderInstanceId | null;
  /** The preference names an instance this environment cannot run; the first available runs. */
  readonly stale: boolean;
}

// Model option labels read "<instance display name> · <model name>".
const instanceLabel = (option: FactoryModelOption) => {
  const [name] = option.label.split(" · ");
  return name === undefined || name === "" ? option.selection.instanceId : name;
};

/**
 * A picker for each driver with more than one usable instance, since only then is there a choice.
 * A driver whose stored preference names an instance not usable here gets one too, so the
 * preference is shown and can be cleared rather than kept out of sight.
 */
export function factoryInstancePickers(
  options: ReadonlyArray<FactoryModelOption>,
  preferences: FactoryConfig["instancePreferences"],
): ReadonlyArray<FactoryInstancePicker> {
  const byDriver = new Map<ProviderDriverKind, Map<ProviderInstanceId, string>>();
  for (const option of options) {
    const instances = byDriver.get(option.driverKind) ?? new Map<ProviderInstanceId, string>();
    if (!instances.has(option.selection.instanceId))
      instances.set(option.selection.instanceId, instanceLabel(option));
    byDriver.set(option.driverKind, instances);
  }
  const drivers = new Set<ProviderDriverKind>([
    ...byDriver.keys(),
    ...(Object.keys(preferences) as ProviderDriverKind[]),
  ]);
  const pickers: FactoryInstancePicker[] = [];
  for (const driver of drivers) {
    const instances = [...(byDriver.get(driver) ?? new Map<ProviderInstanceId, string>())].map(
      ([instanceId, label]) => ({ instanceId, label }),
    );
    const preferred = preferences[driver] ?? null;
    const stale =
      preferred !== null && !instances.some((instance) => instance.instanceId === preferred);
    if (instances.length < 2 && !stale) continue;
    pickers.push({
      driver,
      driverLabel: PROVIDER_DISPLAY_NAMES[driver] ?? driver,
      instances,
      preferred,
      stale,
    });
  }
  return pickers;
}

/** The config preferring `instanceId` for `driver`; null clears it, removing the key. */
export function setFactoryInstancePreference(
  config: FactoryConfig,
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId | null,
): FactoryConfig {
  const rest = Object.fromEntries(
    Object.entries(config.instancePreferences).filter(([key]) => key !== driver),
  ) as FactoryConfig["instancePreferences"];
  return {
    ...config,
    instancePreferences: instanceId === null ? rest : { ...rest, [driver]: instanceId },
  };
}
