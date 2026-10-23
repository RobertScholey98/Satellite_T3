import { DEFAULT_FACTORY_CONFIG, EnvironmentId, type FactoryConfigView } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getStats: vi.fn(),
  listBoards: vi.fn(),
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
          : command === factoryEnvironment.getStats
            ? state.getStats
            : state.listBoards) as never,
  };
});
// The real rows read settings permissions from live environment state; this suite is about the
// factory form.
vi.mock(import("../settings/settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: (({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
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

import { render } from "../../../test/render";
import { FactoryPageConfiguration } from "./FactoryPageConfiguration";

const environmentId = EnvironmentId.make("env");
const saved = { ...DEFAULT_FACTORY_CONFIG, pickupGuidance: "Small bugs only." };
const view: FactoryConfigView = { environment: saved, effective: saved, configured: true };

function setup() {
  state.getConfig.mockReset().mockResolvedValue({ _tag: "Success", value: view });
  state.updateConfig.mockReset().mockResolvedValue({ _tag: "Success", value: view });
  state.getStats.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { teams: [], assignments: [] },
  });
  state.listBoards.mockReset().mockResolvedValue({
    _tag: "Success",
    value: [{ id: "board", projectId: "project", title: "Board" }],
  });
}

it("saves the edited pickup guidance to the environment config", async () => {
  setup();
  await using screen = await render(
    <FactoryPageConfiguration
      environmentId={environmentId}
      environmentLabel="Build workstation"
      modelOptions={[]}
      canEdit
    />,
  );
  const guidance = screen.getByRole("textbox", { name: "Pickup guidance" });
  await expect.element(guidance).toHaveValue("Small bugs only.");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  await userEvent.clear(guidance);
  await userEvent.type(guidance, "Pick up bugs labelled agent.");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(state.updateConfig).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      scope: "environment",
      config: { ...saved, pickupGuidance: "Pick up bugs labelled agent." },
    },
  });
});
