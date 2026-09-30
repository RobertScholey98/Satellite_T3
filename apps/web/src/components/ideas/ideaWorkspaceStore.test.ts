import { beforeEach, describe, expect, it } from "vite-plus/test";
import { IdeaArtifactId, IdeaEntryId } from "@t3tools/contracts";
import {
  ideaTabKey,
  readIdeaPosition,
  saveIdeaPosition,
  useIdeaWorkspaceStore,
} from "./ideaWorkspaceStore";

describe("idea workspace", () => {
  beforeEach(() => useIdeaWorkspaceStore.setState({ workspaces: {} }));

  it("keeps Thread first and distinguishes the same id across resource kinds", () => {
    const store = useIdeaWorkspaceStore.getState();
    store.open("idea", { kind: "entry", id: IdeaEntryId.make("thread") });
    store.open("idea", { kind: "artifact", id: IdeaArtifactId.make("thread") });
    store.open("idea", { kind: "entry", id: IdeaEntryId.make("thread") });
    store.close("idea", "thread");
    expect(useIdeaWorkspaceStore.getState().workspaces.idea?.tabs.map(ideaTabKey)).toEqual([
      "thread",
      "entry:thread",
      "artifact:thread",
    ]);
    expect(useIdeaWorkspaceStore.getState().workspaces.idea?.activeTab).toBe("entry:thread");
    store.close("idea", "entry:thread");
    expect(useIdeaWorkspaceStore.getState().workspaces.idea?.tabs.map(ideaTabKey)).toEqual([
      "thread",
      "artifact:thread",
    ]);
    expect(useIdeaWorkspaceStore.getState().workspaces.idea?.activeTab).toBe("thread");
  });

  it("preserves drafts and reading positions through collapse and removes them on deletion", () => {
    const store = useIdeaWorkspaceStore.getState();
    store.open("first", { kind: "entry", id: IdeaEntryId.make("note") });
    store.setDraft("first", "entry:note", {
      markdown: "My revision",
      baseRevision: 2,
      title: "Plan",
      categoryId: "notes",
    });
    saveIdeaPosition("first", "entry:note", 340);
    store.toggle("first");
    store.open("other", { kind: "thread", id: "thread" });
    expect(useIdeaWorkspaceStore.getState().workspaces.first?.drafts["entry:note"]?.markdown).toBe(
      "My revision",
    );
    expect(readIdeaPosition("first", "entry:note")).toBe(340);
    store.remove("first");
    expect(useIdeaWorkspaceStore.getState().workspaces.first).toBeUndefined();
    expect(readIdeaPosition("first", "entry:note")).toBe(0);
    expect(useIdeaWorkspaceStore.getState().workspaces.other?.tabs).toEqual([
      { kind: "thread", id: "thread" },
    ]);
  });
});
