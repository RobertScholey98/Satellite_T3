import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useIdeaWorkspaceStore } from "./ideaWorkspaceStore";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { clearDeletedIdea } from "./ideaDeletion";
import { useEffect } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { ideaEnvironment } from "../../state/ideas";
import { useEnvironmentQuery } from "../../state/query";

function EnvironmentCleanup({ environmentId }: { environmentId: EnvironmentId }) {
  const { data } = useEnvironmentQuery(ideaEnvironment.changes({ environmentId, input: {} }));
  useEffect(() => {
    if (data?.purged) clearDeletedIdea({ environmentId, threadId: data.threadId });
  }, [data, environmentId]);
  const list = useEnvironmentQuery(ideaEnvironment.list({ environmentId, input: {} }));
  const workspaces = useIdeaWorkspaceStore((state) => state.workspaces);
  const drafts = useComposerDraftStore((state) => state.draftsByThreadKey);
  const creating = useComposerDraftStore((state) => state.draftThreadsByThreadKey);
  const keys = new Set([
    ...Object.keys(workspaces),
    ...Object.keys(drafts).filter((key) => drafts[key]?.purpose === "idea"),
  ]);
  return list.data
    ? [...keys].flatMap((key) => {
        const ref = parseScopedThreadKey(key);
        if (
          !ref ||
          ref.environmentId !== environmentId ||
          (creating[key]?.purpose === "idea" && !creating[key]?.promotedTo) ||
          list.data?.ideas.some((idea) => idea.threadId === ref.threadId)
        )
          return [];
        return [<MissingIdea key={key} threadRef={ref} />];
      })
    : null;
}

function MissingIdea({ threadRef }: { threadRef: ScopedThreadRef }) {
  const query = useEnvironmentQuery(
    ideaEnvironment.get({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  useEffect(() => {
    if (query.data?.notebook === null)
      clearDeletedIdea({ environmentId: threadRef.environmentId, threadId: threadRef.threadId });
  }, [query.data, threadRef.environmentId, threadRef.threadId]);
  return null;
}

export function IdeaDeletionCleanup() {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <EnvironmentCleanup key={environment.environmentId} environmentId={environment.environmentId} />
  ));
}
