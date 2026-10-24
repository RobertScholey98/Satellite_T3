import {
  type FactoryOnboardingResult,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveManagerCap,
  managerModelChoices,
  managerSettingsDirty,
  managerSettingsDraft,
  managerSettingsProblem,
  managerSettingsResult,
  toggleSettingsColumn,
} from "./factoryManagerSettings.logic";

const READY = { boardId: "board-1", columnId: "ready" };
const STORED: FactoryOnboardingResult = {
  purpose: "Keep the app fast.",
  pickup: { enabled: true, columns: [READY], labels: ["bug"], guidance: "Small bugs." },
  baseBranch: "main",
  rules: [{ id: "small", question: "Which tickets count as small?", answer: "One file" }],
  controlPaths: [{ path: "AGENTS.md", reason: "Agent instructions." }],
  teamIds: [],
  concurrencyCap: 2,
};
const OPUS = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };

describe("manager settings draft", () => {
  it("saves what the user changed and keeps the questions and base branch", () => {
    const draft = {
      ...managerSettingsDraft(STORED, OPUS),
      labels: " bug, Backend ,, bug",
      guidance: "  Bugs only. ",
      answers: { small: " Two files " },
      concurrencyCap: "4",
      teamIds: ["standard"],
    };
    expect(managerSettingsResult(STORED, draft)).toEqual({
      ...STORED,
      pickup: { ...STORED.pickup, labels: ["bug", "Backend"], guidance: "Bugs only." },
      rules: [{ id: "small", question: "Which tickets count as small?", answer: "Two files" }],
      teamIds: ["standard"],
      concurrencyCap: 4,
    });
  });

  it("drops the columns when pickup is turned off", () => {
    const draft = { ...managerSettingsDraft(STORED, OPUS), pickupEnabled: false };
    expect(managerSettingsResult(STORED, draft).pickup).toEqual({
      ...STORED.pickup,
      enabled: false,
      columns: [],
    });
  });

  it("is clean until something saved would differ", () => {
    const draft = managerSettingsDraft(STORED, OPUS);
    expect(managerSettingsDirty(STORED, OPUS, draft)).toBe(false);
    expect(managerSettingsDirty(STORED, OPUS, { ...draft, guidance: "Small bugs. " })).toBe(false);
    expect(managerSettingsDirty(STORED, OPUS, { ...draft, concurrencyCap: "3" })).toBe(true);
    expect(managerSettingsDirty(STORED, OPUS, { ...draft, concurrencyCap: "0" })).toBe(true);
    expect(managerSettingsDirty(STORED, OPUS, { ...draft, model: { ...OPUS, model: "s" } })).toBe(
      true,
    );
    const untoggled = toggleSettingsColumn(toggleSettingsColumn(draft, READY, false), READY, true);
    expect(managerSettingsDirty(STORED, OPUS, untoggled)).toBe(false);
  });

  it("previews the refusals the card can see", () => {
    const draft = managerSettingsDraft(STORED, OPUS);
    expect(managerSettingsProblem(STORED, draft)).toBeNull();
    expect(managerSettingsProblem(STORED, { ...draft, answers: { small: " " } })).toBe(
      "Answer every rule.",
    );
    expect(managerSettingsProblem(STORED, toggleSettingsColumn(draft, READY, false))).toBe(
      "Tick at least one Ready column, or turn pickup off.",
    );
    for (const concurrencyCap of ["0", "21", "1.5", ""])
      expect(managerSettingsProblem(STORED, { ...draft, concurrencyCap })).toBe(
        "Set the cap to a whole number from 1 to 20.",
      );
  });
});

describe("effectiveManagerCap", () => {
  it("is the lower cap, and says when the environment's is the one limiting", () => {
    expect(effectiveManagerCap(4, 2)).toEqual({ cap: 2, limitedByEnvironment: true });
    expect(effectiveManagerCap(1, 2)).toEqual({ cap: 1, limitedByEnvironment: false });
    expect(effectiveManagerCap(2, 2)).toEqual({ cap: 2, limitedByEnvironment: false });
  });
});

describe("managerModelChoices", () => {
  it("runs each pool model on its driver's preferred instance, else the first", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const option = (instanceId: string, model: string) => ({
      selection: { instanceId: ProviderInstanceId.make(instanceId), model },
      label: `${instanceId} · ${model}`,
      driverKind: claude,
    });
    const options = [option("work", "opus"), option("home", "opus"), option("work", "sonnet")];
    const pool = [
      { driver: claude, model: "opus" },
      { driver: claude, model: "sonnet" },
      { driver: claude, model: "gone" },
    ];
    expect(managerModelChoices(pool, options, {}).map((choice) => choice.label)).toEqual([
      "work · opus",
      "work · sonnet",
    ]);
    expect(
      managerModelChoices(pool, options, { [claude]: ProviderInstanceId.make("home") }).map(
        (choice) => choice.label,
      ),
    ).toEqual(["home · opus", "work · sonnet"]);
  });
});
