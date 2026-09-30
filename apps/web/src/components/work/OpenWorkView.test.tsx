import { EnvironmentId, type OpenWorkTimelineResult } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { OpenWorkView } from "./OpenWorkView";
import { saveOpenWorkSnapshot } from "./openWorkViewState";

const state = vi.hoisted(() => ({ connected: true, command: vi.fn() }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: ["remount", "other"].map((environmentId) => ({
      environmentId,
      label: environmentId,
      connection: { phase: state.connected ? "connected" : "disconnected" },
      serverConfig: { environment: { capabilities: { openWork: true } } },
    })),
  }),
}));
vi.mock("~/state/openWork", () => ({
  openWorkEnvironment: {
    list: "list",
    timeline: "timeline",
    favorites: "favorites",
    readLinked: "readLinked",
  },
}));
vi.mock("~/state/issues", () => ({ issuesEnvironment: {} }));
vi.mock("~/state/documents", () => ({ documentsEnvironment: {} }));
vi.mock("~/state/filesystem", () => ({ filesystemEnvironment: {} }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (input: unknown) => state.command(command, input),
}));
vi.mock("~/lib/utils", () => ({ randomUUID: () => "request" }));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("../ChatMarkdown", () => ({ default: () => null }));
vi.mock("../files/BrowserDocumentFrame", () => ({ BrowserDocumentFrame: () => null }));
vi.mock("./OpenWorkDiffPanel", () => ({ OpenWorkDiffPanel: () => "Restored file diff" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuTrigger: "div",
  MenuPopup: "div",
  MenuRadioGroup: "div",
  MenuRadioItem: "div",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: "div",
  DialogPopup: "div",
  DialogHeader: "div",
  DialogTitle: "div",
  DialogPanel: "div",
  DialogFooter: "div",
}));
const environmentId = EnvironmentId.make("remount");
const timeline: OpenWorkTimelineResult = {
  worktree: {
    id: "tree",
    path: "/tree",
    projectIds: [],
    branch: "Retained branch",
    head: null,
    baseRef: null,
    ahead: null,
    behind: null,
    hasChanges: false,
  },
  commits: [],
  wip: { files: [], insertions: 0, deletions: 0 },
  documents: [],
  folderLinks: [],
};
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
function seed() {
  saveOpenWorkSnapshot(environmentId, {
    worktrees: [timeline.worktree],
    selectedId: "tree",
    timeline,
    favorites: [],
    attempts: [],
    diff: null,
    opened: null,
  });
}
function text() {
  function visit(node: ReactTestRendererJSON | string | null): string {
    if (!node) return "";
    if (typeof node === "string") return node;
    return (node.children ?? []).map(visit).join(" ");
  }
  const value = renderer!.toJSON();
  return Array.isArray(value) ? value.map(visit).join(" ") : visit(value);
}
describe("OpenWorkView remount", () => {
  it("renders retained history immediately during refresh and retains it if refresh fails", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.connected = true;
    seed();
    let reject!: (failure: Error) => void;
    const pending = new Promise((_, failure) => {
      reject = failure;
    });
    state.command.mockImplementation(() => pending);
    const sync = vi.fn();
    await act(async () => {
      renderer = create(
        <OpenWorkView target={{ environmentId, worktreePath: "/tree" }} onSyncChange={sync} />,
      );
    });
    expect(text()).toContain("Retained branch");
    expect(sync).toHaveBeenLastCalledWith(true);
    await act(async () => reject(new Error("Offline refresh")));
    expect(text()).toContain("Retained branch");
    expect(text()).toContain("Offline refresh");
    expect(sync).toHaveBeenLastCalledWith(false);
    act(() => renderer!.unmount());
    state.connected = false;
    await act(async () => {
      renderer = create(<OpenWorkView target={{ environmentId, worktreePath: "/tree" }} />);
    });
    expect(text()).toContain("Retained branch");
  });
  it("restores the selected file and open document when reopening offline", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.connected = false;
    const retained = {
      ...timeline,
      wip: {
        files: [
          {
            path: "file.ts",
            previousPath: null,
            status: "modified" as const,
            layer: "unstaged" as const,
            insertions: 1,
            deletions: 0,
          },
        ],
        insertions: 1,
        deletions: 0,
      },
    };
    saveOpenWorkSnapshot(environmentId, {
      worktrees: [retained.worktree],
      selectedId: "tree",
      timeline: retained,
      favorites: [],
      attempts: [],
      diff: {
        environmentId,
        worktreeId: "tree",
        cwd: "/tree",
        comparison: { kind: "unstaged" },
        file: { path: "file.ts", previousPath: null, sourceKind: "unstaged" },
        title: "Unstaged changes",
      },
      opened: {
        documentId: "plan",
        title: "Retained plan",
        format: "plain",
        content: "Document contents",
        truncated: false,
        live: true,
        cwd: "/tree",
      },
    });
    await act(async () => {
      renderer = create(<OpenWorkView target={{ environmentId, worktreePath: "/tree" }} />);
    });
    expect(text()).toContain("Restored file diff");
    expect(text()).toContain("Retained plan");
    expect(text()).toContain("Document contents");
    act(() => renderer!.unmount());
    await act(async () => {
      renderer = create(<OpenWorkView target={{ environmentId, worktreePath: "/tree" }} />);
    });
    expect(text()).toContain("Restored file diff");
    expect(text()).toContain("Retained plan");
  });
  it("does not reopen a dismissed document when its background read completes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.connected = true;
    const document = {
      id: "live-plan",
      title: "Live plan",
      worktreeId: "tree",
      source: { kind: "linked" as const, folderLinkId: "folder", path: "/tree/plan.md" },
      step: { kind: "wip" as const },
      favorite: false,
      available: true,
      unresolved: null,
    };
    const retained = { ...timeline, documents: [document] };
    saveOpenWorkSnapshot(environmentId, {
      worktrees: [timeline.worktree],
      selectedId: "tree",
      timeline: retained,
      favorites: [],
      attempts: [],
      diff: null,
      opened: {
        documentId: document.id,
        title: document.title,
        format: "plain",
        content: "Cached plan",
        truncated: false,
        live: true,
        cwd: "/tree",
      },
    });
    let resolve!: (value: unknown) => void;
    const read = new Promise((success) => {
      resolve = success;
    });
    state.command.mockImplementation((command: string) => {
      if (command === "readLinked") return read;
      return Promise.resolve({
        _tag: "Success",
        value:
          command === "list"
            ? { worktrees: [timeline.worktree] }
            : command === "timeline"
              ? retained
              : { documents: [] },
      });
    });
    const sync = vi.fn();
    await act(async () => {
      renderer = create(
        <OpenWorkView target={{ environmentId, worktreePath: "/tree" }} onSyncChange={sync} />,
      );
    });
    expect(sync).toHaveBeenLastCalledWith(true);
    const dialog = renderer!.root.findAll(
      (node) => typeof node.props.onOpenChange === "function",
    )[0]!;
    act(() => dialog.props.onOpenChange(false));
    expect(text()).not.toContain("Cached plan");
    expect(sync).toHaveBeenLastCalledWith(false);
    await act(async () =>
      resolve({
        _tag: "Success",
        value: { format: "markdown", content: "New plan", truncated: false },
      }),
    );
    expect(text()).not.toContain("New plan");
    expect(
      renderer!.root.findAll((node) => typeof node.props.onOpenChange === "function"),
    ).toHaveLength(0);
  });
  it("gives explicit worktree and environment targets priority over retained history", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.connected = false;
    seed();
    const selected = vi.fn();
    await act(async () => {
      renderer = create(
        <OpenWorkView
          target={{ environmentId, worktreePath: "/explicit" }}
          onSelectWorktree={selected}
        />,
      );
    });
    expect(renderer!.root.findAllByType("h1")).toHaveLength(0);
    expect(selected).not.toHaveBeenCalled();
    await act(async () =>
      renderer!.update(<OpenWorkView target={{ environmentId: EnvironmentId.make("other") }} />),
    );
    expect(text()).not.toContain("Retained branch");
  });
});
