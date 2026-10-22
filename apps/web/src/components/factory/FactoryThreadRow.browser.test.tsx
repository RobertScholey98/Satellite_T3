import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type FactoryAssignment,
  type FactoryWorkspaceFeed,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  feed: undefined as FactoryWorkspaceFeed | undefined,
  takeOver: vi.fn(),
  other: vi.fn(),
}));
vi.mock(import("./factoryWorkspaceState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useFactoryWorkspaceFeed: () => state.feed,
}));
// Permissions are read through atoms; this test is about the row, so every grant holds.
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
        digest: null,
        waitingReason: "Needs a decision",
      },
    ],
  };
}

function setup() {
  state.feed = leadFeed(false);
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
