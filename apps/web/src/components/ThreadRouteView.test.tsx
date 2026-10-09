// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DraftId,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../composerDraftStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import { ThreadRouteView } from "./ThreadRouteView";
import { MainAppLocationTracker, useNavigateToMainApp } from "./sidebar/mainAppLocation";

const control = vi.hoisted(() => ({
  transition: Promise.resolve(),
  serverThread: null as Thread | null,
}));

vi.mock("./ChatView", () => ({ default: () => <div>Thread composer</div> }));
vi.mock("./ui/sidebar", () => ({
  SidebarInset: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("./chat/draftHeroTransition", () => ({
  waitForDraftHeroTransition: () => control.transition,
}));
vi.mock("../state/entities", () => ({
  useThreadRefs: () => [],
  useEnvironmentThreadRefs: () => [],
  useThreadShell: (ref: ScopedThreadRef | null) => (ref === null ? null : control.serverThread),
  useThreadStatus: () => "empty",
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { snapshot: { _tag: "Some" } } }),
}));

const environmentId = EnvironmentId.make("local");
const draftId = DraftId.make("new-idea");
const threadId = ThreadId.make("created-idea");
const threadRef = scopeThreadRef(environmentId, threadId);
let root: Root;
let container: HTMLDivElement;
let finishTransition: () => void;

function Layout() {
  const params = useParams({ strict: false });
  const target = resolveThreadRouteTarget(params);
  return (
    <>
      <MainAppLocationTracker />
      {target ? <ThreadRouteView target={target} /> : <Outlet />}
    </>
  );
}

function Notebook() {
  const navigateToMainApp = useNavigateToMainApp();
  return (
    <div>
      Idea notebook<button onClick={navigateToMainApp}>Back</button>
    </div>
  );
}

function makeRouter() {
  const rootRoute = createRootRoute({ component: Layout });
  const children = [
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <div>Home</div> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/ideas", component: Notebook }),
    createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: Notebook }),
    createRoute({ getParentRoute: () => rootRoute, path: "/draft/$draftId" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/$environmentId/$threadId" }),
  ];
  return createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }),
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  control.serverThread = null;
  control.transition = new Promise<void>((resolve) => {
    finishTransition = resolve;
  });
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(environmentId, ProjectId.make("project")), draftId, {
      threadId,
      purpose: "idea",
      envMode: "local",
    });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("accepted draft navigation", () => {
  it("reopens an accepted idea draft under StrictMode", async () => {
    markPromotedDraftThreadByRef(threadRef);
    const router = makeRouter();
    await act(async () => {
      root.render(
        <StrictMode>
          <RouterProvider router={router} />
        </StrictMode>,
      );
      await router.load();
    });
    await act(async () => {
      finishTransition();
      await control.transition;
    });
    expect(router.state.location.pathname).toBe("/ideas");
    expect(router.state.location.search).toEqual({ environment: "local", idea: "created-idea" });
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
  });

  it("opens the new notebook after acceptance even when Ideas are absent from work subscriptions", async () => {
    const router = makeRouter();
    await act(async () => {
      root.render(<RouterProvider router={router} />);
      await router.load();
    });
    expect(router.state.location.pathname).toBe("/draft/new-idea");
    await act(async () => markPromotedDraftThreadByRef(threadRef));
    expect(router.state.location.pathname).toBe("/draft/new-idea");
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo).toEqual(
      threadRef,
    );
    await act(async () => {
      finishTransition();
      await control.transition;
    });
    expect(router.state.location.pathname).toBe("/ideas");
    expect(router.state.location.search).toEqual({ environment: "local", idea: "created-idea" });
    expect(container.textContent).toBe("Idea notebookBack");
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
    const backDestinations: string[] = [];
    const unsubscribe = router.subscribe("onBeforeNavigate", ({ toLocation }) => {
      backDestinations.push(toLocation.pathname);
    });
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    unsubscribe();
    expect(router.state.location.pathname).toBe("/");
    expect(backDestinations).toEqual(["/"]);
    expect(container.textContent).toBe("Home");
  });

  it("keeps ordinary draft promotion on the thread route", async () => {
    useComposerDraftStore.getState().setDraftThreadContext(draftId, { purpose: "work" });
    control.serverThread = makeThreadFixture({
      environmentId,
      id: threadId,
      itemCount: 1,
      latestUserMessageAt: "2026-10-07T19:22:40.685Z",
    });
    markPromotedDraftThreadByRef(threadRef);
    const router = makeRouter();
    await act(async () => {
      root.render(<RouterProvider router={router} />);
      await router.load();
    });
    await act(async () => {
      finishTransition();
      await control.transition;
    });
    expect(router.state.location.pathname).toBe("/local/created-idea");
    expect(container.textContent).toBe("Thread composer");
  });

  it("returns from Settings to an unsent Idea draft with its prompt intact", async () => {
    useComposerDraftStore.getState().setPrompt(draftId, "Explore the notebook flow");
    const router = makeRouter();
    await act(async () => {
      root.render(<RouterProvider router={router} />);
      await router.load();
    });
    await act(async () => {
      await router.navigate({ to: "/settings" });
    });
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(router.state.location.pathname).toBe("/draft/new-idea");
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "Explore the notebook flow",
    );
  });

  it.each(["before acceptance", "during transition"])(
    "does not reopen an idea after leaving %s",
    async (when) => {
      const router = makeRouter();
      await act(async () => {
        root.render(<RouterProvider router={router} />);
        await router.load();
      });
      if (when === "during transition")
        await act(async () => markPromotedDraftThreadByRef(threadRef));
      await act(async () => {
        await router.navigate({ to: "/" });
      });
      if (when === "before acceptance")
        await act(async () => markPromotedDraftThreadByRef(threadRef));
      await act(async () => {
        finishTransition();
        await control.transition;
      });
      expect(router.state.location.pathname).toBe("/");
      expect(container.textContent).toBe("Home");
      if (when === "during transition") {
        expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
        await act(async () => {
          await router.navigate({
            to: "/ideas",
            search: { environment: environmentId, idea: threadId },
          });
        });
        expect(useComposerDraftStore.getState().getDraftSessionByRef(threadRef)).toBeNull();
        expect(container.textContent).toBe("Idea notebookBack");
      }
    },
  );
});
