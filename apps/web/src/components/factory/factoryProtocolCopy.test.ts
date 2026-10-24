import { describe, expect, it } from "vite-plus/test";

import { looksLikeProtocolCopy } from "./factoryProtocolCopy";

describe("looksLikeProtocolCopy", () => {
  it("spots the built-in protocol's first heading on a line of its own", () => {
    expect(looksLikeProtocolCopy("lead", "# Lead\n\n## What you are\n\nYou are a lead.")).toBe(
      true,
    );
    expect(looksLikeProtocolCopy("lead", "Keep PRs small.\r\n# Lead  \r\nYou are a lead.")).toBe(
      true,
    );
    expect(looksLikeProtocolCopy("manager", "# Engineering manager\n\nYou decide.")).toBe(true);
  });

  it("leaves added instructions alone, and each kind looks only for its own heading", () => {
    expect(looksLikeProtocolCopy("lead", "Keep PRs small. # Lead reviews are optional.")).toBe(
      false,
    );
    expect(looksLikeProtocolCopy("lead", "## Lead notes\n\nKeep PRs small.")).toBe(false);
    expect(looksLikeProtocolCopy("manager", "# Lead\n\nYou are a lead.")).toBe(false);
    expect(looksLikeProtocolCopy("manager", "")).toBe(false);
  });
});
