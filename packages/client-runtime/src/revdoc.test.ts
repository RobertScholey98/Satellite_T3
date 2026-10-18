import {
  ProjectId,
  REVDOC_LIMITS,
  type RevdocEvent,
  type RevdocItemDetail,
  type RevdocItemSummary,
  RevdocEvent as RevdocEventSchema,
  RevdocItemDetail as RevdocItemDetailSchema,
  type RevdocReviewHeader,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  applyRevdocEvent,
  appendToDraft,
  draftFixRequest,
  EMPTY_REVDOC_STATE,
  summarizeRevdoc,
} from "./revdoc.ts";

const header = (revision: number): RevdocReviewHeader => ({
  id: "review-1",
  projectId: ProjectId.make("project-1"),
  worktreePath: "/work/checkout",
  revision,
  title: "Checkout",
  summary: "Payments",
  context: "",
  partial: false,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
  generatedAt: "2026-10-17T00:00:00.000Z",
  refreshedAt: null,
  exportError: null,
});

const summary = (index: number, overrides: Partial<RevdocItemSummary> = {}): RevdocItemSummary => ({
  id: `chk-${String(index).padStart(12, "0")}`,
  revision: 3,
  position: index,
  area: `Area ${index % 12}`,
  check: `Open the settings page from the sidebar and change setting number ${index} to a new value`,
  outcome: "change_requested",
  note: `Use the shared helper here and keep the old label for number ${index}.`,
  noteTruncated: false,
  retest: null,
  stale: false,
  dismissed: false,
  result: { state: "failed", evidenceCount: 2 },
  ...overrides,
});

const detail = (index: number, overrides: Partial<RevdocItemDetail> = {}): RevdocItemDetail => ({
  ...summary(index),
  expected: `Setting ${index} saves and the page shows the new value after a reload.`,
  coveredPaths: [
    "apps/web/src/components/settings/SettingsPanels.tsx",
    "packages/contracts/src/settings.ts",
  ],
  result: {
    passId: "pass-000000000001",
    state: "failed",
    method: "browser",
    steps: "Opened settings, changed the value, reloaded the page and compared the field.",
    observed: `The page reverted setting ${index} to its old value after the reload.`,
    model: "codex/gpt-5.4",
    recordedAt: "2026-10-17T01:00:00.000Z",
    evidence: [1, 2].map((shot) => ({
      id: `ev-${index}-${shot}`,
      caption: `Settings after reload, shot ${shot}`,
      capturedAt: "2026-10-17T01:00:00.000Z",
      path: `.revdoc/evidence/ev-${index}-${shot}.png`,
    })),
  },
  ...overrides,
});

const snapshot = (items: ReadonlyArray<RevdocItemSummary>, revision = 4): RevdocEvent => ({
  _tag: "snapshot",
  snapshot: {
    worktreePath: "/work/checkout",
    review: header(revision),
    items,
    activePass: null,
    latestPasses: [],
    testParentThreadId: null,
  },
});

const encodeEvent = Schema.encodeSync(RevdocEventSchema);
const encodeDetail = Schema.encodeSync(
  Schema.Struct({ items: Schema.Array(RevdocItemDetailSchema) }),
);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("applyRevdocEvent", () => {
  it("applies the next commit, keeps order, and flags a skipped revision", () => {
    const loaded = applyRevdocEvent(EMPTY_REVDOC_STATE, snapshot([summary(0), summary(1)]));
    const next = applyRevdocEvent(loaded, {
      _tag: "delta",
      revision: 5,
      items: [summary(2, { position: 0 }), summary(0, { position: 1, outcome: "complete" })],
      removed: [summary(1).id],
    });
    expect(next.items.map((item) => [item.id, item.outcome])).toEqual([
      [summary(2).id, "change_requested"],
      [summary(0).id, "complete"],
    ]);
    expect(next.revision).toBe(5);
    expect(applyRevdocEvent(next, { _tag: "delta", revision: 7, items: [] }).gap).toBe(true);
    expect(applyRevdocEvent(next, { _tag: "delta", revision: 4, items: [summary(9)] })).toBe(next);
  });

  it("takes pass progress at the current revision and marks a deletion seen by this client", () => {
    const loaded = applyRevdocEvent(EMPTY_REVDOC_STATE, snapshot([summary(0)]));
    const pass = {
      id: "pass-1",
      kind: "generate" as const,
      status: "running" as const,
      startedAt: "2026-10-17T00:00:00.000Z",
      finishedAt: null,
      model: null,
      error: null,
      report: null,
      generation: { stage: "reviewing" as const, completed: 1, total: 3, running: [] },
      testing: null,
    };
    const progressed = applyRevdocEvent(loaded, { _tag: "delta", revision: 4, activePass: pass });
    expect(progressed.activePass).toEqual(pass);
    const deleted = applyRevdocEvent(progressed, { _tag: "deleted", revision: 0 });
    expect([deleted.review, deleted.items, deleted.deleted, deleted.revision]).toEqual([
      null,
      [],
      true,
      0,
    ]);
    const recreated = applyRevdocEvent(deleted, {
      _tag: "delta",
      revision: 1,
      review: header(1),
      items: [summary(0)],
    });
    expect([recreated.gap, recreated.deleted, recreated.items.length]).toEqual([false, false, 1]);
  });
});

