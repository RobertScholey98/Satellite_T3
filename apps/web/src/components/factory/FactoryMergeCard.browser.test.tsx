import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { FactoryMergeRow } from "./factoryMergeLogic";

const state = vi.hoisted(() => ({
  rows: [] as ReadonlyArray<FactoryMergeRow>,
}));
vi.mock(import("./factoryWorkspaceState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useFactoryMergeRows: () => state.rows,
}));
// Permissions are read through atoms; this test is about the row, so every grant holds.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => true) as never,
}));
// The host accepts every merge; nothing reaches a real pull request.
vi.mock(import("../pullRequest/usePullRequestActions"), () => ({
  usePullRequestActionRunner: ((options: { readonly onSuccess: () => void }) => ({
    actionPending: false,
    perform: async () => options.onSuccess(),
  })) as never,
  usePullRequestDefaultMergeMethodResolver: (() => () => null) as never,
}));

import { fakeTimers, render } from "../../../test/render";
import { FactoryMergeCard } from "./FactoryMergeCard";

const environmentId = EnvironmentId.make("local");

const readyRow: FactoryMergeRow = {
  key: "row-128",
  assignmentId: "assignment-1",
  assignmentTitle: "Fix the login redirect loop",
  projectId: ProjectId.make("project-1"),
  host: "github",
  repository: "acme/atlas",
  number: 128,
  title: "Fix the login redirect loop",
  url: "https://github.com/acme/atlas/pull/128",
  syncedAt: "2026-10-24T10:00:00.000Z",
  status: "ready",
  protectedPaths: [],
  awaitingAnswer: [],
};

function setup() {
  state.rows = [readyRow];
}

it("offers Merge again when no sync settles a merged row", async () => {
  setup();
  await using screen = await render(
    <FactoryMergeCard environmentId={environmentId} managerId="m" />,
  );
  using _timers = fakeTimers();

  await userEvent.click(screen.getByRole("button", { name: "Merge #128" }));
  await expect.element(screen.getByText("Merging…")).toBeVisible();

  await vi.advanceTimersByTimeAsync(2 * 60_000 - 1);
  expect(screen.getByText("Merging…").query()).not.toBeNull();

  await vi.advanceTimersByTimeAsync(1);
  await expect.element(screen.getByRole("button", { name: "Merge #128" })).toBeVisible();
});
