import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useComposerDraftStore } from "../../composerDraftStore";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import { useIdeaWorkspaceStore } from "./ideaWorkspaceStore";
export function clearDeletedIdea(threadRef: ScopedThreadRef) {
  const key = scopedThreadKey(threadRef);
  releaseComposerDraftUploads(threadRef);
  useComposerDraftStore.getState().clearDraftThread(threadRef);
  useIdeaWorkspaceStore.getState().remove(key);
}
