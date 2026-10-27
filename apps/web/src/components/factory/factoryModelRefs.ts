import type { FactoryModelList, FactoryModelRef } from "@t3tools/contracts";

import type { FactoryModelOption } from "./FactoryPageConfig";

/**
 * Factory definitions name models portably, as a driver and a model slug, because provider instance
 * ids differ between machines. These helpers connect those names to what this environment runs.
 */

export const factoryModelRefKey = (ref: Pick<FactoryModelRef, "driver" | "model">) =>
  `${ref.driver}/${ref.model}`;

/** The first option of the same driver and slug, as the server resolves a ref when it runs. */
export function resolveFactoryModelRef(
  ref: Pick<FactoryModelRef, "driver" | "model">,
  options: ReadonlyArray<FactoryModelOption>,
): FactoryModelOption | null {
  return (
    options.find(
      (option) => option.driverKind === ref.driver && option.selection.model === ref.model,
    ) ?? null
  );
}

/** For a list row: the models in order, or the pool when the list is empty. */
export function summarizeFactoryModelList(
  list: FactoryModelList,
  options: ReadonlyArray<FactoryModelOption>,
): string {
  const models =
    list.models.length === 0
      ? "Any model in the pool"
      : list.models
          .map((ref) => resolveFactoryModelRef(ref, options)?.label ?? factoryModelRefKey(ref))
          .join(", ");
  return list.dynamic ? `${models} · chosen per task` : models;
}

export function factoryModelRefFromOption(option: FactoryModelOption): FactoryModelRef {
  return { driver: option.driverKind, model: option.selection.model };
}

/** Moves one entry of an ordered model list; a move past either end leaves the list as it is. */
export function moveFactoryModelRef(
  refs: ReadonlyArray<FactoryModelRef>,
  index: number,
  offset: -1 | 1,
): ReadonlyArray<FactoryModelRef> {
  const target = index + offset;
  if (index < 0 || index >= refs.length || target < 0 || target >= refs.length) return refs;
  const next = [...refs];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

type FactoryModelRefFlag = "unavailable" | "not-in-pool";

export const FACTORY_MODEL_REF_FLAG_LABELS: Record<FactoryModelRefFlag, string> = {
  unavailable: "not available on this environment",
  "not-in-pool": "not in pool",
};

interface FactoryModelRefEntry {
  readonly ref: FactoryModelRef;
  readonly label: string;
  readonly flags: ReadonlyArray<FactoryModelRefFlag>;
}

/**
 * Each ref with a label and what keeps it from running here. Pass `pool` as null to skip the pool
 * check, as the pool itself does.
 */
export function describeFactoryModelRefs(
  refs: ReadonlyArray<FactoryModelRef>,
  options: ReadonlyArray<FactoryModelOption>,
  pool: ReadonlyArray<FactoryModelRef> | null,
): ReadonlyArray<FactoryModelRefEntry> {
  const pooled = pool === null ? null : new Set(pool.map(factoryModelRefKey));
  return refs.map((ref) => {
    const option = resolveFactoryModelRef(ref, options);
    const flags: FactoryModelRefFlag[] = [];
    if (option === null) flags.push("unavailable");
    if (pooled !== null && !pooled.has(factoryModelRefKey(ref))) flags.push("not-in-pool");
    return { ref, label: option?.label ?? factoryModelRefKey(ref), flags };
  });
}

const STARTER_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/**
 * The starter set's pool: this environment's enabled Claude and Codex models, as the old starting
 * point chose them. Two instances of one driver serving one model are one pool entry.
 */
export function factoryStarterPool(
  options: ReadonlyArray<FactoryModelOption>,
): ReadonlyArray<FactoryModelRef> {
  const refs = options
    .filter((option) => STARTER_DRIVERS.has(option.driverKind))
    .map(factoryModelRefFromOption);
  return [...new Map(refs.map((ref) => [factoryModelRefKey(ref), ref])).values()];
}
