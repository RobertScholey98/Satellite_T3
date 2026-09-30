import { useId } from "react";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { Checkbox } from "../ui/checkbox";

export function DraftIdeaToggle({
  draftId,
  disabled,
  onSelectIdea,
}: {
  draftId: DraftId;
  disabled: boolean;
  onSelectIdea: () => void;
}) {
  const descriptionId = useId();
  const draft = useComposerDraftStore((state) => state.getDraftSession(draftId));
  const isIdea = draft?.purpose === "idea";
  if (!draft) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <label className="flex items-center gap-2 text-sm text-foreground">
        <Checkbox
          aria-label="Idea"
          aria-describedby={descriptionId}
          checked={isIdea}
          disabled={disabled}
          onCheckedChange={(checked) => {
            useComposerDraftStore.getState().setDraftThreadContext(draftId, {
              purpose: checked ? "idea" : "work",
              ...(checked ? { envMode: "local", branch: null, worktreePath: null } : {}),
            });
            if (checked) onSelectIdea();
          }}
        />
        Idea
      </label>
      <span id={descriptionId} className="text-xs text-muted-foreground">
        {isIdea
          ? "Explore in a notebook with Claude. Project code stays unchanged."
          : "Explore an idea before starting implementation."}
      </span>
    </div>
  );
}
