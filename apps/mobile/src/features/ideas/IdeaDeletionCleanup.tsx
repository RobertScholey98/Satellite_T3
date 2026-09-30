import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { knownIdeaWorkspaceKeys } from "./ideaWorkspace";
import {
  clearOwnedAttachmentDownloads,
  listOwnedAttachmentDownloadKeys,
} from "../../lib/attachmentDownload";
import { acknowledgedThreadMessagesAtom } from "../../state/acknowledged-thread-messages";
import { clearPendingThreadCreationOutcome } from "../../state/pending-thread-creation";
import { useEffect, useState } from "react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadOutboxManager } from "../../state/thread-outbox";
import { removeThreadOutboxMessage } from "../../state/thread-outbox-removal";
import {
  clearComposerDraft,
  composerDraftsAtom,
  flushComposerDrafts,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { questionAttachmentDraftPrefix } from "../../state/question-attachments";
import { useWorkspaceState } from "../../state/workspace";
import { ideaEnvironment } from "../../state/ideas";
import { useEnvironmentQuery } from "../../state/query";
import { forgetIdeaWorkspace } from "./ideaWorkspace";

export async function clearDeletedIdea(ref: ScopedThreadRef) {
  await waitForComposerDraftsLoaded();
  if (!(await threadOutboxManager.load()))
    throw new Error("Could not clear the idea's local queued messages. Reopen Ideas to retry.");
  const key = scopedThreadKey(ref.environmentId, ref.threadId);
  const messages =
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[key] ?? [];
  for (const message of messages) await removeThreadOutboxMessage(message);
  clearComposerDraft(key);
  clearPendingThreadCreationOutcome(key);
  appAtomRegistry.set(
    acknowledgedThreadMessagesAtom,
    appAtomRegistry
      .get(acknowledgedThreadMessagesAtom)
      .filter(
        (message) =>
          message.environmentId !== ref.environmentId || message.threadId !== ref.threadId,
      ),
  );
  const prefix = questionAttachmentDraftPrefix(ref.environmentId, ref.threadId);
  for (const draftKey of Object.keys(appAtomRegistry.get(composerDraftsAtom))) {
    if (draftKey.startsWith(prefix)) clearComposerDraft(draftKey);
  }
  await flushComposerDrafts();
  forgetIdeaWorkspace(key);
  await clearOwnedAttachmentDownloads(key);
}

function EnvironmentCleanup({ environmentId }: { environmentId: EnvironmentId }) {
  const { data } = useEnvironmentQuery(ideaEnvironment.changes({ environmentId, input: {} }));
  useEffect(() => {
    if (data?.purged)
      void clearDeletedIdea({ environmentId, threadId: data.threadId }).catch((error) =>
        console.warn("[ideas] Local deletion cleanup failed", error),
      );
  }, [data, environmentId]);
  const list = useEnvironmentQuery(ideaEnvironment.list({ environmentId, input: {} }));
  const drafts = useAtomValue(composerDraftsAtom);
  const queues = useAtomValue(threadOutboxManager.queuedMessagesByThreadKeyAtom);
  const [cachedKeys, setCachedKeys] = useState<string[]>([]);
  useEffect(() => {
    if (!list.data) return;
    void listOwnedAttachmentDownloadKeys()
      .then(setCachedKeys)
      .catch(() => undefined);
  }, [list.data]);
  const keys = new Set([
    ...knownIdeaWorkspaceKeys(),
    ...cachedKeys,
    ...Object.keys(drafts).filter((key) => drafts[key]?.purpose === "idea"),
    ...Object.keys(queues).filter((key) =>
      queues[key]?.some((message) => message.purpose === "idea"),
    ),
  ]);
  return list.data
    ? [...keys].flatMap((key) => {
        const ref = parseScopedThreadKey(key);
        if (
          !ref ||
          ref.environmentId !== environmentId ||
          queues[key]?.some((message) => message.creation?.purpose === "idea") ||
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
      void clearDeletedIdea({
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
      }).catch((error) => console.warn("[ideas] Local deletion cleanup failed", error));
  }, [query.data, threadRef.environmentId, threadRef.threadId]);
  return null;
}

export function IdeaDeletionCleanup() {
  const { environments } = useWorkspaceState();
  return environments.map((environment) => (
    <EnvironmentCleanup key={environment.environmentId} environmentId={environment.environmentId} />
  ));
}
