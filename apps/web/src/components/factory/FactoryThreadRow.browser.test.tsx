import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type FactoryAssignment,
  type FactoryManager,
  type FactoryOnboardingProposal,
  type FactoryWorkspaceFeed,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  feed: undefined as FactoryWorkspaceFeed | undefined,
  managers: [] as ReadonlyArray<FactoryManager>,
  takeOver: vi.fn(),
  other: vi.fn(),
}));
vi.mock(import("./factoryWorkspaceState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useFactoryWorkspaceFeed: () => state.feed,
}));
// Permissions are read through atoms; this test is about the row, so every grant holds.
vi.mock(import("./factoryState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useFactoryManagers: () => state.managers,
  useFactoryManagerCap: () => null,
}));
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProject: (() => ({ title: "Atlas" })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (importOriginal) => {
  const { factoryEnvironment } = await import("./factoryState");
  return {
    ...(await importOriginal()),
    useAtomCommand: ((command: unknown) =>
      command === factoryEnvironment.takeOver ? state.takeOver : state.other) as never,
  };
});

import { render } from "../../../test/render";
import { FactoryThreadRow } from "./FactoryThreadRow";

const environmentId = EnvironmentId.make("local");
const leadThreadId = ThreadId.make("lead-thread");

function leadFeed(takenOver: boolean): FactoryWorkspaceFeed {
  return {
    managers: [
      {
        id: "manager",
        threadId: ThreadId.make("manager-thread"),
        projectId: ProjectId.make("project"),
        name: "Ada",
        state: "active",
        waitingOnYou: 1,
      },
    ],
    members: [
      {
        threadId: leadThreadId,
        managerId: "manager",
        assignmentId: "assignment",
        role: "lead",
        parentThreadId: ThreadId.make("manager-thread"),
        joined: "created",
        takenOver,
        offPool: false,
        endedAt: null,
      },
    ],
    assignments: [
      {
        id: "assignment",
        managerId: "manager",
        title: "Fix login",
        state: "waiting-user",
        source: "ticket",
        complexity: "small",
        team: "custom",
        leadThreadId,
        checklist: [],
        waitingReason: "Needs a decision",
      },
    ],
  };
}

function setup() {
  state.feed = leadFeed(false);
  state.managers = [];
  state.takeOver.mockReset().mockResolvedValue({ _tag: "Success", value: {} as FactoryAssignment });
  state.other.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
}

it("takes over a managed lead's thread and then reads as taken over", async () => {
  setup();
  await using screen = await render(
    <FactoryThreadRow environmentId={environmentId} threadId={leadThreadId} />,
  );
  await expect
    .element(screen.getByText("Lead for Atlas manager · Waiting for you"))
    .toBeInTheDocument();

  await screen.getByRole("button", { name: "Factory lead actions" }).click();
  await page.getByRole("menuitem", { name: "Take over" }).click();
  expect(state.takeOver).toHaveBeenCalledWith({
    environmentId,
    input: { requestId: expect.any(String), threadId: leadThreadId },
  });

  state.feed = leadFeed(true);
  await screen.rerender(<FactoryThreadRow environmentId={environmentId} threadId={leadThreadId} />);
  await expect.element(screen.getByText("Taken over by you")).toBeInTheDocument();
  await screen.getByRole("button", { name: "Factory lead actions" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Hand back" })).toBeInTheDocument();
});

function onboardingManager(proposal: FactoryOnboardingProposal | null): FactoryManager {
  return {
    id: "manager",
    projectId: ProjectId.make("project"),
    name: "Ada",
    state: "onboarding",
    onboardingThreadId: null,
    primingMessageId: null,
    threadId: ThreadId.make("manager-thread"),
    onboardingProposal: proposal,
    onboardingResult: null,
    modelSelection: null,
    activeAssignments: 0,
    waitingOnYou: 0,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
  };
}

it("tells an onboarding manager's thread whether its proposal is ready", async () => {
  setup();
  const managerThreadId = ThreadId.make("manager-thread");
  const onboardingFeed = (): FactoryWorkspaceFeed => ({
    managers: [{ ...leadFeed(false).managers[0]!, state: "onboarding", waitingOnYou: 0 }],
    members: [],
    assignments: [],
  });
  state.feed = onboardingFeed();
  // No config or log loads here; the row shows the onboarding status instead of a pickup decision.
  state.other.mockResolvedValue({ _tag: "Failure", cause: null });
  state.managers = [onboardingManager(null)];
  await using screen = await render(
    <FactoryThreadRow environmentId={environmentId} threadId={managerThreadId} />,
  );
  await expect
    .element(screen.getByText("Waiting for its onboarding proposal").first())
    .toBeInTheDocument();

  state.managers = [onboardingManager({} as FactoryOnboardingProposal)];
  // The mocked managers hook does not subscribe, so a fresh feed is what re-renders the row.
  state.feed = onboardingFeed();
  await screen.rerender(
    <FactoryThreadRow environmentId={environmentId} threadId={managerThreadId} />,
  );
  await expect
    .element(screen.getByText("Onboarding proposal ready for review").first())
    .toBeInTheDocument();
});
