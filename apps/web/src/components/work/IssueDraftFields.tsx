import type { DraftId } from "~/composerDraftStore";
import { useIssueDraftStore } from "~/issueDraftStore";
import { Input } from "../ui/input";
import { validWorktreeName } from "./work.logic";

export function IssueDraftFields({ draftId }: { draftId: DraftId }) {
  const intent = useIssueDraftStore((state) => state.intents[draftId]);
  if (!intent) return null;
  return (
    <div className="mb-3 grid gap-2">
      <a
        href={intent.issue.url}
        target="_blank"
        rel="noreferrer"
        className="w-fit max-w-full truncate rounded-md border px-2 py-1 text-xs"
      >
        #{intent.issue.number} · {intent.title}
      </a>
      <label className="grid gap-1 text-xs">
        Worktree name
        <Input
          value={intent.worktreeName}
          onChange={(event) =>
            useIssueDraftStore
              .getState()
              .set(draftId, { ...intent, worktreeName: event.target.value })
          }
          placeholder="issue-123"
        />
      </label>
      {!validWorktreeName(intent.worktreeName) ? (
        <p className="text-xs text-destructive">Enter a valid Git branch name for this worktree.</p>
      ) : null}
    </div>
  );
}
