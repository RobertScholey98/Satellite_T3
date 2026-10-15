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
vi.mock("react", () => ({
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
  useCopyToClipboard: () => ({ copyToClipboard: () => recordEffect("copy") }),
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

const target = {
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
};
const position = { x: 10, y: 20 };
const createMenu = () => {
  const menu = useThreadActionMenu({ startRename: () => recordEffect("rename") });
  return { openMenu: (at: typeof position) => menu.openMenu(target, at) };
};

beforeEach(() => {
  state.granted = new Set(["primary"]);
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
    ["copy-thread-id", "copy"],
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

  it("gives the sidebar, legacy sidebar and header the same actions for one thread", () => {
    state.granted = new Set(["secondary"]);
    const header = useThreadActionMenu({ startRename: () => {} }).readMenuItems(target);
    const legacySidebar = useThreadActionMenu({
      startRename: () => {},
      openProjectSettings: () => {},
    }).readMenuItems(target);
    const sidebar = useThreadActionMenu({
      startRename: () => {},
      settle: () => {},
      snooze: () => {},
      openProjectSettings: () => {},
      projectFilter: { read: () => ({ label: "Web", isActive: false }), toggle: () => {} },
    }).readMenuItems(target);

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
    useThreadActionMenu({
      startRename: () => {},
      projectFilter: {
        read: () => ({ label: "Web", isActive: false }),
        toggle: (threadRef) => {
          toggled.push(threadRef.threadId);
          state.completed.resolve();
        },
      },
    }).openMenu(target, position);
    await state.completed.promise;
    expect(toggled).toEqual(["thread"]);
  });

  it("lets the sidebar park a thread its own way", async () => {
    state.granted = new Set(["secondary"]);
    const parked: string[] = [];
    state.show.mockResolvedValue("settle");
    useThreadActionMenu({
      startRename: () => {},
      settle: (threadRef) => {
        parked.push(threadRef.threadId);
        state.completed.resolve();
      },
    }).openMenu(target, position);
    await state.completed.promise;
    expect(parked).toEqual(["thread"]);
    expect(state.effects).toEqual([]);
  });
});
