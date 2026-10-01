// @vitest-environment jsdom

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => ({ bindings: [] }),
}));
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
  useUpdateClientSettings: () => () => {},
}));
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    data: string[];
    renderItem: (input: { item: string; index: number }) => ReactNode;
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={item}>{renderItem({ item, index })}</div>
      ))}
    </div>
  ),
}));

const codex = ProviderInstanceId.make("codex_work");
const claude = ProviderInstanceId.make("claude_work");
const entries = deriveProviderInstanceEntries(
  [
    {
      instanceId: codex,
      driver: ProviderDriverKind.make("codex"),
      model: "gpt-6-luna",
      name: "GPT-6 Luna",
    },
    {
      instanceId: claude,
      driver: ProviderDriverKind.make("claudeAgent"),
      model: "sonnet",
      name: "Sonnet",
    },
  ].map(({ model, name, ...provider }): ServerProvider => ({
    ...provider,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    version: null,
    checkedAt: "2026-10-01T00:00:00.000Z",
    models: [{ slug: model, name, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  })),
);
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Idea model picker", () => {
  it("keeps the selected GPT model available and allows selecting another provider", async () => {
    const selections: Array<{ instanceId: ProviderInstanceId; model: string }> = [];
    await act(async () =>
      root.render(
        <ProviderModelPicker
          activeInstanceId={codex}
          model="gpt-6-luna"
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
          onInstanceModelChange={(instanceId, model) => selections.push({ instanceId, model })}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[data-chat-provider-model-picker="true"]',
    )!;
    expect(trigger.textContent).toContain("GPT-6 Luna");
    await act(async () => trigger.click());
    const codexOption = document.querySelector<HTMLElement>('[role="option"]')!;
    expect(codexOption.textContent).toContain("GPT-6 Luna");
    await act(async () => codexOption.click());
    expect(selections).toEqual([{ instanceId: codex, model: "gpt-6-luna" }]);
    await act(async () => trigger.click());
    const claudeButton = document.querySelector<HTMLButtonElement>(
      '[data-model-picker-provider="claude_work"] button',
    )!;
    await act(async () => claudeButton.click());
    const claudeOption = document.querySelector<HTMLElement>('[role="option"]')!;
    expect(claudeOption.textContent).toContain("Sonnet");
    await act(async () => claudeOption.click());
    expect(selections).toEqual([
      { instanceId: codex, model: "gpt-6-luna" },
      { instanceId: claude, model: "sonnet" },
    ]);
  });
});
