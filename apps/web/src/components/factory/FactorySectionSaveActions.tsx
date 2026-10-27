import { Button } from "../ui/button";
import type { FactorySectionSaveState } from "./factorySectionSave.logic";

/** Discard and Save for one section, shown only while it has something to save. */
export function FactorySectionSaveActions({
  state,
  label,
  disabled,
  onSave,
  onDiscard,
}: {
  readonly state: FactorySectionSaveState;
  readonly label: string;
  readonly disabled: boolean;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
}) {
  if (state === "idle") return null;
  const saving = state === "saving";
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost" disabled={saving} onClick={onDiscard}>
        Discard
      </Button>
      <Button size="sm" disabled={disabled || saving} onClick={onSave}>
        {saving ? "Saving…" : label}
      </Button>
    </div>
  );
}
