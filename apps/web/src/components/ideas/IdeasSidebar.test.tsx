// @vitest-environment jsdom

import { EnvironmentId, IdeaSummary } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Sidebar, SidebarProvider, SidebarTrigger } from "../ui/sidebar";
import { IdeasSidebar } from "./IdeasSidebar";

const state = vi.hoisted(() => ({ mobile: false }));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => state.mobile }));
vi.mock("../sidebar/SidebarChrome", () => ({ SidebarUtilityMenu: () => null }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: EnvironmentId.make("local"), label: "Local" },
      { environmentId: EnvironmentId.make("remote"), label: "Remote" },
    ],
  }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { environmentId: "local", id: "project", title: "Local project" },
    { environmentId: "remote", id: "project", title: "Remote project" },
  ],
}));
vi.mock("../../state/ideas", () => ({ ideaEnvironment: { list: (input: unknown) => input } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: { environmentId: EnvironmentId }) => ({
    data: { ideas: input.environmentId === "local" ? localIdeas : remoteIdeas },
    error: null,
    isPending: false,
  }),
}));

const summary = Schema.decodeUnknownSync(IdeaSummary);
const localIdeas = [
  summary({
    threadId: "shared-id",
    projectId: "project",
    title: "Local notebook",
    status: "active",
    updatedAt: "2026-10-01T00:00:00.000Z",
    revision: 1,
    excerpt: "Organize documents",
    updateStatus: "current",
    deletionError: null,
  }),
  summary({
    threadId: "settled-id",
    projectId: "project",
    title: "Completed idea",
    status: "settled",
    updatedAt: "2026-10-01T00:00:00.000Z",
    revision: 1,
    excerpt: "Published issues",
    updateStatus: "current",
    deletionError: null,
  }),
];
const remoteIdeas = [
  summary({
    ...localIdeas[0],
    title: "Remote notebook",
    excerpt: "Explore architecture",
  }),
];

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  state.mobile = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("cookieStore", { set: async () => {} });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openIdeas(
  options: { readonly initialEntry?: string; readonly loadIdeas?: () => Promise<void> } = {},
) {
  function AppShell() {
    const pathname = useLocation({ select: (location) => location.pathname });
    return (
      <SidebarProvider>
        <Sidebar>{pathname === "/ideas" ? <IdeasSidebar /> : null}</Sidebar>
        <SidebarTrigger aria-label="Open idea sidebar" />
        <Outlet />
      </SidebarProvider>
    );
  }
  const rootRoute = createRootRoute({ component: AppShell });
  const chat = createRoute({ getParentRoute: () => rootRoute, id: "_chat", component: Outlet });
  const index = createRoute({ getParentRoute: () => chat, path: "/" });
  const ideas = createRoute({
    getParentRoute: () => chat,
    path: "ideas",
    validateSearch: (search: Record<string, unknown>) => ({
      environment: typeof search.environment === "string" ? search.environment : undefined,
      idea: typeof search.idea === "string" ? search.idea : undefined,
    }),
    ...(options.loadIdeas ? { beforeLoad: options.loadIdeas } : {}),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([chat.addChildren([index, ideas])]),
    history: createMemoryHistory({
      initialEntries: [options.initialEntry ?? "/ideas?environment=local&idea=shared-id"],
    }),
  });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

function ideaButton(title: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.startsWith(title),
  )!;
}

describe("Ideas sidebar", () => {
  it("keeps the root shell usable while the Ideas route is loading", async () => {
    let finishLoading!: () => void;
    let signalLoading!: () => void;
    const loading = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalLoading = resolve;
    });
    const router = await openIdeas({
      initialEntry: "/",
      loadIdeas: () => {
        signalLoading();
        return loading;
      },
    });
    let navigation = Promise.resolve();
    try {
      await act(async () => {
        navigation = router.navigate({
          to: "/ideas",
          search: { environment: "remote", idea: "shared-id" },
        });
        await started;
      });
      expect(ideaButton("Remote notebook")?.getAttribute("aria-current")).toBe("page");
      expect(ideaButton("Local notebook").getAttribute("aria-current")).toBeNull();
    } finally {
      await act(async () => {
        finishLoading();
        await navigation;
      });
    }
    expect(ideaButton("Remote notebook").getAttribute("aria-current")).toBe("page");
    await act(async () => router.navigate({ to: "/" }));
    expect(ideaButton("Remote notebook")).toBeUndefined();
  });

  it("keeps selection scoped to its environment while filtering pitches and browsing settled ideas", async () => {
    const router = await openIdeas();
    expect(ideaButton("Local notebook").getAttribute("aria-current")).toBe("page");
    expect(ideaButton("Remote notebook").getAttribute("aria-current")).toBeNull();
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Find an idea"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "architecture",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ideaButton("Local notebook")).toBeUndefined();
    await act(async () => ideaButton("Remote notebook").click());
    expect(router.state.location.search).toEqual({ environment: "remote", idea: "shared-id" });
    expect(ideaButton("Remote notebook").getAttribute("aria-current")).toBe("page");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const settled = ideaButton("Settled");
    expect(settled.getAttribute("aria-expanded")).toBe("false");
    await act(async () => settled.click());
    expect(settled.getAttribute("aria-expanded")).toBe("true");
    await act(async () => ideaButton("Completed idea").click());
    expect(router.state.location.search).toEqual({ environment: "local", idea: "settled-id" });
  });

  it("displays the selected project label and can restore all environments' ideas", async () => {
    await openIdeas();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter ideas by project"]',
    )!;
    const selectProject = async (label: string) => {
      await act(async () => trigger.click());
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (item) => item.textContent?.trim() === label,
      );
      expect(option).toBeDefined();
      await act(async () => option!.click());
    };

    await selectProject("Remote project · Remote");
    expect(trigger.textContent?.trim()).toBe("Remote project · Remote");
    expect(ideaButton("Remote notebook")).toBeDefined();
    expect(ideaButton("Local notebook")).toBeUndefined();

    await selectProject("Local project · Local");
    expect(trigger.textContent?.trim()).toBe("Local project · Local");
    expect(ideaButton("Local notebook")).toBeDefined();
    expect(ideaButton("Remote notebook")).toBeUndefined();

    await selectProject("All projects");
    expect(trigger.textContent?.trim()).toBe("All projects");
    expect(ideaButton("Local notebook")).toBeDefined();
    expect(ideaButton("Remote notebook")).toBeDefined();
  });

  it("opens the standard narrow-screen sheet and closes it after choosing an idea", async () => {
    state.mobile = true;
    const router = await openIdeas();
    const wrapper = container.querySelector('[data-slot="sidebar-wrapper"]')!;
    expect(wrapper.getAttribute("data-sidebar-state")).toBe("collapsed");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Open idea sidebar"]')!.click(),
    );
    expect(wrapper.getAttribute("data-sidebar-state")).toBe("expanded");
    await act(async () => ideaButton("Remote notebook").click());
    expect(router.state.location.search).toEqual({ environment: "remote", idea: "shared-id" });
    expect(wrapper.getAttribute("data-sidebar-state")).toBe("collapsed");
  });
});
