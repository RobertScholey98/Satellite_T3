import { describe, expect, it } from "vite-plus/test";

import { factoryModelOptionLabel } from "./FactoryPageConfig";

describe("factoryModelOptionLabel", () => {
  it("drops the provider when the model name already starts with it", () => {
    expect(factoryModelOptionLabel("Claude", "Claude Opus 5.5")).toBe("Claude Opus 5.5");
  });

  it("keeps the provider when the model name does not say it", () => {
    expect(factoryModelOptionLabel("Codex", "GPT-5.5")).toBe("Codex · GPT-5.5");
    expect(factoryModelOptionLabel("Claude (work)", "Claude Opus 5.5")).toBe(
      "Claude (work) · Claude Opus 5.5",
    );
  });

  it("only matches the provider as a whole word", () => {
    expect(factoryModelOptionLabel("Claude", "Claudette 1")).toBe("Claude · Claudette 1");
  });
});
