// @vitest-environment jsdom

import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { NewWorktreeButton } from "./NewWorktreeButton";

const mocks = vi.hoisted(() => ({ create: vi.fn(), toast: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.create }));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { createWorktree: {} } }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("~/state/queries", () => ({
  usePaginatedBranches: ({ query }: { query: string }) => ({
    refs: [
      { name: "main", current: true },
      { name: "origin/main", current: false, isRemote: true },
    ].filter((ref) => ref.name.includes(query)),
    data: { nextCursor: null },
    isPending: false,
    error: null,
  }),
}));

const draftId = DraftId.make("manual-worktree-test");
const projectRef = {
  environmentId: EnvironmentId.make("remote-environment"),
  projectId: ProjectId.make("project-worktrees"),
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.getAnimations = () => [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState());
  useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, {
    branch: "main",
    worktreePath: null,
    envMode: "worktree",
    environmentSelection: "auto",
  });
  useComposerDraftStore
    .getState()
    .setPrompt(draftId, "Keep this prompt while creating a worktree.");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.unstubAllGlobals();
});

async function openDialog() {
  await act(async () =>
    root.render(
      <NewWorktreeButton
        draftId={draftId}
        projectRef={projectRef}
        workspaceRoot={"C:\\code\\appRepo"}
      />,
    ),
  );
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
}

async function enter(placeholder: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(),
  );
}

describe("manual worktree creation", () => {
  it("creates under the project root from a remote ref and selects the returned worktree", async () => {
    mocks.create.mockResolvedValue({
      _tag: "Success",
      value: {
        worktree: { path: "C:/code/appRepo/worktree1", refName: "feature/task" },
      },
    });
    await openDialog();
    await enter("worktree1", "worktree1");
    await enter("feature/my-task", "feature/task");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-slot="combobox-trigger"]')!.click(),
    );
    await enter("Search local and remote branches…", "origin/");
    const remote = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === "origin/main",
    )!;
    await act(async () => remote.click());
    expect(document.body.textContent).toContain("C:\\code\\appRepo\\worktree1");
    await submit();
    expect(mocks.create).toHaveBeenCalledWith({
      environmentId: projectRef.environmentId,
      input: {
        cwd: "C:\\code\\appRepo",
        path: "C:\\code\\appRepo\\worktree1",
        refName: "origin/main",
        newRefName: "feature/task",
      },
    });
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      ...projectRef,
      branch: "feature/task",
      worktreePath: "C:/code/appRepo/worktree1",
      envMode: "worktree",
      environmentSelection: "manual",
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "Keep this prompt while creating a worktree.",
    );
  });

  it("keeps the form and original draft on failure, allowing a corrected retry", async () => {
    mocks.create.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Folder already exists")),
    });
    await openDialog();
    await enter("worktree1", "worktree1");
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Folder already exists",
    );
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.worktreePath).toBeNull();
    mocks.create.mockResolvedValue({
      _tag: "Success",
      value: {
        worktree: { path: "C:\\code\\appRepo\\worktree2", refName: "worktree2" },
      },
    });
    await enter("worktree1", "worktree2");
    await submit();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.branch).toBe("worktree2");
  });

  it("requires a child folder and allows cancelling without changing the draft", async () => {
    await openDialog();
    await enter("worktree1", "../outside");
    await submit();
    expect(mocks.create).not.toHaveBeenCalled();
    const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Cancel",
    )!;
    await act(async () => cancel.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.worktreePath).toBeNull();
  });

  it("does not retarget a draft moved to another environment while creation is pending", async () => {
    let finish = () => {};
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.create.mockImplementation(async () => {
      await response;
      return {
        _tag: "Success",
        value: { worktree: { path: "C:\\code\\appRepo\\worktree1", refName: "worktree1" } },
      };
    });
    await openDialog();
    await enter("worktree1", "worktree1");
    await submit();
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    const otherProject = { ...projectRef, environmentId: EnvironmentId.make("other-environment") };
    useComposerDraftStore.getState().setDraftThreadContext(draftId, { projectRef: otherProject });
    await act(async () => finish());
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      environmentId: otherProject.environmentId,
      worktreePath: null,
    });
    expect(mocks.toast).toHaveBeenCalled();
  });
});
