import {
  EnvironmentId,
  type FactoryTicketDraft,
  ProjectId,
  type FactoryProposedChange,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ command: vi.fn() }));
// The draft actions are the boundary under test; permissions are granted.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: ((command: { readonly label: string }) => (value: unknown) =>
    state.command(command.label, value)) as never,
}));
vi.mock(import("./factoryState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useFactoryAssignments: (() => [{ id: "assignment-1", title: "Fix the empty list" }]) as never,
}));

import { act, render } from "../../../test/render";

// The dialog's inert backdrop takes pointer events, so buttons are clicked directly.
const click = (name: string) =>
  act(async () => (page.getByRole("button", { name }).element() as HTMLElement).click());
import { FactoryTriageDraftDialog } from "./FactoryTriageDraftDialog";

const environmentId = EnvironmentId.make("environment-1");

const draft = (overrides: Partial<FactoryTicketDraft> = {}): FactoryTicketDraft => ({
  id: "draft-1",
  managerId: "manager-1",
  projectId: ProjectId.make("project-1"),
  assignmentId: "assignment-1",
  scope: "project",
  title: "Cover the empty list in e2e",
  body: "The e2e suite never renders an empty list.",
  acceptanceCriteria: ["An e2e test renders an empty list"],
  findingIds: [],
  state: "pending",
  issue: null,
  proposedChange: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...overrides,
});

const dialog = (value: FactoryTicketDraft, onApproved = vi.fn()) => (
  <FactoryTriageDraftDialog
    environmentId={environmentId}
    draft={value}
    manager={null}
    connected
    onClose={vi.fn()}
    onApproved={onApproved}
  />
);

function setup() {
  state.command.mockReset().mockImplementation(async (_label: string, value: unknown) => ({
    _tag: "Success",
    value,
  }));
}

it("approves a project finding by its draft id and refreshes the board", async () => {
  setup();
  const onApproved = vi.fn();
  await using _screen = await render(dialog(draft(), onApproved));

  await expect.element(page.getByText("From the retro of Fix the empty list")).toBeVisible();
  await click("Approve");

  expect(state.command).toHaveBeenCalledOnce();
  expect(state.command).toHaveBeenCalledWith("factory:drafts:approve", {
    environmentId,
    input: { requestId: expect.any(String), draftId: "draft-1" },
  });
  expect(onApproved).toHaveBeenCalledOnce();
});

it("offers Apply on a factory finding only when it proposes a configuration change", async () => {
  setup();
  const change: FactoryProposedChange = {
    kind: "setting",
    key: "concurrencyCap",
    before: 1,
    after: 2,
  };
  await using screen = await render(dialog(draft({ scope: "factory" })));

  await expect.element(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Approve" })).not.toBeInTheDocument();

  await screen.rerender(dialog(draft({ scope: "factory", proposedChange: change })));
  await expect.element(page.getByText("Proposed change · Concurrency cap")).toBeVisible();
  await click("Apply");
  expect(state.command).toHaveBeenCalledWith("factory:drafts:apply", {
    environmentId,
    input: { requestId: expect.any(String), draftId: "draft-1" },
  });
});
