import type {
  FactoryRole,
  ModelSelection,
  ProviderDriverKind,
  ServerProvider,
} from "@t3tools/contracts";

import { deriveProviderInstanceEntries } from "~/providerInstances";

/** A model the factory can be given, as the environment reports it. */
export interface FactoryModelOption {
  readonly selection: ModelSelection;
  readonly label: string;
  readonly driverKind: ProviderDriverKind;
}

/**
 * A model named after its provider ("Claude Opus 5.5") stands alone rather than reading
 * "Claude · Claude Opus 5.5"; any other keeps the provider, which tells instances apart.
 */
export function factoryModelOptionLabel(providerName: string, modelName: string): string {
  return modelName.toLowerCase().startsWith(`${providerName.toLowerCase()} `)
    ? modelName
    : `${providerName} · ${modelName}`;
}

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
          label: factoryModelOptionLabel(entry.displayName, model.name),
          driverKind: entry.driverKind,
        })),
    );
}

export const FACTORY_ROLE_LABELS: Record<FactoryRole, string> = {
  manager: "Manager",
  lead: "Lead",
  implementer: "Implementer",
  reviewer: "Reviewer",
  verifier: "Verifier",
  worker: "Worker",
};
