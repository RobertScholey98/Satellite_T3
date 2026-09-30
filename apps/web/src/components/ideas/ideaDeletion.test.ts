import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useComposerDraftStore, partializeComposerDraftStoreState } from "../../composerDraftStore";
import { useQueuedMessageStore } from "../../queuedMessageStore";
import { useIdeaWorkspaceStore, readIdeaPosition, saveIdeaPosition } from "./ideaWorkspaceStore";
import { clearDeletedIdea } from "./ideaDeletion";

vi.mock("../../lib/attachmentUploadQueue", () => ({ releaseDraftAttachments: vi.fn() }));

describe("idea deletion on a client", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    useQueuedMessageStore.setState({ queuesByThreadKey: {}, lastDispatchByThreadKey: {} });
    useIdeaWorkspaceStore.setState({ workspaces: {}, lastSelected: null });
  });

  it("retains idea ownership through composer persistence so offline deletion can clear it", () => {
    const ref = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("idea"));
    const key = scopedThreadKey(ref);
    useComposerDraftStore.getState().setPrompt(ref, "Unsent idea text");
    useComposerDraftStore.setState((state) => ({
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [key]: { ...state.draftsByThreadKey[key]!, purpose: "idea" },
      },
    }));
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    const restored = useComposerDraftStore.persist.getOptions().merge!(
      persisted,
      useComposerDraftStore.getState(),
    );
    expect(restored.draftsByThreadKey[key]?.purpose).toBe("idea");
    expect(restored.draftsByThreadKey[key]?.prompt).toBe("Unsent idea text");
  });

  it("purges only the idea in the affected environment, including queued follow-ups and unfinished edits", () => {
    const deleted = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("same-id"));
    const remote = scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("same-id"));
    const work = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("work"));
    for (const ref of [deleted, remote, work]) {
      const key = scopedThreadKey(ref);
      useComposerDraftStore.getState().setPrompt(ref, `Draft for ${key}`);
      useQueuedMessageStore.getState().enqueue(key, {
        purpose: ref === work ? "work" : "idea",
        prompt: `Queued for ${key}`,
        images: [],
        files: [],
        terminalContexts: [],
        previewAnnotations: [],
        reviewComments: [],
        sendSettings: {
          modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
          runtimeMode: "full-access",
          interactionMode: "default",
          promptEffort: null,
        },
        queuedAfterToolActivityId: null,
        createdAt: "2026-09-30T00:00:00Z",
      });
      useIdeaWorkspaceStore.getState().open(key, { kind: "thread", id: "thread" });
      useIdeaWorkspaceStore.getState().setDraft(key, "pitch", {
        baseRevision: 1,
        title: "",
        categoryId: "",
        markdown: `Pitch ${key}`,
      });
      saveIdeaPosition(key, "pitch", 150);
    }
    useIdeaWorkspaceStore.getState().select(deleted.environmentId, deleted.threadId);
    clearDeletedIdea(deleted);
    const key = scopedThreadKey(deleted);
    expect(useComposerDraftStore.getState().getComposerDraft(deleted)).toBeNull();
    expect(useQueuedMessageStore.getState().queuesByThreadKey[key]).toBeUndefined();
    expect(useIdeaWorkspaceStore.getState().workspaces[key]).toBeUndefined();
    expect(useIdeaWorkspaceStore.getState().lastSelected).toBeNull();
    expect(readIdeaPosition(key, "pitch")).toBe(0);
    for (const ref of [remote, work]) {
      const retained = scopedThreadKey(ref);
      expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toBe(
        `Draft for ${retained}`,
      );
      expect(useQueuedMessageStore.getState().queuesByThreadKey[retained]?.[0]?.prompt).toBe(
        `Queued for ${retained}`,
      );
      expect(useIdeaWorkspaceStore.getState().workspaces[retained]?.drafts.pitch?.markdown).toBe(
        `Pitch ${retained}`,
      );
      expect(readIdeaPosition(retained, "pitch")).toBe(150);
    }
  });
});
