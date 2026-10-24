import { DEFAULT_FACTORY_CONFIG, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FactoryModelOption } from "./FactoryPageConfig";
import { factoryInstancePickers, setFactoryInstancePreference } from "./factoryRunsOn";

const option = (instanceId: string, driver: string, label: string, model = "model") =>
  ({
    selection: { instanceId: ProviderInstanceId.make(instanceId), model },
    label: `${label} · ${model}`,
    driverKind: ProviderDriverKind.make(driver),
  }) satisfies FactoryModelOption;

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const work = ProviderInstanceId.make("claude-work");

const OPTIONS = [
  option("claude-work", "claudeAgent", "Claude (work)", "opus"),
  option("claude-work", "claudeAgent", "Claude (work)", "sonnet"),
  option("claude-home", "claudeAgent", "Claude (home)", "opus"),
  option("codex", "codex", "Codex"),
];

describe("factoryInstancePickers", () => {
  it("offers a choice only for a driver with more than one usable instance", () => {
    expect(factoryInstancePickers(OPTIONS, {})).toEqual([
      {
        driver: CLAUDE,
        driverLabel: "Claude",
        instances: [
          { instanceId: "claude-work", label: "Claude (work)" },
          { instanceId: "claude-home", label: "Claude (home)" },
        ],
        preferred: null,
        stale: false,
      },
    ]);
  });

  it("keeps showing a preference for an instance this environment cannot run", () => {
    expect(
      factoryInstancePickers(OPTIONS, {
        [CLAUDE]: ProviderInstanceId.make("claude-gone"),
        [CODEX]: ProviderInstanceId.make("codex-old"),
      }).map(({ driver, preferred, stale, instances }) => ({
        driver,
        preferred,
        stale,
        instances: instances.length,
      })),
    ).toEqual([
      { driver: CLAUDE, preferred: "claude-gone", stale: true, instances: 2 },
      // One usable Codex instance would need no picker, but the stored preference is shown.
      { driver: CODEX, preferred: "codex-old", stale: true, instances: 1 },
    ]);
    expect(factoryInstancePickers(OPTIONS, { [CLAUDE]: work })[0]).toMatchObject({
      preferred: "claude-work",
      stale: false,
    });
  });
});

describe("setFactoryInstancePreference", () => {
  it("sets a driver's instance, and First available removes the key", () => {
    const preferred = setFactoryInstancePreference(DEFAULT_FACTORY_CONFIG, CLAUDE, work);
    expect(preferred.instancePreferences).toEqual({ claudeAgent: "claude-work" });
    const cleared = setFactoryInstancePreference(preferred, CLAUDE, null);
    expect(cleared.instancePreferences).toEqual({});
    expect(Object.keys(cleared.instancePreferences)).toEqual([]);
  });
});
