import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  IdeaCategoryId,
  IdeaEntryId,
  ThreadId,
  type IdeaContentEdit,
  type IdeaMutation,
  type IdeaNotebook,
} from "@t3tools/contracts";
import { applyIdeaMutation, createIdeaNotebook } from "./IdeaNotebook.ts";

const now = "2026-09-30T12:00:00.000Z";
const later = "2026-09-30T12:00:01.000Z";
const id = IdeaEntryId.make("creation");
const categoryId = IdeaCategoryId.make("notes");
const blank = () => createIdeaNotebook(ThreadId.make("idea-one"), now);
const edit = (state: IdeaNotebook, mutation: IdeaMutation, sequence = 1) =>
  applyIdeaMutation(state, mutation, later, sequence);
const note = (
  markdown = "Create through the home composer.",
): Extract<IdeaContentEdit, { kind: "entry.save" }> => ({
  kind: "entry.save",
  id,
  title: "Creation",
  categoryId,
  baseRevision: 0,
  markdown,
  sources: [],
});
function runUpdate(state: IdeaNotebook, edits: readonly IdeaContentEdit[], runId = "run-one") {
  const requested = edit(state, { kind: "update.request", sequence: 10 });
  const running = edit(requested, { kind: "update.start", runId });
  return edit(running, {
    kind: "update.apply",
    runId,
    throughSequence: 10,
    edits,
    summary: "Organised the creation flow.",
  });
}

