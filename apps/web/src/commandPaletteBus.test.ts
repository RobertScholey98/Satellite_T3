import { describe, expect, it } from "vite-plus/test";

import { runAfterCommandPaletteCloses, takeCommandPaletteAfterClose } from "./commandPaletteBus";

describe("command palette after-close action", () => {
  it("hands the pending action to one close and then clears it", () => {
    const ran: string[] = [];
    runAfterCommandPaletteCloses(() => ran.push("rename"));
    takeCommandPaletteAfterClose()?.();
    expect(ran).toEqual(["rename"]);
    expect(takeCommandPaletteAfterClose()).toBeNull();
  });

  it("drops an action the palette discarded so a later close does not run it", () => {
    const ran: string[] = [];
    runAfterCommandPaletteCloses(() => ran.push("stale rename"));
    takeCommandPaletteAfterClose();
    runAfterCommandPaletteCloses(() => ran.push("fresh rename"));
    takeCommandPaletteAfterClose()?.();
    expect(ran).toEqual(["fresh rename"]);
  });
});
