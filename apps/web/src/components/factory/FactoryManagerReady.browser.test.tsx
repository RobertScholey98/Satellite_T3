import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type FactoryManager,
  type FactoryOnboardingResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  managers: [] as ReadonlyArray<FactoryManager>,
  startPickup: vi.fn(),
}));
vi.mock(import("./factoryState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useFactoryManagers: () => state.managers,
}));
// Permissions are read through atoms; this suite is about the empty state, so the grant holds.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.startPickup) as never,
}));

import { render } from "../../../test/render";
import { FactoryManagerReady } from "./FactoryManagerReady";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("primed-thread");

function approved(pickupEnabled: boolean): FactoryOnboardingResult {
  return {
    purpose: "Ship Atlas features.",
    pickup: {
      enabled: pickupEnabled,
      columns: pickupEnabled ? [{ boardId: "board", columnId: "ready" }] : [],
      labels: [],
      guidance: "",
    },
    baseBranch: null,
    rules: [
      { id: "merge-policy", question: "Who merges?", answer: "The user" },
      { id: "docs", question: "Docs?", answer: "Always" },
    ],
    controlPaths: [],
    teamIds: [],
    concurrencyCap: 2,
  };
}

function managerWith(
  managerState: FactoryManager["state"],
  pickupEnabled: boolean,
): FactoryManager {
  return {
    id: "manager",
    projectId: ProjectId.make("project"),
    name: "Ada",
    state: managerState,
    threadId,
    onboardingThreadId: ThreadId.make("onboarding-thread"),
    onboardingProposal: null,
    onboardingResult: approved(pickupEnabled),
    modelSelection: null,
    activeAssignments: 0,
    waitingOnYou: 0,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
  };
}

function setup(manager: FactoryManager) {
  state.managers = [manager];
  state.startPickup.mockReset().mockResolvedValue({ _tag: "Success", value: manager });
}

const ready = () => <FactoryManagerReady environmentId={environmentId} threadId={threadId} />;

it("starts pickup for a ready manager and drops the button once it is active", async () => {
  setup(managerWith("ready", true));
  await using screen = await render(ready());

  await expect.element(screen.getByText("Manager ready")).toBeVisible();
  await expect
    .element(screen.getByText("Pickup on · 1 Ready column · 2 project rules"))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Start picking up" }));
  expect(state.startPickup).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { requestId: expect.any(String), managerId: "manager" },
  });

  state.managers = [managerWith("active", true)];
  await screen.rerender(ready());
  await expect
    .element(screen.getByRole("button", { name: "Start picking up" }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("Let's get started")).not.toBeInTheDocument();
});

it("tells the user to get started when pickup is off", async () => {
  setup(managerWith("active", false));
  await using screen = await render(ready());

  await expect.element(screen.getByText("Pickup off · 2 project rules")).toBeVisible();
  await expect.element(screen.getByText("Let's get started")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Start picking up" }))
    .not.toBeInTheDocument();
});
