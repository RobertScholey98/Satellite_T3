// @vitest-environment jsdom

import {
  EnvironmentId,
  ProjectId,
  type IssueBoardColumn,
  type IssueBoardSummary,
  type IssueBoardView,
  type IssueSummary,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
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
vi.mock("~/state/issues", () => ({
  issuesEnvironment: commands,
  useIssueBoardSync: () => undefined,
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: <T,>(select: (settings: { timestampFormat: "24-hour" }) => T) =>
    select({ timestampFormat: "24-hour" }),
}));
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
const columns: IssueBoardColumn[] = [
  { id: "ready", title: "Ready" },
  { id: "refinement", title: "Ready for refinement" },
  { id: "progress", title: "In progress" },
  { id: "review", title: "In PR" },
  { id: "done", title: "Completed" },
];
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
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === label,
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
      columns,
      items: [],
      attempts: [],
      moves: [],
      sync: { revision: 1, syncedAt: "2026-10-02T09:14:00.000Z", syncing: false, failure: null },
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
  it("shows breadcrumb projects without machine names and keeps unconnected projects available for setup", async () => {
    commands.listBoards.mockImplementation(async ({ input }: { input: { projectId: ProjectId } }) =>
      AsyncResult.success(input.projectId === firstProjectId ? [firstBoard] : [discoveredBoard]),
    );
    await mount();
    const breadcrumb = container.querySelector('nav[aria-label="Issue board"]');
    expect(breadcrumb?.textContent).toContain("First project");
    expect(breadcrumb?.textContent).toContain("First connected board");
    expect(breadcrumb?.textContent).not.toContain("Test machine");
    await click(button("First project"));
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Test machine");
    expect(menuItem("First project").textContent).not.toContain("No board");
    expect(menuItem("Second project").textContent).toContain("No board");
    await click(menuItem("Second project"));
    expect(onSelectBoard).toHaveBeenCalledWith({ environmentId, projectId: secondProjectId });
    expect(container.textContent).toContain("No board connected to Second project");
    await click(button("Connect board"));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("does not describe a failed connection lookup as a project with no board", async () => {
    commands.listBoards.mockImplementation(
      async ({ input }: { input: { connectedOnly?: boolean } }) => {
        if (input.connectedOnly) throw new Error("Environment unavailable");
        return AsyncResult.success([firstBoard]);
      },
    );
    await mount();
    await click(button("First project"));
    expect(menuItem("Second project").textContent).not.toContain("No board");
    await click(menuItem("Second project"));
    expect(onSelectBoard).toHaveBeenCalledWith({ environmentId, projectId: secondProjectId });
  });

  it("loads a legacy ready column and saves multiple ready columns without changing move destinations", async () => {
    commands.listBoards.mockResolvedValue(AsyncResult.success([firstBoard]));
    commands.configureBoard.mockImplementation(
      async ({ input }: { input: { mapping: NonNullable<IssueBoardSummary["mapping"]> } }) =>
        AsyncResult.success({
          board: { ...firstBoard, mapping: input.mapping },
          columns,
          items: [],
          attempts: [],
          moves: [],
        }),
    );
    await mount();
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Board settings"]')!);
    await click(menuItem("Column mapping"));

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector('button[aria-label="Remove Ready"]')).not.toBeNull();
    expect([...dialog!.querySelectorAll("select")].map((select) => select.value)).toEqual([
      "progress",
      "review",
      "done",
    ]);
    await click(
      dialog!.querySelector<HTMLButtonElement>('button[aria-label="Ready for development"]')!,
    );
    const refinement = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.trim() === "Ready for refinement",
    );
    expect(refinement).toBeDefined();
    await click(refinement!);
    expect(dialog!.querySelector('button[aria-label="Remove Ready"]')).not.toBeNull();
    expect(
      dialog!.querySelector('button[aria-label="Remove Ready for refinement"]'),
    ).not.toBeNull();
    const save = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "Save mapping",
    )!;
    expect(save.disabled).toBe(false);
    await click(save);

    expect(commands.configureBoard).toHaveBeenCalledWith({
      environmentId,
      input: {
        requestId: expect.any(String),
        projectId: firstProjectId,
        locator: firstBoard.locator,
        mapping: { ...firstBoard.mapping, ready: ["ready", "refinement"] },
      },
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("requires at least one ready column before saving a mapping", async () => {
    commands.listBoards.mockResolvedValue(AsyncResult.success([firstBoard]));
    await mount();
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Board settings"]')!);
    await click(menuItem("Column mapping"));

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const save = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "Save mapping",
    )!;
    expect(save.disabled).toBe(false);
    await click(dialog.querySelector<HTMLButtonElement>('button[aria-label="Remove Ready"]')!);
    expect(save.disabled).toBe(true);
    await click(save);
    expect(commands.configureBoard).not.toHaveBeenCalled();

    await click(
      dialog.querySelector<HTMLButtonElement>('button[aria-label="Ready for development"]')!,
    );
    const ready = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.trim() === "Ready",
    );
    expect(ready).toBeDefined();
    await click(ready!);
    expect(save.disabled).toBe(false);
  });

  it("opens the local project menu and selects another project", async () => {
    await mount();
    await click(button("First project"));
    await click(menuItem("Second project"));
    expect(onSelectBoard).toHaveBeenCalledWith({ environmentId, projectId: secondProjectId });
    expect(button("Second project")).toBeDefined();
    expect(commands.listBoards).toHaveBeenLastCalledWith({
      environmentId,
      input: { projectId: secondProjectId, connectedOnly: true },
    });
  });

  it("opens the connected board menu and selects another saved board", async () => {
    commands.listBoards.mockResolvedValue(
      AsyncResult.success([firstBoard, secondBoard, discoveredBoard]),
    );
    await mount();
    await click(button("First connected board"));
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
    expect(button("Second connected board")).toBeDefined();
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
