// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { resolveSendEnvMode } from "../ChatView.logic";
import { DraftIdeaToggle } from "./DraftIdeaToggle";

const draftId = DraftId.make("home-draft");
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(
      scopeProjectRef(EnvironmentId.make("local"), ProjectId.make("project")),
      draftId,
      {
        threadId: ThreadId.make("idea"),
        envMode: "worktree",
        branch: "main",
        worktreePath: "/old-worktree",
      },
    );
  useComposerDraftStore.getState().setPrompt(draftId, "Explore a different creation flow.");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("home draft idea toggle", () => {
  it("switches an unsent draft into an isolated idea and back without losing its prompt", async () => {
    await act(async () =>
      root.render(<DraftIdeaToggle draftId={draftId} disabled={false} onSelectIdea={() => {}} />),
    );
    const checkbox = container.querySelector<HTMLElement>('[role="checkbox"][aria-label="Idea"]');
    expect(checkbox).not.toBeNull();
    await act(async () => checkbox!.click());
    const idea = useComposerDraftStore.getState().getDraftSession(draftId)!;
    expect(idea).toMatchObject({
      purpose: "idea",
      envMode: "local",
      branch: null,
      worktreePath: null,
    });
    expect(
      resolveSendEnvMode({
        requestedEnvMode: "worktree",
        isGitRepo: true,
        purpose: idea.purpose ?? "work",
      }),
    ).toBe("local");
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "Explore a different creation flow.",
    );
    await act(async () => checkbox!.click());
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.purpose).toBe("work");
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "Explore a different creation flow.",
    );
  });
});
