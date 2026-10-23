import { ThreadId, type FactoryAssignment } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ refreshDigest: vi.fn() }));
vi.mock(import("~/state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.refreshDigest) as never,
}));

import { render } from "../../../test/render";
import { FactoryTeamActivityCard } from "./FactoryWorkspacePanel";
import type { FactoryWorkspaceTeam } from "./factoryWorkspaceLogic";

const environmentId = EnvironmentId.make("local");
const digest = {
  text: "The implementer is adding the retry test.",
  generatedAt: "2026-01-01T00:00:00.000Z",
  activityAt: "2026-01-01T00:00:00.000Z",
};
const team: FactoryWorkspaceTeam = {
  assignment: {
    id: "assignment",
    managerId: "manager",
    title: "Fix login",
    state: "active",
    source: "ticket",
    complexity: "small",
    team: "custom",
    leadThreadId: ThreadId.make("lead"),
    checklist: [
      { text: "Reproduce", state: "done" },
      { text: "Fix", state: "in-progress" },
    ],
    digest,
    waitingReason: null,
  },
  threads: [{ threadId: ThreadId.make("lead"), role: "lead" }],
};

it("says the digest is up to date when a refresh finds no newer activity", async () => {
  // The server returns the assignment unchanged when its team did nothing new.
  state.refreshDigest
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { digest } as FactoryAssignment });
  await using screen = await render(
    <FactoryTeamActivityCard
      environmentId={environmentId}
      teams={[team]}
      activeAssignmentId={null}
    />,
  );
  await expect.element(screen.getByText(digest.text)).toBeInTheDocument();

  await screen.getByRole("button", { name: "Refresh" }).click();

  await expect.element(screen.getByRole("status")).toHaveTextContent("Up to date");
  expect(state.refreshDigest).toHaveBeenLastCalledWith({
    environmentId,
    input: { assignmentId: "assignment" },
  });
});

it("opens on the team of the thread being read", async () => {
  state.refreshDigest.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  const second: FactoryWorkspaceTeam = {
    assignment: {
      ...team.assignment,
      id: "assignment-2",
      title: "Add retries",
      leadThreadId: ThreadId.make("lead-2"),
      digest: { ...digest, text: "The reviewer is reading the retry policy." },
    },
    threads: [{ threadId: ThreadId.make("lead-2"), role: "lead" }],
  };
  await using screen = await render(
    <FactoryTeamActivityCard
      environmentId={environmentId}
      teams={[team, second]}
      activeAssignmentId="assignment-2"
    />,
  );

  await expect
    .element(screen.getByText("The reviewer is reading the retry policy."))
    .toBeInTheDocument();
});
