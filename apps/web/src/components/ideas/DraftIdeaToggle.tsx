import { BrainIcon } from "lucide-react";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { ComposerControl, ComposerControlIcon } from "../chat/ComposerControl";

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
    <ComposerControl
      size="xs"
      aria-label="Idea"
      aria-pressed={isIdea}
      disabled={disabled}
      onClick={() => {
        useComposerDraftStore.getState().setDraftThreadContext(draftId, {
          purpose: isIdea ? "work" : "idea",
          ...(!isIdea ? { envMode: "local", branch: null, worktreePath: null } : {}),
        });
        if (!isIdea) onSelectIdea();
      }}
    >
      <ComposerControlIcon icon={BrainIcon} size="xs" />
      Idea
    </ComposerControl>
  );
}
