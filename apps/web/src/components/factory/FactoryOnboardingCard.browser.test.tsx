import {
  EnvironmentId,
  FactoryOperationError,
  ProjectId,
  ThreadId,
  type FactoryManager,
  type FactoryOnboardingProposal,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  managers: [] as ReadonlyArray<FactoryManager>,
  approve: vi.fn(),
  getConfig: vi.fn(),
}));
vi.mock(import("./factoryState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useFactoryManagers: () => state.managers,
}));
// Permissions are read through atoms; this suite is about the card, so the grant holds.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => true) as never,
}));
// Commands are the boundary under test: Approve must send exactly the reviewed result.
vi.mock(import("~/state/use-atom-command"), async (importOriginal) => {
  const { factoryEnvironment } = await import("./factoryState");
  return {
    ...(await importOriginal()),
    useAtomCommand: ((command: unknown) =>
      command === factoryEnvironment.approveOnboarding ? state.approve : state.getConfig) as never,
  };
});

import { fakeTimers, render } from "../../../test/render";
import { FactoryOnboardingCard } from "./FactoryOnboardingCard";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("manager-thread");

const proposal: FactoryOnboardingProposal = {
  summary: "Atlas is a TypeScript monorepo.",
  purpose: "Ship Atlas features.",
  pickup: { enabled: true, guidance: "Small bugs only." },
  rules: [
    {
      id: "merge-policy",
      question: "Who merges pull requests?",
      options: ["The user", "The lead"],
      recommended: 0,
      reason: "Merging is protected.",
    },
  ],
  controlPaths: [{ path: ".github/**", reason: "CI" }],
  findings: [],
  detected: {
    boards: [
      {
        boardId: "board",
        title: "Atlas board",
        readyColumns: [
          { id: "ready", title: "Ready" },
          { id: "backlog", title: "Backlog" },
        ],
        labels: [],
      },
    ],
    defaultBranch: "main",
    detectedAt: "2026-10-23T00:00:00.000Z",
  },
  proposedAt: "2026-10-23T00:00:00.000Z",
};

const manager: FactoryManager = {
  id: "manager",
  projectId: ProjectId.make("project"),
  name: "Ada",
  state: "onboarding",
  threadId,
  onboardingThreadId: null,
  onboardingProposal: proposal,
  onboardingResult: null,
  modelSelection: null,
  activeAssignments: 0,
  waitingOnYou: 0,
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
};

function setup() {
  state.managers = [manager];
  state.approve.mockReset().mockResolvedValue({ _tag: "Success", value: manager });
  state.getConfig.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { effective: { concurrencyCap: 3 } },
  });
}

const card = () => (
  <FactoryOnboardingCard
    environmentId={environmentId}
    threadId={threadId}
    latest
    onSendMessage={undefined}
  />
);

it("makes the user tick the Ready column instead of trusting the board mapping", async () => {
  setup();
  await using screen = await render(card());

  await userEvent.click(screen.getByText("Pick up tickets on its own"));
  const ready = screen.getByRole("checkbox", { name: "Ready" });
  const backlog = screen.getByRole("checkbox", { name: "Backlog" });
  await expect.element(ready).not.toBeChecked();
  await expect.element(backlog).not.toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  await expect
    .element(screen.getByText("Tick at least one Ready column, or turn pickup off."))
    .toBeVisible();

  await userEvent.click(screen.getByText("Ready", { exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));

  expect(state.approve).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      requestId: expect.any(String),
      managerId: "manager",
      result: {
        purpose: "Ship Atlas features.",
        pickup: {
          enabled: true,
          columns: [{ boardId: "board", columnId: "ready" }],
          labels: [],
          guidance: "Small bugs only.",
        },
        baseBranch: null,
        rules: [{ id: "merge-policy", question: "Who merges pull requests?", answer: "The user" }],
        controlPaths: [{ path: ".github/**", reason: "CI" }],
        teamIds: [],
        concurrencyCap: 3,
      },
    },
  });
});

