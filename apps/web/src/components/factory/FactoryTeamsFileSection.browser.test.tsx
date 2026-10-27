import {
  EnvironmentId,
  type FactoryDefinitionsView,
  type FactoryWorkerDefinition,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  getDefinitions: vi.fn(),
  saveDefinition: vi.fn(),
  other: vi.fn(),
}));

// Commands are the boundary under test: Save must send the team exactly as edited.
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const { factoryEnvironment } = await import("./factoryState");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === factoryEnvironment.getDefinitions
        ? state.getDefinitions
        : command === factoryEnvironment.saveDefinition
          ? state.saveDefinition
          : state.other) as never,
  };
});
// The real rows read settings permissions from live environment state; this suite is about the
// team editor.
vi.mock(import("../settings/settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: (({
    title,
    headerAction,
    children,
  }: {
    title: string;
    headerAction?: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  )) as never,
  SettingsRow: (({
    title,
    description,
    control,
    children,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {control}
      {children}
    </div>
  )) as never,
}));

import { act, render } from "../../../test/render";
import { FactoryTeamsFileSection } from "./FactoryTeamsFileSection";

const environmentId = EnvironmentId.make("env");
const opus = { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" };
const implementer: FactoryWorkerDefinition = {
  id: "implementer",
  name: "Implementer",
  models: { dynamic: false, models: [opus] },
  description: "Builds the change.",
};
const reviewer: FactoryWorkerDefinition = {
  id: "reviewer",
  name: "Reviewer",
  models: { dynamic: true, models: [opus] },
  description: "Reviews the diff.",
};
const lead = {
  id: "default-lead",
  name: "Default lead",
  models: { dynamic: false, models: [opus] },
  instructions: "Keep PRs small.",
};
const view: FactoryDefinitionsView = {
  configured: true,
  settings: { version: 1, modelPool: [opus], recoveryAllowance: 1 },
  workers: [implementer, reviewer],
  leads: [lead],
  managers: [],
  teams: [],
  problems: [],
};

function setup() {
  state.getDefinitions.mockReset().mockResolvedValue({ _tag: "Success", value: view });
  state.saveDefinition
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { id: "qa", view } });
  state.other.mockReset();
}

it("saves a new team of worker copies with only the edited member changed", async () => {
  setup();
  await using screen = await render(
    <FactoryTeamsFileSection environmentId={environmentId} canEdit modelOptions={[]} />,
  );
  await expect.element(screen.getByText("No teams")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Add team" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "QA");
  await userEvent.click(screen.getByRole("button", { name: "Choose lead" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Default lead" }));
  await userEvent.click(screen.getByRole("button", { name: "Add member" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Implementer" }));
  await userEvent.click(screen.getByRole("button", { name: "Add member" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Reviewer" }));

  const description = screen.getByRole("textbox", { name: "Member 2 description" });
  await userEvent.clear(description);
  await userEvent.type(description, "Reviews twice.");
  // The dialog's inert backdrop takes pointer events over its footer, so Save is clicked directly.
  await act(async () =>
    (screen.getByRole("button", { name: "Save" }).element() as HTMLElement).click(),
  );

  expect(state.saveDefinition).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      kind: "team",
      definition: {
        name: "QA",
        useWhen: "",
        workflow: "",
        mayEditProtectedPaths: false,
        createdBy: "user",
        lead,
        members: [
          {
            name: "Implementer",
            count: 1,
            models: implementer.models,
            description: "Builds the change.",
          },
          { name: "Reviewer", count: 1, models: reviewer.models, description: "Reviews twice." },
        ],
      },
    },
  });
});
