import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  type ContextMenuItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  linkedPullRequestUrl: null as string | null,
  branchPullRequestUrl: null as string | null,
  effects: [] as string[],
  completed: deferred<void>(),
  show: vi.fn<
    (
      items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
      position: { x: number; y: number },
    ) => Promise<ThreadActionMenuId | null>
  >(),
}));

function recordEffect(action: string) {
  state.effects.push(action);
  state.completed.resolve();
}

vi.mock("../components/CustomSnoozeDialog", () => ({ requestCustomSnooze: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: async () => recordEffect("project-settings") }),
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.granted.has(environmentId),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readEnvironmentSupportsTitleRegeneration: () => true,
  readProject: () => null,
  readThreadShell: () => ({
    id: "thread",
    environmentId: "secondary",
    projectId: "project",
    title: "Thread",
    branch: "main",
    worktreePath: null,
    runtime: null,
    latestRun: null,
    pullRequests: [],
    linkedPullRequest: state.linkedPullRequestUrl ? { url: state.linkedPullRequestUrl } : null,
    branchPullRequest: state.branchPullRequestUrl ? { url: state.branchPullRequestUrl } : null,
  }),
  useProjects: () => [{ id: "project", environmentId: "secondary" }],
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateMetadata: "metadata" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    recordEffect("metadata");
    return AsyncResult.success(undefined);
  },
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: state.show, close: () => {} },
    dialogs: {
      confirm: async () => {
        recordEffect("confirm");
        return false;
      },
    },
  }),
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "project",
  derivePhysicalProjectKey: () => "project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../sidebarProjectGrouping", () => ({
  buildPhysicalToLogicalProjectKeyMap: () => new Map(),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadUnread: () => recordEffect("mark-unread"),
    }),
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: () => state.completed.resolve() },
}));
vi.mock("../components/Sidebar.snooze", () => ({
  resolveSnoozePresets: () => [
    { id: "hour", label: "In 1 hour", whenLabel: "3 PM", snoozedUntil: "2099-01-01T00:00:00Z" },
  ],
  snoozeWakeDescription: () => "later",
}));
vi.mock("./useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copyToClipboard: (value: string) => recordEffect(`copy:${value}`),
  }),
  writeTextToClipboard: async (value: string) => {
    recordEffect("clipboard:" + value);
    return true;
  },
}));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => recordEffect("draft"),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      confirmThreadDelete: true,
      confirmThreadArchive: true,
      timestampFormat: "12-hour",
    }),
}));
vi.mock("./useThreadActions", () => ({
  useThreadActions: () =>
    Object.fromEntries(
      [
        "markThreadUnread",
        "settleThread",
        "unsettleThread",
        "snoozeThread",
        "unsnoozeThread",
        "pinThread",
        "confirmAndUnpinThread",
        "archiveThread",
        "deleteThread",
        "regenerateThreadTitle",
      ].map((action) => [
        action,
        async () => {
          recordEffect(
            action === "markThreadUnread"
              ? "mark-unread"
              : action === "regenerateThreadTitle"
                ? "metadata"
                : action,
          );
          return AsyncResult.success(undefined);
        },
      ]),
    ),
}));

import { useThreadActionMenu } from "./useThreadActionMenu";
import { buildThreadActionPaletteItems } from "../components/threadActionPalette";

const target = {
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
};
const position = { x: 10, y: 20 };
const createMenu = () => {
  const menu = useThreadActionMenu();
  return {
    openMenu: (at: typeof position) =>
      menu.openMenu(target, at, { startRename: () => recordEffect("rename") }),
  };
};

beforeEach(() => {
  state.granted = new Set(["primary"]);
  state.linkedPullRequestUrl = null;
  state.branchPullRequestUrl = null;
  state.effects = [];
  state.completed = deferred<void>();
  state.show.mockReset().mockResolvedValue(null);
});

describe("thread menu permissions", () => {
  it("disables mutations for a denied secondary environment", () => {
    createMenu().openMenu(position);
    const items = state.show.mock.calls[0]![0];
    expect(items.find((item) => item.id === "rename")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "delete")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "copy")?.disabled).not.toBe(true);
  });

  it("allows the target grant even when the primary environment is denied", () => {
    state.granted = new Set(["secondary"]);
    createMenu().openMenu(position);
    expect(state.show.mock.calls[0]![0].find((item) => item.id === "rename")?.disabled).not.toBe(
      true,
    );
  });

  it("refreshes availability when a retained menu opener gains permission", () => {
    const menu = createMenu();
    menu.openMenu(position);
    expect(state.show.mock.calls[0]![0].find((item) => item.id === "rename")?.disabled).toBe(true);
    state.granted.add("secondary");
    menu.openMenu(position);
    expect(state.show.mock.calls[1]![0].find((item) => item.id === "rename")?.disabled).not.toBe(
      true,
    );
  });

  it.each(["rename", "regenerate-title", "delete", "pin", "settle", "archive"] as const)(
    "%s rechecks after the native menu closes",
    async (action) => {
      state.granted.add("secondary");
      const choice = deferred<ThreadActionMenuId | null>();
      state.show.mockReturnValue(choice.promise);
      createMenu().openMenu(position);
      state.granted.delete("secondary");
      choice.resolve(action);
      await state.completed.promise;
      expect(state.effects).toEqual([]);
    },
  );

  it.each([
    ["new-thread-on-branch", "draft"],
    ["copy-thread-id", "copy:thread"],
    ["mark-unread", "mark-unread"],
    ["project-settings", "project-settings"],
  ] as const)("keeps %s available without task permission", async (action, effect) => {
    state.show.mockResolvedValue(action);
    createMenu().openMenu(position);
    await state.completed.promise;
    expect(state.effects).toEqual([effect]);
  });
});

