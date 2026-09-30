import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useQueuedMessageStore } from "../../queuedMessageStore";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import { useIdeaWorkspaceStore } from "./ideaWorkspaceStore";
export function clearDeletedIdea(threadRef: ScopedThreadRef) {
  const key = scopedThreadKey(threadRef);
  releaseComposerDraftUploads(threadRef);
  useComposerDraftStore.getState().clearDraftThread(threadRef);
  const queued = useQueuedMessageStore.getState().queuesByThreadKey[key] ?? [];
  for (const message of queued) {
    releaseDraftAttachments([...message.images, ...message.files]);
    for (const attachment of [...message.images, ...message.files])
      if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
  }
  useQueuedMessageStore.setState((current) => {
    const queuesByThreadKey = { ...current.queuesByThreadKey };
    const lastDispatchByThreadKey = { ...current.lastDispatchByThreadKey };
    delete queuesByThreadKey[key];
    delete lastDispatchByThreadKey[key];
    return { queuesByThreadKey, lastDispatchByThreadKey };
  });
  useIdeaWorkspaceStore.getState().remove(key);
}
