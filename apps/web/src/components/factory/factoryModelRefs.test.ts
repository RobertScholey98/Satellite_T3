import { type FactoryModelRef, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeFactoryModelRefs,
  factoryModelRefFromOption,
  factoryStarterPool,
  moveFactoryModelRef,
  resolveFactoryModelRef,
  summarizeFactoryModelList,
} from "./factoryModelRefs";
import type { FactoryModelOption } from "./FactoryPageConfig";

const option = (instanceId: string, driver: string, model: string, label: string) =>
  ({
    selection: { instanceId: ProviderInstanceId.make(instanceId), model },
    label,
    driverKind: ProviderDriverKind.make(driver),
  }) satisfies FactoryModelOption;

const ref = (driver: string, model: string): FactoryModelRef => ({
  driver: ProviderDriverKind.make(driver),
  model,
});

const OPTIONS = [
  option("claude-work", "claudeAgent", "claude-opus-5-5", "Claude (work) · Opus 5.5"),
  option("claude-home", "claudeAgent", "claude-opus-5-5", "Claude (home) · Opus 5.5"),
  option("opencode", "opencode", "anthropic/claude-x", "OpenCode · Claude X"),
];

const OPUS = ref("claudeAgent", "claude-opus-5-5");
const CLAUDE_X = ref("opencode", "anthropic/claude-x");
const GPT = ref("codex", "gpt-6");

describe("factory model refs", () => {
  it("resolves a ref to the first option of the same driver and model", () => {
    expect(resolveFactoryModelRef(OPUS, OPTIONS)?.label).toBe("Claude (work) · Opus 5.5");
    expect(resolveFactoryModelRef(CLAUDE_X, OPTIONS)?.label).toBe("OpenCode · Claude X");
    expect(resolveFactoryModelRef(GPT, OPTIONS)).toBeNull();
    expect(resolveFactoryModelRef(ref("codex", "claude-opus-5-5"), OPTIONS)).toBeNull();
  });

  it("names an option by its driver and model, not its instance", () => {
    expect(factoryModelRefFromOption(OPTIONS[1]!)).toEqual(OPUS);
  });

  it("moves an entry up or down and leaves the list alone past either end", () => {
    const list = [OPUS, CLAUDE_X, GPT];
    expect(moveFactoryModelRef(list, 2, -1)).toEqual([OPUS, GPT, CLAUDE_X]);
    expect(moveFactoryModelRef(list, 0, 1)).toEqual([CLAUDE_X, OPUS, GPT]);
    expect(moveFactoryModelRef(list, 0, -1)).toBe(list);
    expect(moveFactoryModelRef(list, 2, 1)).toBe(list);
  });

  it("flags refs this environment cannot run and refs outside the pool", () => {
    expect(describeFactoryModelRefs([OPUS, GPT, CLAUDE_X], OPTIONS, [OPUS, GPT])).toEqual([
      { ref: OPUS, label: "Claude (work) · Opus 5.5", flags: [] },
      { ref: GPT, label: "codex/gpt-6", flags: ["unavailable"] },
      { ref: CLAUDE_X, label: "OpenCode · Claude X", flags: ["not-in-pool"] },
    ]);
    expect(describeFactoryModelRefs([GPT], OPTIONS, null)).toEqual([
      { ref: GPT, label: "codex/gpt-6", flags: ["unavailable"] },
    ]);
  });

  it("summarises a list for its row", () => {
    expect(summarizeFactoryModelList({ dynamic: false, models: [] }, OPTIONS)).toBe(
      "Any model in the pool",
    );
    expect(summarizeFactoryModelList({ dynamic: true, models: [OPUS, GPT] }, OPTIONS)).toBe(
      "Claude (work) · Opus 5.5, codex/gpt-6 · model chosen per task",
    );
  });
});

describe("factoryStarterPool", () => {
  it("pools the Claude and Codex models once each, leaving other drivers out", () => {
    expect(
      factoryStarterPool([...OPTIONS, option("codex", "codex", "gpt-5.5", "Codex · GPT-5.5")]),
    ).toEqual([ref("claudeAgent", "claude-opus-5-5"), ref("codex", "gpt-5.5")]);
  });
});
