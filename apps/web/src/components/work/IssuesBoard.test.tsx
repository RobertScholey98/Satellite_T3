import {
  EnvironmentId,
  ProjectId,
  type IssueBoardSummary,
  type IssueBoardView,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({
  list: vi.fn(),
  listBoards: vi.fn(),
  openBoard: vi.fn(),
  get: vi.fn(),
  move: vi.fn(),
  retryMove: vi.fn(),
  disconnectBoard: vi.fn(),
  configureBoard: vi.fn(),
}));
const state = vi.hoisted(() => ({ projects: [] as unknown[], environments: [] as unknown[] }));

vi.mock("~/state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("~/state/issues", () => ({ issuesEnvironment: commands }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("~/lib/utils", () => ({ randomUUID: () => "request-id" }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div data-board-content>{children}</div>,
  useDraggable: () => ({ setNodeRef: vi.fn(), transform: null, isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/input-group", () => ({
  InputGroup: "div",
  InputGroupAddon: "span",
  InputGroupInput: "input",
}));
vi.mock("../ui/switch", () => ({ Switch: "input" }));
vi.mock("../ui/empty", () => ({
  Empty: "div",
  EmptyHeader: "header",
  EmptyMedia: "div",
  EmptyTitle: "h2",
  EmptyDescription: "p",
  EmptyContent: "div",
}));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuPopup: "div",
  MenuItem: "button",
  MenuSeparator: "hr",
  MenuGroup: "div",
  MenuGroupLabel: "span",
  MenuRadioGroup: "div",
  MenuRadioItem: "button",
  MenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogPopup: "div",
  DialogHeader: "header",
  DialogTitle: "h1",
  DialogDescription: "p",
  DialogPanel: "div",
  DialogFooter: "footer",
}));
vi.mock("../pullRequest/PullRequestMarkdown", () => ({ PullRequestMarkdown: () => null }));
vi.mock("../pullRequest/PullRequestListRow", () => ({ PullRequestRowLines: () => null }));
vi.mock("./IssueStartDialog", () => ({ IssueStartDialog: () => null }));

import { IssuesBoard } from "./IssuesBoard";

const environmentId = EnvironmentId.make("test-environment");
const firstProjectId = ProjectId.make("first-project");
const secondProjectId = ProjectId.make("second-project");
const mapping = {
  ready: "ready",
  inProgress: "progress",
  inPullRequest: "review",
  completed: "done",
  moveOnMerge: false,
};
const discovered: IssueBoardSummary = {
  id: "discovered-board",
  projectId: firstProjectId,
  title: "Account-wide discovery",
  locator: {
    kind: "github-project",
    host: "github.com",
    owner: "other-owner",
    ownerKind: "organization",
    projectNumber: 9,
  },
  mapping: null,
};
const saved: IssueBoardSummary = {
  ...discovered,
  id: "saved-board",
  title: "Connected project board",
  mapping,
  locator: {
    kind: "github-project",
    host: "github.com",
    ownerKind: "organization",
    owner: "project-owner",
    projectNumber: 1,
  },
};

function boardView(board: IssueBoardSummary): IssueBoardView {
  return {
    board,
    columns: Object.values(mapping)
      .filter((value): value is string => typeof value === "string")
      .map((id) => ({ id, title: id })),
    items: [
      {
        itemId: `${board.id}-item`,
        columnId: "ready",
        version: null,
        issue: {
          ref: {
            hostKind: "github",
            host: "github.com",
            repository: "owner/repo",
            id: `${board.id}-issue`,
            number: 42,
            url: "https://github.com/owner/repo/issues/42",
          },
          title: `${board.title} issue`,
          state: "open",
          updatedAt: "2026-09-30T00:00:00Z",
          labels: [],
        },
      },
    ],
    attempts: [],
    moves: [],
  };
}

