import { describe, expect, it } from "vite-plus/test";

import { factorySectionSaveState } from "./factorySectionSave.logic";

describe("factorySectionSaveState", () => {
  const saved: { cap: number; prefs: Record<string, string> } = {
    cap: 2,
    prefs: { claudeAgent: "work" },
  };

  it("is idle with no draft", () => {
    expect(factorySectionSaveState(saved, null, false)).toBe("idle");
  });

  it("is dirty once the draft differs from what is saved", () => {
    expect(factorySectionSaveState(saved, { ...saved, cap: 3 }, false)).toBe("dirty");
    expect(factorySectionSaveState(saved, { ...saved, prefs: {} }, false)).toBe("dirty");
  });

  it("is idle again when the draft is edited back to the saved value", () => {
    expect(factorySectionSaveState(saved, { prefs: { claudeAgent: "work" }, cap: 2 }, false)).toBe(
      "idle",
    );
  });

  it("stays saving while a save is in flight, even with nothing left to save", () => {
    expect(factorySectionSaveState(saved, null, true)).toBe("saving");
    expect(factorySectionSaveState(saved, { ...saved, cap: 3 }, true)).toBe("saving");
  });

  it("is dirty when there is nothing saved yet to compare with", () => {
    expect(factorySectionSaveState(null, saved, false)).toBe("dirty");
  });
});
