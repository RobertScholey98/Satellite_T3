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
  const draft = useComposerDraftStore((state) => state.getDraftSession(draftId));
  const isIdea = draft?.purpose === "idea";
  if (!draft) return null;
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <Checkbox
        aria-label="Idea"
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
  );
}