let renderer: ReactTestRenderer | null = null;
const onSelectBoard = vi.fn();

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}
function button(label: string, root = renderer!.root) {
  return root.findAllByType("button").find((node) => text(node) === label)!;
}
async function click(label: string, root = renderer!.root) {
  const control = button(label, root);
  expect(control, `Missing button: ${label}`).toBeDefined();
  expect(control.props.disabled).not.toBe(true);
  await act(async () => {
    control.props.onClick();
  });
}
function boardText() {
  return renderer!.root.findAllByProps({ "data-board-content": true }).map(text).join("");
}
async function mount(target?: Parameters<typeof IssuesBoard>[0]["target"]) {
  await act(async () => {
    renderer = create(
      <IssuesBoard {...(target ? { target } : {})} onSelectBoard={onSelectBoard} />,
    );
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function previewDiscovery() {
  await click("Connect board");
  const dialog = renderer!.root.findByProps({ role: "dialog" });
  const candidate = dialog
    .findAllByType("button")
    .find((node) => text(node).includes(discovered.title));
  expect(candidate, "The connection dialog should offer discovered boards").toBeDefined();
  await act(async () => {
    candidate!.props.onClick();
  });
}
function restoreSavedBoard() {
  commands.listBoards.mockResolvedValue(AsyncResult.success([discovered, saved]));
  commands.openBoard.mockResolvedValueOnce(AsyncResult.success(boardView(saved)));
}
async function chooseMapping(dialog: ReactTestInstance) {
  for (const [index, column] of ["ready", "progress", "review", "done"].entries()) {
    await act(async () => {
      dialog.findAllByType("select")[index]!.props.onChange({ target: { value: column } });
    });
  }
}
async function setConnection(phase: "connected" | "disconnected") {
  state.environments = [
    {
      environmentId,
      label: "Test machine",
      connection: { phase },
      serverConfig: { environment: { capabilities: { issueBoards: true } } },
    },
  ];
  await act(async () => {
    renderer!.update(<IssuesBoard onSelectBoard={onSelectBoard} />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const command of Object.values(commands)) command.mockReset();
  onSelectBoard.mockClear();
  state.projects = [
    { id: firstProjectId, environmentId, title: "First project", workspaceRoot: "C:/first" },
    { id: secondProjectId, environmentId, title: "Second project", workspaceRoot: "C:/second" },
  ];
  state.environments = [
    {
      environmentId,
      label: "Test machine",
      connection: { phase: "connected" },
      serverConfig: { environment: { capabilities: { issueBoards: true } } },
    },
  ];
  commands.list.mockResolvedValue(AsyncResult.success({ issues: [], nextCursor: null }));
  commands.listBoards.mockResolvedValue(AsyncResult.success([discovered]));
  commands.openBoard.mockResolvedValue(AsyncResult.success(boardView(discovered)));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("project board selection", () => {
  it("leaves account-wide discoveries unselected on entering a project", async () => {
    await mount();
    expect(commands.openBoard).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(boardText()).toBe("");
    expect(onSelectBoard).not.toHaveBeenCalled();
  });

  it("restores a connected board even when a discovery is returned first", async () => {
    restoreSavedBoard();
    await mount();

    expect(commands.openBoard).toHaveBeenCalledTimes(1);
    expect(commands.openBoard.mock.calls[0]![0]).toMatchObject({
      input: { projectId: firstProjectId, boardId: saved.id },
    });
    expect(boardText()).toContain(`${saved.title} issue`);
    expect(boardText()).not.toContain(`${discovered.title} issue`);
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(button(discovered.title)).toBeUndefined();
  });

  it("does not restore another board for an explicit unconnected target", async () => {
    restoreSavedBoard();
    await mount({ environmentId, projectId: firstProjectId, boardId: discovered.id });

    expect(commands.openBoard).not.toHaveBeenCalled();
    expect(boardText()).toBe("");
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  it.each([false, true])(
    "keeps a discovered preview out of the board when cancelled (connected board: %s)",
    async (hasSavedBoard) => {
      if (hasSavedBoard) restoreSavedBoard();
      await mount();
      const before = boardText();
      commands.openBoard.mockResolvedValue(AsyncResult.success(boardView(discovered)));

      await previewDiscovery();

      expect(commands.openBoard.mock.calls.at(-1)![0]).toMatchObject({
        input: { projectId: firstProjectId, locator: discovered.locator },
      });
      expect(renderer!.root.findByProps({ role: "dialog" }).findAllByType("select")).toHaveLength(
        4,
      );
      expect(boardText()).toBe(before);
      expect(onSelectBoard).not.toHaveBeenCalled();

      await click("Cancel", renderer!.root.findByProps({ role: "dialog" }));

      expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
      expect(boardText()).toBe(before);
      expect(boardText()).not.toContain(`${discovered.title} issue`);
      expect(commands.configureBoard).not.toHaveBeenCalled();
      expect(onSelectBoard).not.toHaveBeenCalled();
    },
  );

  it("commits the discovered board only after its mapping is saved", async () => {
    await mount();
    await previewDiscovery();
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    await chooseMapping(dialog);
    const configured = { ...discovered, mapping };
    const saving = deferred<ReturnType<typeof AsyncResult.success<IssueBoardView>>>();
    commands.configureBoard.mockReturnValue(saving.promise);

    await click("Save mapping", dialog);

    expect(boardText()).toBe("");
    expect(onSelectBoard).not.toHaveBeenCalled();
    expect(commands.configureBoard.mock.calls[0]![0]).toMatchObject({
      input: { projectId: firstProjectId, locator: discovered.locator, mapping },
    });

    await act(async () => {
      saving.resolve(AsyncResult.success(boardView(configured)));
    });

    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(boardText()).toContain(`${discovered.title} issue`);
    expect(onSelectBoard).toHaveBeenCalledWith({
      environmentId,
      projectId: firstProjectId,
      boardId: discovered.id,
    });
    expect(button(discovered.title)).toBeDefined();
  });

  it("clears the board on project change and ignores a late refresh from the old project", async () => {
    restoreSavedBoard();
    await mount();
    expect(boardText()).toContain(`${saved.title} issue`);
    const refreshing = deferred<ReturnType<typeof AsyncResult.success<IssueBoardView>>>();
    commands.openBoard.mockReturnValueOnce(refreshing.promise);
    await click("Refresh board");
    commands.listBoards.mockResolvedValue(AsyncResult.success([discovered]));

    await click("Second project · Test machine");

    expect(boardText()).toBe("");
    await act(async () => {
      refreshing.resolve(AsyncResult.success(boardView(saved)));
    });
    expect(boardText()).toBe("");
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(commands.openBoard).toHaveBeenCalledTimes(2);
    expect(onSelectBoard).toHaveBeenLastCalledWith({ environmentId, projectId: secondProjectId });
  });

  it("ignores board discoveries returned after their project has been left", async () => {
    const firstListing =
      deferred<ReturnType<typeof AsyncResult.success<readonly IssueBoardSummary[]>>>();
    const secondBoard = {
      ...saved,
      id: "second-board",
      projectId: secondProjectId,
      title: "Second project board",
    };
    commands.listBoards
      .mockReturnValueOnce(firstListing.promise)
      .mockResolvedValueOnce(AsyncResult.success([secondBoard]));
    commands.openBoard.mockResolvedValue(AsyncResult.success(boardView(secondBoard)));
    await mount();
    await click("Second project · Test machine");
    expect(boardText()).toContain(`${secondBoard.title} issue`);

    await act(async () => {
      firstListing.resolve(AsyncResult.success([discovered, saved]));
    });

    expect(commands.openBoard).toHaveBeenCalledTimes(1);
    expect(boardText()).toContain(`${secondBoard.title} issue`);
    expect(boardText()).not.toContain(`${saved.title} issue`);
    expect(button(discovered.title)).toBeUndefined();
  });

  it("keeps a disconnected board unselected when the project is opened again", async () => {
    restoreSavedBoard();
    commands.disconnectBoard.mockResolvedValue(AsyncResult.success(undefined));
    await mount();
    expect(boardText()).toContain(`${saved.title} issue`);

    await click("Disconnect board");

    expect(boardText()).toBe("");
    expect(commands.disconnectBoard.mock.calls[0]![0]).toMatchObject({
      input: { boardId: saved.id },
    });
    await act(async () => {
      renderer!.unmount();
    });
    commands.listBoards.mockResolvedValue(
      AsyncResult.success([{ ...saved, mapping: null }, discovered]),
    );
    await mount();

    expect(boardText()).toBe("");
    expect(commands.openBoard).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  it("does not commit a mapping saved after its project has been left", async () => {
    await mount();
    await previewDiscovery();
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    await chooseMapping(dialog);
    const saving = deferred<ReturnType<typeof AsyncResult.success<IssueBoardView>>>();
    commands.configureBoard.mockReturnValue(saving.promise);
    await click("Save mapping", dialog);

    await click("Second project · Test machine");
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    await act(async () => {
      saving.resolve(AsyncResult.success(boardView({ ...discovered, mapping })));
    });

    expect(boardText()).toBe("");
    expect(button(discovered.title)).toBeUndefined();
    expect(onSelectBoard).toHaveBeenCalledTimes(1);
    expect(onSelectBoard).toHaveBeenCalledWith({ environmentId, projectId: secondProjectId });
  });

  it("closes connection setup when the environment disconnects and accepts a fresh setup after reconnecting", async () => {
    await mount();
    await previewDiscovery();
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(1);

    await setConnection("disconnected");

    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(boardText()).toBe("");
    await setConnection("connected");
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);

    await previewDiscovery();
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    await chooseMapping(dialog);
    commands.configureBoard.mockResolvedValue(
      AsyncResult.success(boardView({ ...discovered, mapping })),
    );
    await click("Save mapping", dialog);

    expect(boardText()).toContain(`${discovered.title} issue`);
    expect(onSelectBoard).toHaveBeenCalledWith({
      environmentId,
      projectId: firstProjectId,
      boardId: discovered.id,
    });
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });
});