it("preselects the recommended answer and sends the user's own words for Other", async () => {
  setup();
  await using screen = await render(card());

  await expect.element(screen.getByRole("radio", { name: "The user (recommended)" })).toBeChecked();

  await userEvent.click(screen.getByText("Other", { exact: true }));
  await expect.element(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  await userEvent.type(
    screen.getByRole("textbox", { name: "Other answer: Who merges pull requests?" }),
    "  Nobody; the lead asks me  ",
  );
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));

  expect(state.approve).toHaveBeenCalledOnce();
  expect(state.approve.mock.calls[0]![0].input.result).toMatchObject({
    pickup: { enabled: false, columns: [] },
    rules: [
      {
        id: "merge-policy",
        question: "Who merges pull requests?",
        answer: "Nobody; the lead asks me",
      },
    ],
  });
});

it("starts a fresh review when the manager sends a new proposal", async () => {
  setup();
  await using screen = await render(card());
  const purpose = screen.getByRole("textbox", { name: "Purpose" });
  await userEvent.clear(purpose);
  await userEvent.type(purpose, "My own words");
  await expect.element(purpose).toHaveValue("My own words");

  state.managers = [
    {
      ...manager,
      onboardingProposal: {
        ...proposal,
        purpose: "Ship Atlas v2.",
        proposedAt: "2026-10-23T01:00:00.000Z",
      },
    },
  ];
  await screen.rerender(card());
  await expect
    .element(screen.getByRole("textbox", { name: "Purpose" }))
    .toHaveValue("Ship Atlas v2.");
});

it("sends only the kept protected paths, with any the user added", async () => {
  setup();
  await using screen = await render(card());

  await userEvent.click(screen.getByText(".github/**", { exact: true }));
  await userEvent.type(screen.getByRole("textbox", { name: "Add a protected path" }), "docs/**");
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));

  expect(state.approve).toHaveBeenCalledOnce();
  expect(state.approve.mock.calls[0]![0].input.result.controlPaths).toEqual([
    { path: "docs/**", reason: "" },
  ]);
});

it("shows the server's refusal on the card", async () => {
  setup();
  state.approve.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(
      new FactoryOperationError({
        reason: "invalid",
        message: "Backlog is not a Ready column of Atlas board.",
      }),
    ),
  });
  await using screen = await render(card());

  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Backlog is not a Ready column of Atlas board.");
});

it("will not approve without the factory settings rather than guess the cap", async () => {
  setup();
  state.getConfig.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
  await using screen = await render(card());

  await expect.element(screen.getByText("Could not read the factory settings")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
});

const approvedResult = {
  purpose: "Ship Atlas features.",
  pickup: { enabled: false, columns: [], labels: [], guidance: "" },
  baseBranch: null,
  rules: [],
  controlPaths: [],
  teamIds: [],
  concurrencyCap: 3,
} as const;

it("swaps to the primed thread with a history replace once the loader has had three seconds", async () => {
  setup();
  const primedThreadId = ThreadId.make("primed-thread");
  state.approve.mockResolvedValue({
    _tag: "Success",
    value: { ...manager, state: "active", threadId: primedThreadId, onboardingThreadId: threadId },
  });
  await using screen = await render(card(), { router: "/local/manager-thread" });
  const router = screen.router!;
  const approve = screen.getByRole("button", { name: "Approve" });
  await expect.element(approve).toBeEnabled();
  const entriesBefore = router.history.length;

  using _timers = fakeTimers();
  await userEvent.click(approve);
  await vi.advanceTimersByTimeAsync(2999);
  expect(screen.getByText("Cooking...").query()).not.toBeNull();
  expect(router.state.location.pathname).toBe("/local/manager-thread");

  await vi.advanceTimersByTimeAsync(1);
  expect(router.state.location.pathname).toBe("/local/primed-thread");
  expect(router.history.length).toBe(entriesBefore);
});

it("marks the old onboarding thread approved and links to the manager's new thread", async () => {
  setup();
  state.managers = [
    {
      ...manager,
      state: "active",
      threadId: ThreadId.make("primed-thread"),
      onboardingThreadId: threadId,
      onboardingProposal: null,
      onboardingResult: approvedResult,
    },
  ];
  await using screen = await render(card());

  await expect.element(screen.getByText(/^Onboarding approved/)).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Open Ada's thread" }))
    .toHaveAttribute("href", "/local/primed-thread");
});
