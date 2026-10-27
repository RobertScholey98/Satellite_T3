import { Equal } from "effect";

export type FactorySectionSaveState = "idle" | "dirty" | "saving";

/**
 * Whether a section's draft has anything to save. A draft edited back to the saved value is
 * idle, so its Save goes away again; a save in flight stays visible until it answers.
 */
export function factorySectionSaveState<T>(
  saved: T | null,
  draft: T | null,
  saving: boolean,
): FactorySectionSaveState {
  if (saving) return "saving";
  return draft !== null && !Equal.equals(saved, draft) ? "dirty" : "idle";
}