describe("summarizeRevdoc", () => {
  it("counts needs retest as not reviewed and leaves out dismissed checks", () => {
    expect(
      summarizeRevdoc([
        summary(0, { outcome: "complete", result: null }),
        summary(1, { outcome: "complete", retest: "code", result: null }),
        summary(2, { outcome: "broken", result: null }),
        summary(3, { outcome: "not_checked", result: { state: "failed", evidenceCount: 0 } }),
        summary(4, { outcome: "not_checked", stale: true, result: null }),
        summary(5, { outcome: "complete", stale: true, dismissed: true, result: null }),
      ]),
    ).toEqual({ total: 5, reviewed: 2, findings: 2, needsRetest: 1, stale: 1, dismissed: 1 });
  });
});

describe("draftFixRequest", () => {
  it("lists each finding with id, check, expected, observed, and note, and names revdoc_read", () => {
    const text = draftFixRequest([
      detail(1),
      detail(2, { outcome: "complete", result: null }),
      detail(3, { outcome: "broken", note: "", result: null }),
      detail(4, { stale: true }),
    ]);
    expect(text).toBe(
      [
        "Please fix these findings from the Revdoc review of this worktree. Read the full review with the revdoc_read tool (or .revdoc/review.json) before changing code, and keep each fix scoped to its check.",
        [
          `- [${summary(1).id}] ${summary(1).check}`,
          "  Expected: Setting 1 saves and the page shows the new value after a reload.",
          "  Observed: The page reverted setting 1 to its old value after the reload.",
          "  Outcome: Change requested",
          "  Note: Use the shared helper here and keep the old label for number 1.",
        ].join("\n"),
        [
          `- [${summary(3).id}] ${summary(3).check}`,
          "  Expected: Setting 3 saves and the page shows the new value after a reload.",
          "  Outcome: Broken",
        ].join("\n"),
      ].join("\n\n"),
    );
    expect(appendToDraft("Also rename the file.  \n", "Fix it")).toBe(
      "Also rename the file.\n\nFix it",
    );
    expect(appendToDraft("", "Fix it")).toBe("Fix it");
  });
});

describe("Revdoc payload budgets", () => {
  it("keeps snapshots, deltas, and item details within their byte budgets", () => {
    const items200 = Array.from({ length: 200 }, (_, index) => summary(index));
    const items2000 = Array.from({ length: 2_000 }, (_, index) => summary(index));
    expect(bytes(encodeEvent(snapshot(items200)))).toBeLessThanOrEqual(128 * 1024);
    expect(bytes(encodeEvent(snapshot(items2000)))).toBeLessThanOrEqual(1024 * 1024);
    expect(
      bytes(encodeEvent({ _tag: "delta", revision: 5, review: header(5), items: [summary(1)] })),
    ).toBeLessThanOrEqual(4 * 1024);
    // The longest allowed note still ships as a preview in a delta.
    const longNote = summary(1, {
      note: "n".repeat(REVDOC_LIMITS.note).slice(0, REVDOC_LIMITS.notePreview),
      noteTruncated: true,
      check: "c".repeat(REVDOC_LIMITS.check),
    });
    expect(
      bytes(encodeEvent({ _tag: "delta", revision: 5, review: header(5), items: [longNote] })),
    ).toBeLessThanOrEqual(4 * 1024);
    expect(
      bytes(encodeDetail({ items: Array.from({ length: 20 }, (_, index) => detail(index)) })),
    ).toBeLessThanOrEqual(64 * 1024);
  });
});
