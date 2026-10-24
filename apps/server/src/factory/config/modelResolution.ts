import {
  isProviderAvailable,
  type FactoryConfigSettings,
  type FactoryModelList,
  type FactoryModelRef,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * Definitions name models portably, as a driver and a model slug, because provider instance ids
 * differ between machines. These helpers turn those names into the selections this environment
 * launches with. They are pure: the catalog is read from the provider registry at the edge.
 */

/** A provider instance that can start threads now, with the model slugs it offers. */
interface FactoryModelCatalogEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly models: ReadonlyArray<string>;
}

/** What this environment can run, in the registry's instance order. */
export type FactoryModelCatalog = ReadonlyArray<FactoryModelCatalogEntry>;

export function factoryModelCatalog(providers: ReadonlyArray<ServerProvider>): FactoryModelCatalog {
  return providers
    .filter((provider) => provider.enabled && isProviderAvailable(provider))
    .map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      models: provider.models.map((model) => model.slug),
    }));
}

/**
 * Drivers with more than one instance that can run now. A name resolves to the first of them that
 * offers its model, which may not be the instance the user means.
 */
export function ambiguousDrivers(catalog: FactoryModelCatalog): ReadonlyArray<{
  readonly driver: ProviderDriverKind;
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
}> {
  const byDriver = new Map<ProviderDriverKind, ProviderInstanceId[]>();
  for (const entry of catalog) {
    byDriver.set(entry.driver, [...(byDriver.get(entry.driver) ?? []), entry.instanceId]);
  }
  return [...byDriver]
    .filter(([, instanceIds]) => instanceIds.length > 1)
    .map(([driver, instanceIds]) => ({ driver, instanceIds }));
}

const refKey = (ref: Pick<FactoryModelRef, "driver" | "model">) => `${ref.driver}/${ref.model}`;

/** The first instance of the ref's driver that offers its model, or null when none does. */
export function resolveModelRef(
  ref: FactoryModelRef,
  catalog: FactoryModelCatalog,
): ModelSelection | null {
  const entry = catalog.find(
    (candidate) => candidate.driver === ref.driver && candidate.models.includes(ref.model),
  );
  if (entry === undefined) return null;
  return {
    instanceId: entry.instanceId,
    model: ref.model,
    ...(ref.options === undefined || ref.options.length === 0 ? {} : { options: ref.options }),
  };
}

const resolveAll = (refs: ReadonlyArray<FactoryModelRef>, catalog: FactoryModelCatalog) =>
  refs.flatMap((ref) => {
    const selection = resolveModelRef(ref, catalog);
    return selection === null ? [] : [selection];
  });

/** `factory.yaml`'s pool, narrowed to the models this environment can run. */
export function usableModelPool(
  settings: FactoryConfigSettings,
  catalog: FactoryModelCatalog,
): ReadonlyArray<ModelSelection> {
  return resolveAll(settings.modelPool, catalog);
}

export interface ResolvedModelList {
  readonly dynamic: boolean;
  /** Runnable pool models in the list's order; the whole usable pool when the list is empty. */
  readonly models: ReadonlyArray<ModelSelection>;
}

/**
 * A definition's model list as this environment can run it. A model the pool no longer holds stays
 * in the definition but is skipped here, and so is one no instance offers.
 */
export function resolveModelList(
  list: FactoryModelList,
  settings: FactoryConfigSettings,
  catalog: FactoryModelCatalog,
): ResolvedModelList {
  if (list.models.length === 0) {
    return { dynamic: list.dynamic, models: usableModelPool(settings, catalog) };
  }
  const pooled = new Set(settings.modelPool.map(refKey));
  return {
    dynamic: list.dynamic,
    models: resolveAll(
      list.models.filter((ref) => pooled.has(refKey(ref))),
      catalog,
    ),
  };
}

const sameModel = (left: ModelSelection, right: ModelSelection) =>
  left.instanceId === right.instanceId && left.model === right.model;

export type ModelChoice =
  | { readonly kind: "chosen"; readonly model: ModelSelection }
  /** Nothing in the list can run here. */
  | { readonly kind: "none" }
  /** A dynamic list was asked for a model it does not hold. */
  | { readonly kind: "not-listed" }
  /** A priority list runs its first model, and another was asked for. */
  | { readonly kind: "not-first"; readonly first: ModelSelection };

/**
 * The model an agent starts with. A dynamic list lets its starter pick any entry and defaults to
 * the first; a priority list always runs its first entry.
 */
export function chooseModel(
  resolved: ResolvedModelList,
  requested: ModelSelection | undefined,
): ModelChoice {
  const first = resolved.models[0];
  if (first === undefined) return { kind: "none" };
  if (requested === undefined) return { kind: "chosen", model: first };
  if (!resolved.dynamic) {
    return sameModel(requested, first)
      ? { kind: "chosen", model: first }
      : { kind: "not-first", first };
  }
  const listed = resolved.models.find((model) => sameModel(model, requested));
  return listed === undefined ? { kind: "not-listed" } : { kind: "chosen", model: listed };
}
