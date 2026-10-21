import { IssueOperationError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  automaticMovesState,
  decideAutomaticMove,
  decideManualMove,
  isTransientFailure,
  moveRetryDelayMs,
  type AutomaticMoveFacts,
} from "./moveReconciliation.ts";

const titles: Record<string, string> = {
  ready: "Ready",
  progress: "In progress",
  review: "In PR",
  blocked: "Blocked",
};
const facts = (overrides: Partial<AutomaticMoveFacts>): AutomaticMoveFacts => ({
  attemptActive: true,
  latestTransition: true,
  pendingManualMove: false,
  remoteColumn: "progress",
  target: "review",
  baseline: "progress",
  readyColumns: ["ready"],
  columnTitle: (id) => (id === null ? "No column" : (titles[id] ?? id)),
  ...overrides,
});

describe("decideAutomaticMove", () => {
  it.each([
    ["remote at baseline writes", {}, { _tag: "Write" }],
    [
      "remote already at target applies without a write",
      { remoteColumn: "review" },
      { _tag: "AlreadyThere" },
    ],
    [
      "remote elsewhere skips as moved by hand",
      { remoteColumn: "blocked" },
      { _tag: "Skipped", reason: "Moved by hand to Blocked." },
    ],
    [
      "a pending manual move skips",
      { pendingManualMove: true },
      { _tag: "Skipped", reason: "A manual move for this ticket has not reached the board yet." },
    ],
    ["a stale transition is superseded", { latestTransition: false }, { _tag: "Superseded" }],
    ["an inactive attempt is superseded", { attemptActive: false }, { _tag: "Superseded" }],
    [
      "before the first move any Ready column counts as the baseline",
      { baseline: null, remoteColumn: "ready", target: "progress" },
      { _tag: "Write" },
    ],
    [
      "before the first move a ticket outside Ready skips",
      { baseline: null, remoteColumn: null, target: "progress" },
      { _tag: "Skipped", reason: "Moved by hand to No column." },
    ],
    [
      "a ticket put back at the baseline resumes",
      { baseline: "review", remoteColumn: "review", target: "progress" },
      { _tag: "Write" },
    ],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(decideAutomaticMove(facts(overrides))).toEqual(expected);
  });
});

describe("decideManualMove", () => {
  it.each([
    ["remote matches what the person saw", { expected: "ready", remoteColumn: "ready" }, "write"],
    ["no expectation sent", { expected: undefined, remoteColumn: "blocked" }, "write"],
    [
      "remote differs from what the person saw",
      { expected: "ready", remoteColumn: "blocked" },
      "conflict",
    ],
    [
      "remote already at the target",
      { expected: "review", remoteColumn: "review" },
      "already-there",
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(decideManualMove({ ...input, target: "review" })).toBe(expected);
  });
});

describe("automaticMovesState", () => {
  const base = { active: true, baseline: "progress", readyColumns: ["ready"], pendingTarget: null };
  it("is on while the stored copy shows the ticket at the baseline", () => {
    expect(automaticMovesState({ ...base, storedColumn: "progress" })).toBe("on");
  });
  it("is paused when the stored copy shows the ticket elsewhere", () => {
    expect(automaticMovesState({ ...base, storedColumn: "blocked" })).toBe("paused");
  });
  it("is on when the ticket sits at a pending automatic target", () => {
    expect(automaticMovesState({ ...base, storedColumn: "review", pendingTarget: "review" })).toBe(
      "on",
    );
  });
  it("is on for an inactive attempt", () => {
    expect(automaticMovesState({ ...base, active: false, storedColumn: "blocked" })).toBe("on");
  });
});

describe("move failures", () => {
  it("treats only remote failures as transient", () => {
    const failure = (reason: IssueOperationError["reason"]) =>
      new IssueOperationError({ reason, message: reason });
    expect(
      (["remote", "authentication", "invalid", "not-found", "unavailable"] as const).map((reason) =>
        isTransientFailure(failure(reason)),
      ),
    ).toEqual([true, false, false, false, false]);
  });
  it("backs off between one minute and one hour", () => {
    expect([0, 90_000, 10 * 60_000, 5 * 60 * 60_000].map(moveRetryDelayMs)).toEqual([
      60_000, 90_000, 600_000, 3_600_000,
    ]);
  });
});
