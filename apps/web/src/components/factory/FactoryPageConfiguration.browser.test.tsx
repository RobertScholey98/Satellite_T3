import {
  DEFAULT_FACTORY_CONFIG,
  EnvironmentId,
  type FactoryConfigView,
  type FactoryDefinitionsView,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  listBoards: vi.fn(),
  getDefinitions: vi.fn(),
  saveFactorySettings: vi.fn(),
}));

// Commands are the boundary under test: Save must send exactly the edited config.
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const { factoryEnvironment } = await import("./factoryState");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === factoryEnvironment.getConfig
        ? state.getConfig
        : command === factoryEnvironment.updateConfig
          ? state.updateConfig
          : command === factoryEnvironment.getDefinitions
            ? state.getDefinitions
            : command === factoryEnvironment.saveFactorySettings
              ? state.saveFactorySettings
              : state.listBoards) as never,
  };
});
// The real rows read settings permissions from live environment state; this suite is about the
// factory form.
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
  SettingResetButton: (() => null) as never,
}));

// The other file-based config sections load through their own commands and have their own tests.
vi.mock(import("./FactoryDefinitionsSection"), () => ({
  FactoryDefinitionsSection: (() => null) as never,
}));
vi.mock(import("./FactoryTeamsFileSection"), () => ({
  FactoryTeamsFileSection: (() => null) as never,
}));
vi.mock(import("./FactoryConfigRepoSection"), () => ({
  FactoryConfigRepoSection: (() => null) as never,
}));
vi.mock(import("./FactoryConfigShareSection"), () => ({
  FactoryConfigShareSection: (() => null) as never,
}));

import { render } from "../../../test/render";
import { factoryModelRefFromOption } from "./factoryModelRefs";
import { FactoryPageConfiguration } from "./FactoryPageConfiguration";

const environmentId = EnvironmentId.make("env");
const saved = { ...DEFAULT_FACTORY_CONFIG, concurrencyCap: 2 };
const view: FactoryConfigView = { environment: saved, effective: saved, configured: true };
const opus = { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" };
const definitions: FactoryDefinitionsView = {
  configured: true,
  settings: { version: 1, modelPool: [opus], recoveryAllowance: 1 },
  workers: [],
  leads: [],
  managers: [],
  teams: [],
  problems: [],
};

function setup() {
  state.getDefinitions.mockReset().mockResolvedValue({ _tag: "Success", value: definitions });
  state.saveFactorySettings.mockReset().mockResolvedValue({ _tag: "Success", value: definitions });
  state.getConfig.mockReset().mockResolvedValue({ _tag: "Success", value: view });
  state.updateConfig.mockReset().mockResolvedValue({ _tag: "Success", value: view });
  state.listBoards.mockReset().mockResolvedValue({
    _tag: "Success",
    value: [{ id: "board", projectId: "project", title: "Board" }],
  });
}

it("saves the edited concurrency cap to the environment config", async () => {
  setup();
  await using screen = await render(
    <FactoryPageConfiguration
      environmentId={environmentId}
      environmentLabel="Build workstation"
      modelOptions={[]}
      canEdit
    />,
  );
  const cap = screen.getByRole("textbox", { name: "Concurrent assignments" });
  await expect.element(cap).toHaveValue("2");
  await expect
    .element(screen.getByRole("button", { name: "Save pickup and behaviour" }))
    .not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Increase Concurrent assignments" }));
  await userEvent.click(screen.getByRole("button", { name: "Save pickup and behaviour" }));

  expect(state.updateConfig).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { scope: "environment", config: { ...saved, concurrencyCap: 3 } },
  });
});

it("saves the instance a driver runs on, and First available removes the preference", async () => {
  setup();
  // Save answers with what was sent, so the form's next edit starts from it.
  state.updateConfig.mockImplementation(
    async ({ input }: { input: { config: FactoryConfigView["environment"] } }) => ({
      _tag: "Success",
      value: { environment: input.config, effective: input.config, configured: true },
    }),
  );
  const claude = (instanceId: string, label: string) => ({
    selection: { instanceId: ProviderInstanceId.make(instanceId), model: "claude-opus-5-5" },
    label: `${label} · Opus 5.5`,
    driverKind: ProviderDriverKind.make("claudeAgent"),
  });
  await using screen = await render(
    <FactoryPageConfiguration
      environmentId={environmentId}
      environmentLabel="Build workstation"
      modelOptions={[
        claude("claude-home", "Claude (home)"),
        claude("claude-work", "Claude (work)"),
      ]}
      canEdit
    />,
  );

  await userEvent.click(screen.getByRole("combobox", { name: "Claude runs on" }));
  await userEvent.click(screen.getByRole("option", { name: "Claude (work)" }));
  await userEvent.click(screen.getByRole("button", { name: "Save pickup and behaviour" }));
  expect(state.updateConfig).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      scope: "environment",
      config: { ...saved, instancePreferences: { claudeAgent: "claude-work" } },
    },
  });

  await userEvent.click(screen.getByRole("combobox", { name: "Claude runs on" }));
  await userEvent.click(screen.getByRole("option", { name: "First available" }));
  await userEvent.click(screen.getByRole("button", { name: "Save pickup and behaviour" }));
  expect(state.updateConfig).toHaveBeenLastCalledWith({
    environmentId,
    input: { scope: "environment", config: { ...saved, instancePreferences: {} } },
  });
});

it("saves the model pool alone, keeping the saved recovery allowance and its unsaved edit", async () => {
  setup();
  const codex = {
    selection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
    label: "Codex · GPT-5.5",
    driverKind: ProviderDriverKind.make("codex"),
  };
  await using screen = await render(
    <FactoryPageConfiguration
      environmentId={environmentId}
      environmentLabel="Build workstation"
      modelOptions={[codex]}
      canEdit
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Add a model to the pool" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Codex · GPT-5.5" }));
  await userEvent.click(screen.getByRole("button", { name: "Increase Recovery allowance" }));
  await userEvent.click(screen.getByRole("button", { name: "Save pool" }));

  expect(state.saveFactorySettings).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      version: 1,
      modelPool: [opus, factoryModelRefFromOption(codex)],
      recoveryAllowance: 1,
    },
  });
  await expect.element(screen.getByRole("button", { name: "Save pool" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Save recovery" })).toBeVisible();
  await expect
    .element(screen.getByRole("textbox", { name: "Recovery allowance" }))
    .toHaveValue("2");
});
