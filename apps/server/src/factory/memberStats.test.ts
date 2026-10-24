import { assert, describe, it } from "@effect/vitest";

import { rollupMemberStats } from "./memberStats.ts";

const usage = (input: number, agentMs: number) => ({
  input,
  cachedInput: input / 2,
  output: input / 10,
  agentMs,
});

describe("rollupMemberStats", () => {
  it("counts delegations per member and rolls sub-agents into their parent's member", () => {
    const members = [
      { threadId: "lead-1", memberName: null, joined: "created" },
      { threadId: "builder-1", memberName: "Builder", joined: "created" },
      { threadId: "checker-1", memberName: "Checker", joined: "created" },
      // A sub-agent of builder-1: its usage counts toward Builder, but not as a delegation.
      { threadId: "sub-1", memberName: "Builder", joined: "observed" },
      { threadId: "builder-2", memberName: "Builder", joined: "created" },
    ];
    const used = new Map([
      ["lead-1", usage(1000, 9000)],
      ["builder-1", usage(200, 2000)],
      ["sub-1", usage(40, 400)],
      ["builder-2", usage(100, 1000)],
    ]);

    assert.deepStrictEqual(rollupMemberStats(members, used), [
      {
        name: "Builder",
        delegations: 2,
        tokens: { input: 340, cachedInput: 170, output: 34 },
        agentMs: 3400,
      },
      {
        name: "Checker",
        delegations: 1,
        tokens: { input: 0, cachedInput: 0, output: 0 },
        agentMs: 0,
      },
    ]);
    assert.deepStrictEqual(
      rollupMemberStats(members, used, ["Checker", "Builder"]).map((member) => member.name),
      ["Checker", "Builder"],
    );
  });
});
