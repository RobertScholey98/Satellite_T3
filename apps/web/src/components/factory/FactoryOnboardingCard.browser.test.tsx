import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type FactoryManager,
  type FactoryOnboardingProposal,
} from "@t3tools/contracts";
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

import { render } from "../../../test/render";
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
