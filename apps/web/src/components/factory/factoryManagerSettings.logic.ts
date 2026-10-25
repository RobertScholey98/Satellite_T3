import {
  FACTORY_CONCURRENCY_CAP_MAX,
  type FactoryControlPath,
  type FactoryOnboardingResult,
  type FactoryPickupColumn,
} from "@t3tools/contracts";

import { sameColumn } from "./factoryOnboardingCard.logic";

/** What the settings card edits. Text fields hold what the user typed until it is saved. */
export interface ManagerSettingsDraft {
  readonly purpose: string;
  readonly pickupEnabled: boolean;
  readonly columns: ReadonlyArray<FactoryPickupColumn>;
  /** Comma-separated; empty means any label. */
  readonly labels: string;
  readonly guidance: string;
  readonly concurrencyCap: string;
  /** Empty means every team. */
  readonly teamIds: ReadonlyArray<string>;
  readonly controlPaths: ReadonlyArray<FactoryControlPath>;
  /** By rule id. */
  readonly answers: Readonly<Record<string, string>>;
}

export function managerSettingsDraft(result: FactoryOnboardingResult): ManagerSettingsDraft {
  return {
    purpose: result.purpose,
    pickupEnabled: result.pickup.enabled,
    columns: result.pickup.columns,
    labels: result.pickup.labels.join(", "),
    guidance: result.pickup.guidance,
    concurrencyCap: String(result.concurrencyCap),
    teamIds: result.teamIds,
    controlPaths: result.controlPaths,
    answers: Object.fromEntries(result.rules.map((rule) => [rule.id, rule.answer])),
  };
}

function parseCap(text: string): number | null {
  const cap = Number(text.trim());
  return Number.isInteger(cap) && cap >= 1 && cap <= FACTORY_CONCURRENCY_CAP_MAX ? cap : null;
}

/** What the card checks before saving; the server checks the rest and says why it refuses. */
export function managerSettingsProblem(
  stored: FactoryOnboardingResult,
  draft: ManagerSettingsDraft,
): string | null {
  if (stored.rules.some((rule) => (draft.answers[rule.id] ?? "").trim() === ""))
    return "Answer every rule.";
  if (draft.pickupEnabled && draft.columns.length === 0)
    return "Tick at least one Ready column, or turn pickup off.";
  if (parseCap(draft.concurrencyCap) === null)
    return `Set the cap to a whole number from 1 to ${FACTORY_CONCURRENCY_CAP_MAX}.`;
  return null;
}

/** The result to save. The manager's questions and base branch are not the card's to change. */
export function managerSettingsResult(
  stored: FactoryOnboardingResult,
  draft: ManagerSettingsDraft,
): FactoryOnboardingResult {
  const labels = draft.labels
    .split(",")
    .map((label) => label.trim())
    .filter((label, index, all) => label !== "" && all.indexOf(label) === index);
  return {
    ...stored,
    purpose: draft.purpose.trim(),
    pickup: {
      enabled: draft.pickupEnabled,
      columns: draft.pickupEnabled ? draft.columns : [],
      labels,
      guidance: draft.guidance.trim(),
    },
    rules: stored.rules.map((rule) => ({
      ...rule,
      answer: (draft.answers[rule.id] ?? "").trim(),
    })),
    controlPaths: draft.controlPaths,
    teamIds: draft.teamIds,
    concurrencyCap: parseCap(draft.concurrencyCap) ?? stored.concurrencyCap,
  };
}

export function managerSettingsDirty(
  stored: FactoryOnboardingResult,
  draft: ManagerSettingsDraft,
): boolean {
  return (
    JSON.stringify(managerSettingsResult(stored, draft)) !== JSON.stringify(stored) ||
    // A cap the user typed but that is out of range still counts as an edit.
    draft.concurrencyCap.trim() !== String(stored.concurrencyCap)
  );
}

export function toggleSettingsColumn(
  draft: ManagerSettingsDraft,
  column: FactoryPickupColumn,
  ticked: boolean,
): ManagerSettingsDraft {
  const rest = draft.columns.filter((entry) => !sameColumn(entry, column));
  return { ...draft, columns: ticked ? [...rest, column] : rest };
}

/**
 * Work starts only while both caps have room, so the lower one is what the manager runs to. Before
 * approval a manager has no result, so no cap of its own, and runs to the environment's.
 */
export function effectiveManagerCap(
  result: FactoryOnboardingResult | null | undefined,
  environmentCap: number,
) {
  const managerCap = result?.concurrencyCap ?? environmentCap;
  return {
    cap: Math.min(managerCap, environmentCap),
    limitedByEnvironment: environmentCap < managerCap,
  };
}
