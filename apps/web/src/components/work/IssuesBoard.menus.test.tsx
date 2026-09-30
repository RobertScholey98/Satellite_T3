// @vitest-environment jsdom

import {
  EnvironmentId,
  ProjectId,
  type IssueBoardSummary,
  type IssueBoardView,
  type IssueSummary,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./IssueStartDialog", () => ({ IssueStartDialog: () => null }));

import { IssuesBoard } from "./IssuesBoard";

const environmentId = EnvironmentId.make("menu-environment");
const firstProjectId = ProjectId.make("first-project");
const secondProjectId = ProjectId.make("second-project");
const firstBoard: IssueBoardSummary = {
  id: "first-board",
  projectId: firstProjectId,
  title: "First connected board",
  locator: {
    kind: "github-project",
    host: "github.com",
    owner: "owner",
    ownerKind: "organization",
    projectNumber: 1,
  },
  mapping: {
    ready: "ready",
    inProgress: "progress",
    inPullRequest: "review",
    completed: "done",
    moveOnMerge: false,
  },
};
const secondBoard: IssueBoardSummary = {
  ...firstBoard,
  id: "second-board",
  title: "Second connected board",
};
const discoveredBoard: IssueBoardSummary = {
  ...firstBoard,
  id: "discovered-board",
  title: "Unconnected discovery",
  mapping: null,
};
const issues: IssueSummary[] = [
  { title: "Public open issue", state: "open", host: "github.com" },
  { title: "Public closed issue", state: "closed", host: "github.com" },
  { title: "Enterprise open issue", state: "open", host: "github.example.com" },
].map(({ title, state, host }, index) => ({
  title,
  state,
  ref: {
    hostKind: "github",
    host,
    repository: "owner/repo",
    id: `issue-${index}`,
    number: index + 1,
    url: `https://${host}/owner/repo/issues/${index + 1}`,
  },
  labels: [],
  updatedAt: "2026-09-30T00:00:00Z",
}));
const onSelectBoard = vi.fn();
let root: Root;
let container: HTMLDivElement;

function button(label: string) {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(element, `Missing button: ${label}`).toBeDefined();
  return element!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function menuItem(label: string, role = "menuitem") {
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  expect(menu, "The menu should be open").not.toBeNull();
  const item = [...menu!.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(item, `Missing menu item: ${label}`).toBeDefined();
  return item!;
}

function visibleIssueTitles() {
  return issues
    .filter((issue) => container.textContent?.includes(issue.title))
    .map((issue) => issue.title);
}

async function mount() {
  await act(async () => root.render(<IssuesBoard onSelectBoard={onSelectBoard} />));
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
  commands.list.mockResolvedValue(AsyncResult.success({ issues, nextCursor: null }));
  commands.listBoards.mockResolvedValue(AsyncResult.success([]));
  commands.openBoard.mockImplementation(async ({ input }: { input: { boardId: string } }) => {
    const board = input.boardId === secondBoard.id ? secondBoard : firstBoard;
    const view: IssueBoardView = {
      board,
      columns: [],
      items: [],
      attempts: [],
      moves: [],
    };
    return AsyncResult.success(view);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("IssuesBoard menus", () => {
  it("opens the local project menu and selects another project", async () => {
    await mount();
    await click(button("Project: First project · Test machine"));
    await click(menuItem("Second project · Test machine"));
    expect(onSelectBoard).toHaveBeenCalledWith({ environmentId, projectId: secondProjectId });
    expect(button("Project: Second project · Test machine")).toBeDefined();
    expect(commands.listBoards).toHaveBeenLastCalledWith({
      environmentId,
      input: { projectId: secondProjectId },
    });
  });

  it("opens the connected board menu and selects another saved board", async () => {
    commands.listBoards.mockResolvedValue(
      AsyncResult.success([firstBoard, secondBoard, discoveredBoard]),
    );
    await mount();
    await click(button("Board: First connected board"));
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain(
      discoveredBoard.title,
    );
    await click(menuItem(secondBoard.title));
    expect(commands.openBoard).toHaveBeenLastCalledWith({
      environmentId,
      input: { projectId: firstProjectId, boardId: secondBoard.id },
    });
    expect(onSelectBoard).toHaveBeenCalledWith({
      environmentId,
      projectId: firstProjectId,
      boardId: secondBoard.id,
    });
    expect(button("Board: Second connected board")).toBeDefined();
  });

  it("filters the issue list by state and host, then clears both filters", async () => {
    await mount();
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Issue list"]')!);
    expect(visibleIssueTitles()).toEqual(issues.map((issue) => issue.title));

    await click(button("Filters"));
    await click(menuItem("open", "menuitemradio"));
    expect(visibleIssueTitles()).toEqual(["Public open issue", "Enterprise open issue"]);

    expect(button("Filters · 1")).toBeDefined();
    expect(menuItem("open", "menuitemradio").getAttribute("aria-checked")).toBe("true");
    await click(menuItem("github.example.com", "menuitemradio"));
    expect(visibleIssueTitles()).toEqual(["Enterprise open issue"]);

    expect(button("Filters · 2")).toBeDefined();
    expect(menuItem("github.example.com", "menuitemradio").getAttribute("aria-checked")).toBe(
      "true",
    );
    await click(menuItem("Clear filters"));
    expect(button("Filters")).toBeDefined();
    expect(visibleIssueTitles()).toEqual(issues.map((issue) => issue.title));
  });
});