describe("idea notebooks", () => {
  it("keeps identical activity evidence unchanged and saves a changed source", () => {
    const original = {
      ...note(),
      sources: [{ kind: "activity" as const, activityId: EventId.make("first-answer") }],
    };
    const state = edit(blank(), original);
    const unchanged = runUpdate(state, [{ ...original, baseRevision: 1 }]);
    expect(unchanged.contentRevision).toBe(1);
    expect(unchanged.entries[0]?.document.revision).toBe(1);
    const changed = runUpdate(state, [
      {
        ...original,
        baseRevision: 1,
        sources: [{ kind: "activity", activityId: EventId.make("revised-answer") }],
      },
    ]);
    expect(changed.entries[0]?.sources).toEqual([
      { kind: "activity", activityId: "revised-answer" },
    ]);
    expect(changed.entries[0]?.document.revision).toBe(2);
  });
  it("starts blank and uses per-idea categories", () => {
    const state = blank();
    expect(state.pitch.markdown).toBe("");
    expect(state.categories.map((category) => category.name)).toEqual([
      "Notes",
      "Possibilities",
      "Decisions",
      "Questions",
    ]);
    const custom = edit(state, {
      kind: "category.save",
      id: IdeaCategoryId.make("access"),
      name: "Access rules",
      baseRevision: 0,
    });
    expect(custom.categories.at(-1)?.name).toBe("Access rules");
    expect(blank().categories).toHaveLength(4);
  });

  it("does not immediately rewrite a manually edited pitch", () => {
    const state = edit(blank(), { kind: "pitch.save", markdown: "My idea", baseRevision: 0 });
    expect(state.update.status).toBe("current");
    expect(state.pitch.author).toBe("user");
  });

  it("applies independent automatic changes and proposes a conflicting change", () => {
    const state = edit(blank(), {
      kind: "pitch.save",
      markdown: "User's saved pitch",
      baseRevision: 0,
    });
    const updated = runUpdate(state, [
      { kind: "pitch.save", markdown: "An older pitch", baseRevision: 0 },
      note(),
    ]);
    expect(updated.pitch.markdown).toBe("User's saved pitch");
    expect(updated.entries[0]?.id).toBe(id);
    expect(updated.proposals[0]?.edits).toHaveLength(1);
    expect(updated.update.processedSequence).toBe(10);
  });

  it("protects active typing with a lease without changing list order", () => {
    const state = blank();
    const editing = edit(state, { kind: "edit.begin", resource: "pitch", leaseId: "editor-one" });
    expect(editing.updatedAt).toBe(state.updatedAt);
    const updated = runUpdate(editing, [
      { kind: "pitch.save", baseRevision: 0, markdown: "New pitch" },
    ]);
    expect(updated.pitch.markdown).toBe("");
    expect(updated.proposals).toHaveLength(1);
  });

  it("rejects a stale proposal review after a newer manual save", () => {
    const proposed = runUpdate(
      edit(blank(), { kind: "pitch.save", markdown: "First", baseRevision: 0 }),
      [{ kind: "pitch.save", baseRevision: 0, markdown: "Automatic" }],
    );
    const current = edit(proposed, { kind: "pitch.save", baseRevision: 1, markdown: "Newer" });
    expect(() =>
      edit(current, {
        kind: "proposal.accept",
        id: "run-one",
        reviewedContentRevision: proposed.contentRevision,
      }),
    ).toThrow("changed");
    expect(
      edit(current, {
        kind: "proposal.accept",
        id: "run-one",
        reviewedContentRevision: current.contentRevision,
      }).pitch.markdown,
    ).toBe("Automatic");
  });

  it("keeps links through merges and removes alias links when deleting the target", () => {
    let state = edit(blank(), note());
    const target = IdeaEntryId.make("flow");
    state = edit(state, { ...note(), kind: "entry.save", id: target, title: "Flow" });
    state = edit(state, {
      kind: "pitch.save",
      baseRevision: 0,
      markdown: "The [creation flow](idea-entry:creation) starts at home.",
    });
    state = edit(state, {
      kind: "entry.merge",
      id,
      targetId: target,
      baseRevision: 1,
      targetRevision: 1,
      markdown: "Merged flow",
    });
    expect(state.aliases).toEqual([{ from: id, to: target }]);
    state = edit(state, { kind: "entry.delete", id: target, baseRevision: 2 });
    expect(state.pitch.markdown).toBe("The creation flow starts at home.");
    expect(state.aliases).toEqual([]);
  });

  it("undoes deletion of a merged note without restoring broken alias links", () => {
    let state = edit(blank(), note());
    const target = IdeaEntryId.make("flow");
    state = edit(state, { ...note(), id: target });
    state = edit(state, {
      kind: "pitch.save",
      baseRevision: 0,
      markdown: "The [creation](idea-entry:creation).",
    });
    state = edit(state, {
      kind: "entry.merge",
      id,
      targetId: target,
      baseRevision: 1,
      targetRevision: 1,
      markdown: "Merged",
    });
    state = runUpdate(state, [{ kind: "entry.delete", id: target, baseRevision: 2 }]);
    state = edit(state, { kind: "update.undo", id: "run-one" });
    expect(state.entries[0]?.id).toBe(target);
    expect(state.pitch.markdown).toBe("The [creation](idea-entry:flow).");
    expect(state.proposals).toHaveLength(0);
  });

  it("does not let automatic updates restore deleted entries", () => {
    const deleted = edit(edit(blank(), note()), { kind: "entry.delete", id, baseRevision: 1 });
    const updated = runUpdate(deleted, [note()]);
    expect(updated.entries).toHaveLength(0);
    expect(updated.proposals).toHaveLength(1);
  });

  it("undo preserves newer manual edits as a review proposal", () => {
    const automatic = runUpdate(blank(), [
      { kind: "pitch.save", baseRevision: 0, markdown: "Automatic pitch" },
    ]);
    const manual = edit(automatic, {
      kind: "pitch.save",
      baseRevision: 1,
      markdown: "User correction",
    });
    const undone = edit(manual, { kind: "update.undo", id: "run-one" });
    expect(undone.pitch.markdown).toBe("User correction");
    expect(undone.proposals[0]?.id).toBe("undo:run-one");
  });

  it("consumes a no-op update and rejects a stale run", () => {
    const current = runUpdate(blank(), []);
    expect(current.update.status).toBe("current");
    expect(current.update.processedSequence).toBe(10);
    expect(() =>
      edit(current, {
        kind: "update.apply",
        runId: "run-one",
        throughSequence: 10,
        edits: [note()],
        summary: "stale",
      }),
    ).toThrow("no longer current");
  });

  it("rejects old category revisions", () => {
    const renamed = edit(blank(), {
      kind: "category.save",
      id: categoryId,
      name: "Research",
      baseRevision: 0,
    });
    expect(() =>
      edit(renamed, { kind: "category.save", id: categoryId, name: "Old update", baseRevision: 0 }),
    ).toThrow("changed");
  });

  it("applies new entries before dependent pitch links and proposes links to unavailable notes", () => {
    const linked = runUpdate(blank(), [
      { kind: "pitch.save", baseRevision: 0, markdown: "The [creation](idea-entry:creation)." },
      note(),
    ]);
    expect(linked.proposals).toHaveLength(0);
    expect(linked.pitch.markdown).toContain("idea-entry:creation");
    const missing = runUpdate(blank(), [
      { kind: "pitch.save", baseRevision: 0, markdown: "A [missing note](idea-entry:missing)." },
    ]);
    expect(missing.pitch.markdown).toBe("");
    expect(missing.proposals).toHaveLength(1);
  });

  it("proposes a pitch update when its referenced note update conflicts", () => {
    const state = edit(blank(), note("User wording"));
    const result = runUpdate(state, [
      { ...note("Old wording"), baseRevision: 0 },
      { kind: "pitch.save", baseRevision: 0, markdown: "Use [old wording](idea-entry:creation)." },
    ]);
    expect(result.pitch.markdown).toBe("");
    expect(result.entries[0]?.document.markdown).toBe("User wording");
    expect(result.proposals[0]?.edits).toHaveLength(2);
  });

  it("validates and unlinks encoded entry IDs", () => {
    const encodedId = IdeaEntryId.make("flow (draft)");
    let state = edit(blank(), { ...note(), id: encodedId });
    state = edit(state, {
      kind: "pitch.save",
      baseRevision: 0,
      markdown: "The [flow](idea-entry:flow%20%28draft%29).",
    });
    state = edit(state, { kind: "entry.delete", id: encodedId, baseRevision: 1 });
    expect(state.pitch.markdown).toBe("The flow.");
  });

  it("waits for foreground completion and rejects a superseded background result", () => {
    const state = {
      ...blank(),
      update: { ...blank().update, status: "waiting" as const, requestedSequence: 7 },
    };
    expect(() => edit(state, { kind: "update.start", runId: "early" })).toThrow("completed");
    const manual = edit(state, note());
    expect(manual.update.status).toBe("waiting");
    expect(() => edit(state, { kind: "update.fail", runId: "old", error: "Late failure" })).toThrow(
      "no longer current",
    );
    expect(edit(state, { kind: "update.request", sequence: 8 }).update.status).toBe("pending");
  });

  it("settles explicitly dropped scope and reopens without removing publication receipts", () => {
    const state = blank();
    const settled = edit(state, {
      kind: "idea.settle",
      reviewedContentRevision: state.contentRevision,
    });
    expect(settled.status).toBe("settled");
    const reopened = edit(settled, {
      kind: "idea.reopen",
      reviewedContentRevision: settled.contentRevision,
    });
    expect(reopened.status).toBe("active");
    expect(reopened.promotionHistory).toEqual(settled.promotionHistory);
  });

  it("keeps identical automatic edits out of revisions and update history", () => {
    const state = edit(blank(), note());
    const result = runUpdate(state, [
      { ...note(), baseRevision: 1 },
      { kind: "pitch.save", baseRevision: 0, markdown: "" },
      { kind: "category.save", id: categoryId, name: "Notes", baseRevision: 0 },
    ]);
    expect(result.contentRevision).toBe(state.contentRevision);
    expect(result.entries[0]?.document.revision).toBe(1);
    expect(result.history).toHaveLength(0);
    expect(result.update.status).toBe("current");
  });

  it("proposes category merges while an affected note is being edited", () => {
    const state = edit(edit(blank(), note()), {
      kind: "edit.begin",
      resource: `entry:${id}`,
      leaseId: "typing",
    });
    const result = runUpdate(state, [
      {
        kind: "category.merge",
        id: categoryId,
        targetId: IdeaCategoryId.make("decisions"),
        baseRevision: 0,
        targetRevision: 0,
      },
    ]);
    expect(result.entries[0]?.categoryId).toBe(categoryId);
    expect(result.proposals).toHaveLength(1);
  });

  it("fences abandoned runs when a pending update resumes after restart", () => {
    let state = edit(blank(), { kind: "update.request", sequence: 8 });
    state = edit(state, { kind: "update.start", runId: "old" });
    state = edit(state, { kind: "update.start", runId: "recovered" });
    expect(() =>
      edit(state, {
        kind: "update.apply",
        runId: "old",
        throughSequence: 8,
        edits: [note()],
        summary: "late",
      }),
    ).toThrow("no longer current");
    expect(
      edit(state, {
        kind: "update.apply",
        runId: "recovered",
        throughSequence: 8,
        edits: [],
        summary: "No change",
      }).update.status,
    ).toBe("current");
  });

  it("settles only complete verified coverage and retains published receipts", () => {
    let state = blank();
    const promotion = {
      target: { host: "github.com", repository: "example/repo" },
      id: "promotion-one",
      sourceRevision: state.contentRevision,
      status: "review" as const,
      drafts: [
        { id: "ticket-one", title: "Build ideas", body: "Self contained requirements", labels: [] },
      ],
      issues: [],
      remainingScope: "",
      error: null,
    };
    state = edit(state, { kind: "promotion.propose", promotion });
    state = edit(state, {
      kind: "promotion.approve",
      id: promotion.id,
      sourceRevision: state.contentRevision,
    });
    state = edit(state, {
      kind: "promotion.record",
      promotion: {
        ...promotion,
        status: "complete",
        issues: [
          {
            draftId: "ticket-one",
            url: "https://github.com/example/repo/issues/1",
            number: 1,
            title: "Build ideas",
            publishedAt: now,
          },
        ],
      },
    });
    expect(state.status).toBe("settled");
    const read = edit(state, { kind: "edit.begin", resource: "pitch", leaseId: "reader" });
    expect(read.status).toBe("settled");
    state = edit(state, { kind: "pitch.save", baseRevision: 0, markdown: "Next scope" });
    expect(state.status).toBe("active");
    state = edit(state, {
      kind: "promotion.propose",
      promotion: { ...promotion, id: "next", sourceRevision: state.contentRevision },
    });
    expect(state.promotionHistory[0]?.issues[0]?.number).toBe(1);
  });

  it("fences every late mutation as soon as deletion starts", () => {
    const deleted = edit(blank(), { kind: "delete.request" });
    expect(deleted.deletionEpoch).toBe(1);
    expect(() => edit(deleted, note())).toThrow("being deleted");
    expect(() => edit(deleted, { kind: "edit.begin", resource: "pitch", leaseId: "late" })).toThrow(
      "being deleted",
    );
  });
});