describe("one registry for every thread menu", () => {
  const leafIds = (items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>): string[] =>
    items.flatMap((item) => (item.children ? leafIds(item.children) : [item.id]));

  it("gives both sidebars, the header and the palette the same actions for one thread", () => {
    state.granted = new Set(["secondary"]);
    const { readMenuItems } = useThreadActionMenu();
    const header = readMenuItems(target);
    const legacySidebar = readMenuItems(target, {
      startRename: () => {},
      openProjectSettings: () => {},
    });
    const sidebar = readMenuItems(target, {
      startRename: () => {},
      settle: () => {},
      snooze: () => {},
      openProjectSettings: () => {},
      projectFilter: { read: () => ({ label: "Web", isActive: false }), toggle: () => {} },
    });

    const shared = [
      "new-thread-on-branch",
      "pin",
      "settle",
      "snooze:hour",
      "snooze:custom",
      "rename",
      "regenerate-title",
      "mark-unread",
      "auto-settle:enabled",
      "auto-settle:disabled",
      "copy-path",
      "copy-branch",
      "copy-thread-id",
      "project-settings",
      "archive",
      "delete",
    ];
    expect(leafIds(header)).toEqual(shared);
    expect(leafIds(legacySidebar)).toEqual(shared);
    const palette = buildThreadActionPaletteItems({ items: header, run: async () => {} });
    expect(
      palette.flatMap((entry) =>
        entry.kind === "submenu"
          ? entry.groups.flatMap((group) => group.items.map((child) => child.value))
          : [entry.value],
      ),
    ).toEqual(shared.map((id) => `thread-action:${id}`));
    expect(leafIds(sidebar)).toEqual([
      ...shared.slice(0, shared.indexOf("mark-unread") + 1),
      "filter-by-project",
      ...shared.slice(shared.indexOf("mark-unread") + 1),
    ]);
  });

  it("routes filter-by-project to the sidebar's scope control", async () => {
    state.granted = new Set(["secondary"]);
    const toggled: string[] = [];
    state.show.mockResolvedValue("filter-by-project");
    useThreadActionMenu().openMenu(target, position, {
      projectFilter: {
        read: () => ({ label: "Web", isActive: false }),
        toggle: (threadRef) => {
          toggled.push(threadRef.threadId);
          state.completed.resolve();
        },
      },
    });
    await state.completed.promise;
    expect(toggled).toEqual(["thread"]);
  });

  it("lets the sidebar park a thread its own way", async () => {
    state.granted = new Set(["secondary"]);
    const parked: string[] = [];
    state.show.mockResolvedValue("settle");
    useThreadActionMenu().openMenu(target, position, {
      settle: (threadRef) => {
        parked.push(threadRef.threadId);
        state.completed.resolve();
      },
    });
    await state.completed.promise;
    expect(parked).toEqual(["thread"]);
    expect(state.effects).toEqual([]);
  });
});

describe("thread keybindings", () => {
  const menu = () => useThreadActionMenu();

  it("resolve to the registry action for the thread's current state", () => {
    state.granted = new Set(["secondary"]);
    expect(menu().shortcutAction(target, "thread.pin")).toBe("pin");
    expect(menu().shortcutAction(target, "thread.settle")).toBe("settle");
    expect(menu().shortcutAction(target, "thread.copyReference")).toBe("copy-thread-id");
    expect(menu().shortcutAction(target, "terminal.toggle")).toBeNull();
  });

  it("copy the linked pull request as the thread's reference", async () => {
    state.linkedPullRequestUrl = "https://github.com/o/r/pull/7";
    const actions = menu();
    expect(actions.shortcutAction(target, "thread.copyReference")).toBe("copy-reference");
    await actions.runAction(target, "copy-reference");
    expect(state.effects).toEqual(["clipboard:https://github.com/o/r/pull/7"]);
  });

  it("prefer the pull request open in the surface's panel", async () => {
    state.linkedPullRequestUrl = "https://github.com/o/r/pull/7";
    await useThreadActionMenu().runAction(target, "copy-reference", {
      openPanelPullRequestUrl: "https://github.com/o/r/pull/9",
    });
    expect(state.effects).toEqual(["clipboard:https://github.com/o/r/pull/9"]);
  });

  it("copy nothing while the panel's pull request link is loading", async () => {
    state.linkedPullRequestUrl = "https://github.com/o/r/pull/7";
    const surface = { openPanelPullRequestUrl: null };
    expect(menu().shortcutAction(target, "thread.copyReference", surface)).toBe("unavailable");
    await menu().runAction(target, "copy-reference", surface);
    expect(state.effects).toEqual([]);
  });

  it("follow the surface's linked pull request over the branch's", async () => {
    state.branchPullRequestUrl = "https://github.com/o/r/pull/3";
    expect(menu().shortcutAction(target, "thread.copyReference")).toBe("copy-reference");
    expect(
      menu().shortcutAction(target, "thread.copyReference", { linkedPullRequestUrl: null }),
    ).toBe("copy-thread-id");
    await menu().runAction(target, "copy-reference");
    expect(state.effects).toEqual(["clipboard:https://github.com/o/r/pull/3"]);
  });
});

describe("copy path", () => {
  it("falls back to the legacy sidebar's project root when the thread has none of its own", async () => {
    await useThreadActionMenu().runAction(target, "copy-path", {
      fallbackWorkspaceRoot: "/workspace/group",
    });
    expect(state.effects).toEqual(["copy:/workspace/group"]);
  });
});
