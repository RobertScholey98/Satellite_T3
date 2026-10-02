import {
  EnvironmentId,
  ProjectId,
  type IssueBoardColumn,
  type IssueBoardSummary,
  type IssueBoardSync,
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
const state = vi.hoisted(() => ({
  projects: [] as unknown[],
  environments: [] as unknown[],
  boardSync: undefined as IssueBoardSync | null | undefined,
}));
const draggable = vi.hoisted(() =>
  vi.fn((_options: { id: string; disabled: boolean }) => ({
    setNodeRef: () => {},
    transform: null,
    isDragging: false,
  })),
);

vi.mock("~/state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("~/state/issues", () => ({
  issuesEnvironment: commands,
  useIssueBoardSync: (ref: unknown) => (ref ? state.boardSync : undefined),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("~/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/utils")>()),
  randomUUID: () => "request-id",
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div data-board-content>{children}</div>,
  useDraggable: draggable,
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
vi.mock("./IssueReadyColumnsPicker", () => ({
  IssueReadyColumnsPicker: ({
    columns,
    value,
    onChange,
    disabled,
  }: {
    columns: readonly IssueBoardColumn[];
    value: readonly string[];
    onChange: (columns: string[]) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="Ready for development"
      multiple
      value={value}
      disabled={disabled}
      onChange={(event) =>
        onChange(Array.from(event.target.selectedOptions, (option) => option.value))
      }
    >
      {columns.map((column) => (
        <option key={column.id} value={column.id}>
          {column.title}
        </option>
      ))}
    </select>
  ),
}));

import { createMemoryStorage } from "~/lib/storage";
import { IssuesBoard } from "./IssuesBoard";
import { clearIssuesSnapshots } from "./issues-view-state";

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

const synced: IssueBoardSync = {
  revision: 1,
  syncedAt: "2026-10-02T09:14:00.000Z",
  syncing: false,
  failure: null,
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
    sync: synced,
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
let mounted: ReactElement | null = null;
async function mount(
  target?: Parameters<typeof IssuesBoard>[0]["target"],
  onSyncChange?: (syncing: boolean) => void,
) {
  mounted = (
    <IssuesBoard
      {...(target ? { target } : {})}
      {...(onSyncChange ? { onSyncChange } : {})}
      onSelectBoard={onSelectBoard}
    />
  );
  await act(async () => {
    renderer = create(mounted!);
  });
}
/** Delivers a new server sync state to the mounted board. */
async function serverSync(sync: IssueBoardSync | null | undefined) {
  state.boardSync = sync;
  await act(async () => {
    renderer!.update(cloneElement(mounted!));
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
  await act(async () => {
    dialog.findByProps({ "aria-label": "Ready for development" }).props.onChange({
      target: { selectedOptions: [{ value: "ready" }] },
    });
  });
  for (const [index, column] of ["progress", "review", "done"].entries()) {
    await act(async () => {
      dialog.findAllByType("select")[index + 1]!.props.onChange({ target: { value: column } });
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
  clearIssuesSnapshots();
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const command of Object.values(commands)) command.mockReset();
  onSelectBoard.mockClear();
  draggable.mockClear();
  state.boardSync = undefined;
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
  it("shows a discovery failure in the picker and retries without entering board details", async () => {
    commands.listBoards
      .mockResolvedValueOnce(AsyncResult.success([]))
      .mockRejectedValueOnce(new Error("Azure CLI request failed"));
    await mount();
    await click("Connect board");
    let dialog = renderer!.root.findByProps({ role: "dialog" });
    expect(text(dialog)).toContain("Could not discover boards");
    expect(text(dialog)).toContain("Azure CLI request failed");
    expect(dialog.findAllByType("input")).toHaveLength(0);
    await click("Retry discovery", dialog);
    dialog = renderer!.root.findByProps({ role: "dialog" });
    expect(text(dialog)).toContain(discovered.title);
    expect(text(dialog)).not.toContain("Could not discover boards");
    expect(commands.openBoard).not.toHaveBeenCalled();
  });

  it("keeps the picker visible while discovery loads and updates it when boards arrive", async () => {
    const discovery =
      deferred<ReturnType<typeof AsyncResult.success<readonly IssueBoardSummary[]>>>();
    commands.listBoards
      .mockResolvedValueOnce(AsyncResult.success([]))
      .mockReturnValueOnce(discovery.promise);
    await mount();
    await click("Connect board");
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    expect(text(dialog)).toContain("Finding available boards");
    expect(dialog.findAllByType("input")).toHaveLength(0);
    await act(async () => discovery.resolve(AsyncResult.success([discovered])));
    expect(text(renderer!.root.findByProps({ role: "dialog" }))).toContain(discovered.title);
  });
  it("enters with connected boards only and asks the host only for the Connect board dialog", async () => {
    restoreSavedBoard();
    await mount();
    expect(commands.listBoards.mock.calls.map(([call]) => call.input)).toEqual([
      { projectId: firstProjectId, connectedOnly: true },
    ]);
    await click("Connect board");
    expect(commands.listBoards.mock.calls.map(([call]) => call.input)).toEqual([
      { projectId: firstProjectId, connectedOnly: true },
      { projectId: firstProjectId },
    ]);
  });

  it("opens the board named by the URL without waiting for the board list", async () => {
    const listing =
      deferred<ReturnType<typeof AsyncResult.success<readonly IssueBoardSummary[]>>>();
    commands.listBoards.mockReturnValueOnce(listing.promise);
    commands.openBoard.mockResolvedValueOnce(AsyncResult.success(boardView(saved)));
    await mount({ environmentId, projectId: firstProjectId, boardId: saved.id });
    expect(commands.openBoard.mock.calls.map(([call]) => call.input)).toEqual([
      { projectId: firstProjectId, boardId: saved.id },
    ]);
    await act(async () => listing.resolve(AsyncResult.success([saved])));
    expect(commands.openBoard).toHaveBeenCalledTimes(1);
    expect(boardText()).toContain(`${saved.title} issue`);
  });

  it("keeps cards draggable while the server syncs and reports the sync", async () => {
    restoreSavedBoard();
    const syncing = vi.fn();
    state.boardSync = { ...synced, syncing: true };
    await mount(undefined, syncing);
    expect(draggable).toHaveBeenLastCalledWith({ id: "saved-board-item", disabled: false });
    expect(syncing).toHaveBeenLastCalledWith(true);
    expect(text(renderer!.root)).toContain("Syncing…");
    await serverSync(synced);
    expect(syncing).toHaveBeenLastCalledWith(false);
  });

  it("reopens the stored board once for a higher server revision and not for an equal one", async () => {
    restoreSavedBoard();
    await mount();
    commands.openBoard.mockResolvedValue(
      AsyncResult.success({ ...boardView(saved), sync: { ...synced, revision: 2 } }),
    );
    await serverSync(synced);
    expect(commands.openBoard).toHaveBeenCalledTimes(1);
    await serverSync({ ...synced, revision: 2, syncing: true });
    await serverSync({ ...synced, revision: 2 });
    expect(commands.openBoard.mock.calls.map(([call]) => call.input)).toEqual([
      { projectId: firstProjectId, boardId: saved.id },
      { projectId: firstProjectId, boardId: saved.id },
    ]);
  });

  it("clears the board when the server reports it disconnected elsewhere", async () => {
    restoreSavedBoard();
    await mount();
    expect(boardText()).toContain(`${saved.title} issue`);
    await serverSync(null);
    expect(boardText()).toBe("");
    expect(onSelectBoard).toHaveBeenLastCalledWith({ environmentId, projectId: firstProjectId });
  });

  it("asks the server to read the host on Refresh board", async () => {
    restoreSavedBoard();
    await mount();
    await click("Refresh board");
    expect(commands.openBoard.mock.calls.at(-1)![0].input).toEqual({
      projectId: firstProjectId,
      boardId: saved.id,
      refresh: true,
    });
  });

  it("shows when the board last synced and offers Retry after a failed sync", async () => {
    restoreSavedBoard();
    await mount();
    expect(text(renderer!.root)).toContain("Synced ");
    await serverSync({
      ...synced,
      failure: { at: "2026-10-02T09:20:00.000Z", message: "Board unavailable" },
    });
    expect(text(renderer!.root)).toContain("Sync failed");
    expect(text(renderer!.root)).toContain("Board unavailable");
    await click("Retry");
    expect(commands.openBoard.mock.calls.at(-1)![0].input).toEqual({
      projectId: firstProjectId,
      boardId: saved.id,
      refresh: true,
    });
  });

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
      onSelectBoard.mockClear();
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
      input: {
        projectId: firstProjectId,
        locator: discovered.locator,
        mapping: { ...mapping, ready: ["ready"] },
      },
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

    await click("Second project");

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
    await click("Second project");
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

    await click("Second project");
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

describe("cached issues navigation", () => {
  it("restores repository-list mode and search after remount", async () => {
    await mount();
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Issue list" }).props.onClick();
    });
    await act(async () => {
      renderer!.root
        .findByProps({ "aria-label": "Search issues" })
        .props.onChange({ target: { value: "remember this" } });
    });
    await act(async () => renderer!.unmount());
    await mount();
    expect(renderer!.root.findByProps({ "aria-label": "Issue list" }).props["aria-pressed"]).toBe(
      true,
    );
    expect(renderer!.root.findByProps({ "aria-label": "Search issues" }).props.value).toBe(
      "remember this",
    );
  });

  it("restores cached ticket details while refreshing the selected ticket", async () => {
    restoreSavedBoard();
    const issue = boardView(saved).items[0]!.issue;
    commands.get.mockResolvedValue(
      AsyncResult.success({ ...issue, body: "Cached ticket description" }),
    );
    const target = {
      environmentId,
      projectId: firstProjectId,
      boardId: saved.id,
      issueId: issue.ref.id,
    };
    await mount(target);
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    await act(async () => renderer!.unmount());
    commands.get.mockReturnValue(new Promise(() => {}));
    await mount(target);
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(text(renderer!.root)).not.toContain("Loading full issue details");
    expect(commands.get).toHaveBeenCalledTimes(2);
  });
  it("keeps the saved board visible on remount while discovery refreshes and after a refresh error", async () => {
    restoreSavedBoard();
    await mount();
    expect(boardText()).toContain(saved.title + " issue");
    await act(async () => renderer!.unmount());
    const loading =
      deferred<ReturnType<typeof AsyncResult.success<readonly IssueBoardSummary[]>>>();
    commands.listBoards.mockReturnValue(loading.promise);
    await mount();
    expect(boardText()).toContain(saved.title + " issue");
    commands.openBoard.mockRejectedValue(new Error("Offline"));
    await act(async () => loading.resolve(AsyncResult.success([saved])));
    expect(boardText()).toContain(saved.title + " issue");
    expect(text(renderer!.root)).toContain("Offline");
  });

  it("clears an old board immediately when navigating within the same project", async () => {
    restoreSavedBoard();
    await mount({ environmentId, projectId: firstProjectId, boardId: saved.id });
    expect(boardText()).toContain(saved.title + " issue");
    commands.listBoards.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      renderer!.update(
        <IssuesBoard
          target={{ environmentId, projectId: firstProjectId, boardId: "another-board" }}
        />,
      );
    });
    expect(boardText()).toBe("");
  });

  it("clears the old ticket detail when navigating to another ticket in the same project", async () => {
    restoreSavedBoard();
    const view = boardView(saved);
    const first = view.items[0]!;
    const second = {
      ...first,
      itemId: "second-item",
      issue: {
        ...first.issue,
        ref: { ...first.issue.ref, id: "second-issue", number: 43 },
        title: "Second ticket",
      },
    };
    commands.openBoard
      .mockReset()
      .mockResolvedValue(AsyncResult.success({ ...view, items: [first, second] }));
    commands.get.mockResolvedValue(
      AsyncResult.success({ ...first.issue, body: "First description" }),
    );
    await mount({
      environmentId,
      projectId: firstProjectId,
      boardId: saved.id,
      issueId: first.issue.ref.id,
    });
    commands.get.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      renderer!.update(
        <IssuesBoard
          target={{
            environmentId,
            projectId: firstProjectId,
            boardId: saved.id,
            issueId: second.issue.ref.id,
          }}
        />,
      );
    });
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    expect(text(dialog)).toContain("Second ticket");
    expect(text(dialog)).toContain("Loading full issue details");
  });

  it("does not restore a different board's ticket", async () => {
    restoreSavedBoard();
    const issue = boardView(saved).items[0]!.issue;
    commands.get.mockResolvedValue(AsyncResult.success({ ...issue, body: "Cached description" }));
    await mount({
      environmentId,
      projectId: firstProjectId,
      boardId: saved.id,
      issueId: issue.ref.id,
    });
    await act(async () => renderer!.unmount());
    commands.listBoards.mockReturnValue(new Promise(() => {}));
    await mount({ environmentId, projectId: firstProjectId, boardId: "another-board" });
    expect(boardText()).toBe("");
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  it("never shows another project's cached board", async () => {
    restoreSavedBoard();
    await mount();
    await act(async () => renderer!.unmount());
    commands.listBoards.mockReturnValue(new Promise(() => {}));
    await mount({ environmentId, projectId: secondProjectId });
    expect(boardText()).toBe("");
  });

  it("reports syncing until every request finishes and clears the header on unmount", async () => {
    const discovery =
      deferred<ReturnType<typeof AsyncResult.success<readonly IssueBoardSummary[]>>>();
    const issues =
      deferred<ReturnType<typeof AsyncResult.success<{ issues: never[]; nextCursor: null }>>>();
    commands.listBoards.mockReturnValue(discovery.promise);
    commands.list.mockReturnValue(issues.promise);
    const syncing = vi.fn();
    await act(async () => {
      renderer = create(<IssuesBoard onSyncChange={syncing} />);
    });
    expect(syncing).toHaveBeenLastCalledWith(true);
    await act(async () => discovery.resolve(AsyncResult.success([])));
    expect(syncing).toHaveBeenLastCalledWith(true);
    await act(async () => issues.resolve(AsyncResult.success({ issues: [], nextCursor: null })));
    expect(syncing).toHaveBeenLastCalledWith(false);
    await act(async () => renderer!.unmount());
    expect(syncing).toHaveBeenLastCalledWith(false);
  });
});
