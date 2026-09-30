import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { IdeaNotebook as IdeaNotebookSchema } from "@t3tools/contracts";
import {
  IdeaCategoryId,
  type IdeaContentEdit,
  type IdeaEntry,
  type IdeaMutation,
  type IdeaNotebook,
  type ThreadId,
} from "@t3tools/contracts";

const encodeNotebook = Schema.encodeSync(Schema.fromJsonString(IdeaNotebookSchema));

export class IdeaConflict extends Error {}

export function createIdeaNotebook(threadId: ThreadId, now: string): IdeaNotebook {
  return {
    threadId,
    revision: 0,
    contentRevision: 0,
    deletionEpoch: 0,
    status: "active",
    updatedAt: now,
    pitch: { markdown: "", revision: 0, author: "user", updatedAt: now },
    categories: ["Notes", "Possibilities", "Decisions", "Questions"].map((name) => ({
      id: IdeaCategoryId.make(name.toLowerCase()),
      name,
      revision: 0,
    })),
    editLeases: [],
    entries: [],
    aliases: [],
    deletedEntries: [],
    artifacts: [],
    update: {
      status: "current",
      processedSequence: 0,
      requestedSequence: 0,
      runId: null,
      error: null,
    },
    proposals: [],
    history: [],
    promotionHistory: [],
    promotion: null,
    deletionError: null,
  };
}

function expectRevision(actual: number, expected: number) {
  if (actual !== expected)
    throw new IdeaConflict(
      "This content changed. Your draft has been preserved; review the latest version before saving.",
    );
}

function linkTarget(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function linkedEntries(markdown: string) {
  return [...markdown.matchAll(/\]\(idea-entry:([^)]*)\)/g)].map((match) => linkTarget(match[1]!));
}

function unlink(markdown: string, id: string) {
  return markdown.replace(
    /\[([^\]]+)\]\(idea-entry:([^)]*)\)/g,
    (link, label: string, target: string) => (linkTarget(target) === id ? label : link),
  );
}

function savedEntry(entry: IdeaEntry, baseRevision = entry.document.revision): IdeaContentEdit {
  return {
    kind: "entry.save",
    id: entry.id,
    title: entry.title,
    categoryId: entry.categoryId,
    markdown: entry.document.markdown,
    sources: entry.sources,
    baseRevision,
    restore: true,
  };
}

function editResource(edit: IdeaContentEdit) {
  if (edit.kind === "pitch.save") return "pitch";
  if (edit.kind.startsWith("category.")) return "categories";
  return "id" in edit ? `entry:${edit.id}` : "categories";
}

function applyContent(
  state: IdeaNotebook,
  edit: IdeaContentEdit,
  now: string,
  author: "user" | "updater",
): { state: IdeaNotebook; inverse: readonly IdeaContentEdit[] } {
  if (author === "updater") {
    if (edit.kind === "pitch.save" && edit.markdown === state.pitch.markdown)
      return { state, inverse: [] };
    if (
      edit.kind === "category.save" &&
      state.categories.some((category) => category.id === edit.id && category.name === edit.name)
    )
      return { state, inverse: [] };
    if (edit.kind === "entry.save") {
      const previous = state.entries.find((entry) => entry.id === edit.id);
      if (
        previous &&
        previous.title === edit.title &&
        previous.categoryId === edit.categoryId &&
        previous.document.markdown === edit.markdown &&
        previous.sources.length === edit.sources.length &&
        previous.sources.every((source, index) => {
          const proposed = edit.sources[index];
          return (
            proposed?.kind === source.kind &&
            (source.kind === "message"
              ? proposed.kind === "message" && source.messageId === proposed.messageId
              : source.kind === "activity"
                ? proposed.kind === "activity" && source.activityId === proposed.activityId
                : proposed.kind === "artifact" && source.artifactId === proposed.artifactId)
          );
        })
      )
        return { state, inverse: [] };
    }
  }
  const next = { ...state };
  const inverse: IdeaContentEdit[] = [];
  if (
    author === "updater" &&
    state.editLeases.some((lease) => lease.resource === editResource(edit) && lease.expiresAt > now)
  ) {
    throw new IdeaConflict("You are editing this content.");
  }
  switch (edit.kind) {
    case "pitch.save":
      for (const id of linkedEntries(edit.markdown)) {
        const target = state.aliases.find((alias) => alias.from === id)?.to ?? id;
        if (!state.entries.some((entry) => entry.id === target))
          throw new IdeaConflict(
            "A pitch link refers to an unavailable entry. Review the entry first.",
          );
      }
      expectRevision(state.pitch.revision, edit.baseRevision);
      next.pitch = {
        markdown: edit.markdown,
        revision: state.pitch.revision + 1,
        updatedAt: now,
        author,
      };
      inverse.push({
        kind: "pitch.save",
        baseRevision: next.pitch.revision,
        markdown: state.pitch.markdown,
      });
      break;
    case "entry.save": {
      if (!state.categories.some((category) => category.id === edit.categoryId))
        throw new IdeaConflict("Choose an existing category.");
      const previous = state.entries.find((entry) => entry.id === edit.id);
      const deleted = state.deletedEntries.some((entry) => entry.id === edit.id);
      if (deleted && !(author === "user" && edit.restore))
        throw new IdeaConflict("This entry was deleted. Earlier discussion cannot recreate it.");
      expectRevision(previous?.document.revision ?? 0, edit.baseRevision);
      const entry: IdeaEntry = {
        id: edit.id,
        title: edit.title,
        categoryId: edit.categoryId,
        sources: edit.sources,
        document: {
          markdown: edit.markdown,
          revision: (previous?.document.revision ?? 0) + 1,
          updatedAt: now,
          author,
        },
      };
      next.entries = previous
        ? state.entries.map((item) => (item.id === edit.id ? entry : item))
        : [...state.entries, entry];
      if (deleted) next.deletedEntries = state.deletedEntries.filter((item) => item.id !== edit.id);
      next.aliases = state.aliases.filter((alias) => alias.from !== edit.id);
      inverse.push(
        previous
          ? savedEntry(previous, entry.document.revision)
          : { kind: "entry.delete", id: edit.id, baseRevision: entry.document.revision },
      );
      break;
    }
    case "entry.delete": {
      const entry = state.entries.find((item) => item.id === edit.id);
      if (!entry) throw new IdeaConflict("This entry no longer exists.");
      expectRevision(entry.document.revision, edit.baseRevision);
      next.entries = state.entries.filter((item) => item.id !== edit.id);
      next.deletedEntries = [
        ...state.deletedEntries,
        { id: edit.id, throughSequence: state.update.requestedSequence },
      ];
      const removedIds = new Set<string>([
        edit.id,
        ...state.aliases.filter((alias) => alias.to === edit.id).map((alias) => alias.from),
      ]);
      next.aliases = state.aliases.filter(
        (alias) => !removedIds.has(alias.from) && !removedIds.has(alias.to),
      );
      const markdown = [...removedIds].reduce((text, id) => unlink(text, id), state.pitch.markdown);
      if (
        author === "updater" &&
        markdown !== state.pitch.markdown &&
        state.editLeases.some((lease) => lease.resource === "pitch" && lease.expiresAt > now)
      )
        throw new IdeaConflict("You are editing a pitch that references this entry.");
      if (markdown !== state.pitch.markdown) {
        next.pitch = {
          ...state.pitch,
          markdown,
          revision: state.pitch.revision + 1,
          updatedAt: now,
        };
        const restoredPitch = state.pitch.markdown.replace(
          /\[([^\]]+)\]\(idea-entry:([^)]*)\)/g,
          (link, label: string, target: string) =>
            removedIds.has(linkTarget(target))
              ? `[${label}](idea-entry:${encodeURIComponent(edit.id).replace(/\(/g, "%28").replace(/\)/g, "%29")})`
              : link,
        );
        inverse.push({
          kind: "pitch.save",
          markdown: restoredPitch,
          baseRevision: next.pitch.revision,
        });
      }
      inverse.unshift(savedEntry(entry, 0));
      break;
    }
    case "entry.merge": {
      if (edit.id === edit.targetId) throw new IdeaConflict("Choose another entry to merge into.");
      const source = state.entries.find((item) => item.id === edit.id);
      const target = state.entries.find((item) => item.id === edit.targetId);
      if (!source || !target) throw new IdeaConflict("Both entries must exist.");
      expectRevision(source.document.revision, edit.baseRevision);
      expectRevision(target.document.revision, edit.targetRevision);
      if (
        author === "updater" &&
        state.editLeases.some(
          (lease) => lease.resource === `entry:${target.id}` && lease.expiresAt > now,
        )
      )
        throw new IdeaConflict("You are editing the destination entry.");
      next.entries = state.entries
        .filter((item) => item.id !== source.id)
        .map((item) =>
          item.id === target.id
            ? {
                ...item,
                sources: [...target.sources, ...source.sources],
                document: {
                  markdown: edit.markdown,
                  revision: target.document.revision + 1,
                  updatedAt: now,
                  author,
                },
              }
            : item,
        );
      next.aliases = [
        ...state.aliases.map((alias) =>
          alias.to === source.id ? { ...alias, to: target.id } : alias,
        ),
        { from: source.id, to: target.id },
      ];
      inverse.push(savedEntry(source, 0), savedEntry(target, target.document.revision + 1));
      break;
    }
    case "category.save": {
      const previous = state.categories.find((item) => item.id === edit.id);
      expectRevision(previous?.revision ?? 0, edit.baseRevision);
      const category = { id: edit.id, name: edit.name, revision: (previous?.revision ?? 0) + 1 };
      next.categories = previous
        ? state.categories.map((item) => (item.id === edit.id ? category : item))
        : [...state.categories, category];
      inverse.push(
        previous
          ? {
              kind: "category.save",
              id: edit.id,
              name: previous.name,
              baseRevision: category.revision,
            }
          : { kind: "category.delete", id: edit.id, baseRevision: category.revision },
      );
      break;
    }
    case "category.delete": {
      const previous = state.categories.find((item) => item.id === edit.id);
      if (!previous) throw new IdeaConflict("This category no longer exists.");
      expectRevision(previous.revision, edit.baseRevision);
      if (state.entries.some((entry) => entry.categoryId === edit.id))
        throw new IdeaConflict("Move the category's entries before deleting it.");
      next.categories = state.categories.filter((item) => item.id !== edit.id);
      inverse.push({ kind: "category.save", id: edit.id, name: previous.name, baseRevision: 0 });
      break;
    }
    case "category.merge": {
      const source = state.categories.find((item) => item.id === edit.id);
      const target = state.categories.find((item) => item.id === edit.targetId);
      if (!source || !target || source.id === target.id)
        throw new IdeaConflict("Choose two existing categories.");
      if (
        author === "updater" &&
        state.entries.some(
          (entry) =>
            entry.categoryId === source.id &&
            state.editLeases.some(
              (lease) => lease.resource === `entry:${entry.id}` && lease.expiresAt > now,
            ),
        )
      )
        throw new IdeaConflict("You are editing an entry in this category.");
      expectRevision(source.revision, edit.baseRevision);
      expectRevision(target.revision, edit.targetRevision);
      next.categories = state.categories
        .filter((item) => item.id !== source.id)
        .map((item) => (item.id === target.id ? { ...item, revision: item.revision + 1 } : item));
      inverse.push({ kind: "category.save", id: source.id, name: source.name, baseRevision: 0 });
      next.entries = state.entries.map((entry) => {
        if (entry.categoryId !== source.id) return entry;
        inverse.push(savedEntry(entry, entry.document.revision + 1));
        return {
          ...entry,
          categoryId: target.id,
          document: {
            ...entry.document,
            revision: entry.document.revision + 1,
            updatedAt: now,
            author,
          },
        };
      });
      break;
    }
  }
  return { state: next, inverse };
}

function isContentEdit(mutation: IdeaMutation): mutation is IdeaContentEdit {
  return (
    mutation.kind.startsWith("pitch.") ||
    mutation.kind.startsWith("entry.") ||
    mutation.kind.startsWith("category.")
  );
}

function rebaseEdit(state: IdeaNotebook, edit: IdeaContentEdit): IdeaContentEdit {
  switch (edit.kind) {
    case "pitch.save":
      return { ...edit, baseRevision: state.pitch.revision };
    case "entry.save":
    case "entry.delete":
      return {
        ...edit,
        baseRevision: state.entries.find((entry) => entry.id === edit.id)?.document.revision ?? 0,
      };
    case "entry.merge":
      return {
        ...edit,
        baseRevision: state.entries.find((entry) => entry.id === edit.id)?.document.revision ?? 0,
        targetRevision:
          state.entries.find((entry) => entry.id === edit.targetId)?.document.revision ?? 0,
      };
    case "category.save":
    case "category.delete":
      return {
        ...edit,
        baseRevision: state.categories.find((category) => category.id === edit.id)?.revision ?? 0,
      };
    case "category.merge":
      return {
        ...edit,
        baseRevision: state.categories.find((category) => category.id === edit.id)?.revision ?? 0,
        targetRevision:
          state.categories.find((category) => category.id === edit.targetId)?.revision ?? 0,
      };
  }
}

export function applyIdeaMutation(
  state: IdeaNotebook,
  mutation: IdeaMutation,
  now: string,
  sequence: number,
): IdeaNotebook {
  if (
    state.status === "deleting" &&
    mutation.kind !== "delete.fail" &&
    mutation.kind !== "delete.request"
  )
    throw new IdeaConflict("This idea is being deleted.");
  let next: { -readonly [K in keyof IdeaNotebook]: IdeaNotebook[K] } = {
    ...state,
    revision: state.revision + 1,
    updatedAt:
      mutation.kind === "edit.begin" ||
      mutation.kind === "edit.end" ||
      mutation.kind.startsWith("update.")
        ? state.updatedAt
        : now,
    editLeases: state.editLeases.filter((lease) => lease.expiresAt > now),
  };
  const requestUpdate = () => {
    next.update = {
      ...next.update,
      requestedSequence: Math.max(sequence, next.update.requestedSequence),
      status:
        next.update.status === "waiting" || next.update.status === "running"
          ? next.update.status
          : "pending",
      error: null,
    };
  };
  if (isContentEdit(mutation)) {
    next = {
      ...applyContent(next, mutation, now, "user").state,
      status: "active",
      contentRevision: next.contentRevision + 1,
    };
    if (mutation.kind !== "pitch.save") requestUpdate();
    return validateNotebook(next);
  }
  switch (mutation.kind) {
    case "edit.begin":
      next.editLeases = [
        ...next.editLeases.filter((lease) => lease.leaseId !== mutation.leaseId),
        {
          resource: mutation.resource,
          leaseId: mutation.leaseId,
          expiresAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { seconds: 90 })),
        },
      ];
      break;
    case "edit.end":
      next.editLeases = next.editLeases.filter((lease) => lease.leaseId !== mutation.leaseId);
      break;
    case "artifact.delete":
      next.artifacts = state.artifacts.filter((artifact) => artifact.id !== mutation.id);
      next.contentRevision++;
      next.status = "active";
      requestUpdate();
      break;
    case "artifact.register":
      next.artifacts = [
        ...state.artifacts.filter((artifact) => artifact.id !== mutation.artifact.id),
        mutation.artifact,
      ];
      next.contentRevision++;
      next.status = "active";
      requestUpdate();
      break;
    case "update.request":
      next.update = {
        ...next.update,
        requestedSequence: Math.max(next.update.requestedSequence, mutation.sequence),
        status: next.update.status === "running" ? "running" : "pending",
        error: null,
      };
      break;
    case "update.retry":
      requestUpdate();
      break;
    case "update.start":
      if (state.update.status === "current" || state.update.status === "waiting")
        throw new IdeaConflict("This notebook has no completed pending inputs.");
      next.update = { ...next.update, status: "running", runId: mutation.runId, error: null };
      break;
    case "update.apply": {
      if (state.update.runId !== mutation.runId || state.update.status !== "running")
        throw new IdeaConflict("This notebook update is no longer current.");
      if (
        mutation.throughSequence < state.update.processedSequence ||
        mutation.throughSequence > state.update.requestedSequence
      )
        throw new IdeaConflict("Invalid notebook input cursor.");
      const inverse: IdeaContentEdit[] = [];
      const conflicts: IdeaContentEdit[] = [];
      const ordered = [
        ...mutation.edits.filter((edit) => edit.kind === "category.save"),
        ...mutation.edits.filter(
          (edit) => edit.kind !== "pitch.save" && edit.kind !== "category.save",
        ),
        ...mutation.edits.filter((edit) => edit.kind === "pitch.save"),
      ];
      for (const edit of ordered) {
        try {
          if (
            edit.kind === "pitch.save" &&
            linkedEntries(edit.markdown).some((id) => {
              const target = next.aliases.find((alias) => alias.from === id)?.to ?? id;
              return conflicts.some(
                (conflict) =>
                  conflict.kind.startsWith("entry.") &&
                  "id" in conflict &&
                  (conflict.id === target ||
                    (conflict.kind === "entry.merge" && conflict.targetId === target)),
              );
            })
          )
            throw new IdeaConflict("Review the referenced entry update before changing its pitch.");
          const result = applyContent(next, edit, now, "updater");
          if (result.state !== next) {
            next = result.state;
            inverse.unshift(...result.inverse);
            next.contentRevision++;
            next.updatedAt = now;
          }
        } catch (error) {
          if (!(error instanceof IdeaConflict)) throw error;
          conflicts.push(edit);
        }
      }
      if (conflicts.length)
        next.proposals = [
          ...next.proposals,
          {
            id: mutation.runId,
            runId: mutation.runId,
            edits: conflicts,
            reason: "Saved edits or an open editor changed this content.",
            createdAt: now,
          },
        ];
      if (inverse.length)
        next.history = [
          ...next.history,
          { id: mutation.runId, createdAt: now, summary: mutation.summary, inverse, undone: false },
        ].slice(-100);
      next.update = {
        ...next.update,
        processedSequence: mutation.throughSequence,
        status: next.update.requestedSequence > mutation.throughSequence ? "pending" : "current",
        runId: null,
        error: null,
      };
      break;
    }
    case "update.fail":
      if (state.update.status !== "running" || state.update.runId !== mutation.runId)
        throw new IdeaConflict("This notebook update is no longer current.");
      next.update = { ...state.update, status: "failed", runId: null, error: mutation.error };
      break;
    case "proposal.reject":
      next.proposals = state.proposals.filter((proposal) => proposal.id !== mutation.id);
      break;
    case "proposal.accept": {
      expectRevision(state.contentRevision, mutation.reviewedContentRevision);
      const proposal = state.proposals.find((item) => item.id === mutation.id);
      if (!proposal) throw new IdeaConflict("This proposal no longer exists.");
      for (const edit of proposal.edits)
        next = applyContent(next, rebaseEdit(next, edit), now, "user").state;
      next.proposals = next.proposals.filter((item) => item.id !== mutation.id);
      next.contentRevision++;
      next.status = "active";
      requestUpdate();
      break;
    }
    case "update.undo": {
      const history = state.history.find((item) => item.id === mutation.id && !item.undone);
      if (!history)
        throw new IdeaConflict("This update has already been undone or is no longer available.");
      let restored = next;
      try {
        for (const edit of history.inverse)
          restored = applyContent(restored, edit, now, "user").state;
        next = restored;
        next.contentRevision++;
        next.status = "active";
        requestUpdate();
      } catch (error) {
        if (!(error instanceof IdeaConflict)) throw error;
        next.proposals = [
          ...next.proposals,
          {
            id: `undo:${mutation.id}`,
            runId: mutation.id,
            edits: history.inverse,
            reason: "Newer edits need review before undoing this update.",
            createdAt: now,
          },
        ];
      }
      next.history = next.history.map((item) =>
        item.id === mutation.id ? { ...item, undone: true } : item,
      );
      break;
    }
    case "promotion.propose":
      if (mutation.promotion.sourceRevision !== state.contentRevision)
        throw new IdeaConflict("The idea changed while its issues were being prepared.");
      if (state.update.status !== "current")
        throw new IdeaConflict("Catch the notebook up before preparing issues.");
      if (state.promotion)
        next.promotionHistory = [
          ...state.promotionHistory.filter((item) => item.id !== state.promotion!.id),
          state.promotion,
        ];
      next.promotion = { ...mutation.promotion, status: "review", issues: [] };
      break;
    case "promotion.approve":
      if (
        !state.promotion ||
        state.promotion.id !== mutation.id ||
        state.promotion.status !== "review" ||
        mutation.sourceRevision !== state.contentRevision ||
        state.promotion.sourceRevision !== mutation.sourceRevision
      )
        throw new IdeaConflict("The idea changed. Review an updated issue plan before publishing.");
      next.promotion = { ...state.promotion, status: "approved" };
      break;
    case "promotion.retry":
      if (
        !state.promotion ||
        state.promotion.id !== mutation.id ||
        !["partial", "failed"].includes(state.promotion.status) ||
        mutation.sourceRevision !== state.contentRevision ||
        state.promotion.sourceRevision !== mutation.sourceRevision ||
        state.update.status !== "current"
      )
        throw new IdeaConflict("The idea changed. Review an updated issue plan before publishing.");
      next.promotion = { ...state.promotion, status: "approved", error: null };
      break;
    case "idea.settle":
      expectRevision(state.contentRevision, mutation.reviewedContentRevision);
      if (
        state.update.status !== "current" ||
        state.promotion?.status === "publishing" ||
        state.promotion?.status === "approved"
      )
        throw new IdeaConflict(
          "Wait for the current notebook update or publication before settling this idea.",
        );
      next.status = "settled";
      break;
    case "idea.reopen":
      expectRevision(state.contentRevision, mutation.reviewedContentRevision);
      next.status = "active";
      break;
    case "promotion.reject":
      if (state.promotion?.id === mutation.id && state.promotion.status === "review")
        next.promotion = null;
      break;
    case "promotion.record":
      if (
        !state.promotion ||
        state.promotion.id !== mutation.promotion.id ||
        !["approved", "publishing", "partial", "failed"].includes(state.promotion.status)
      )
        throw new IdeaConflict("This publication was not approved.");
      next.promotion = mutation.promotion;
      if (mutation.promotion.issues.length)
        next.promotionHistory = [
          ...state.promotionHistory.filter((item) => item.id !== mutation.promotion.id),
          mutation.promotion,
        ];
      if (
        mutation.promotion.status === "complete" &&
        mutation.promotion.remainingScope.trim() === "" &&
        mutation.promotion.drafts.every((draft) =>
          mutation.promotion.issues.some((issue) => issue.draftId === draft.id),
        ) &&
        mutation.promotion.sourceRevision === state.contentRevision
      )
        next.status = "settled";
      break;
    case "delete.request":
      next.status = "deleting";
      next.deletionEpoch = Math.max(1, state.deletionEpoch);
      next.deletionError = null;
      next.editLeases = [];
      break;
    case "delete.fail":
      next.deletionError = mutation.error;
      break;
  }
  return validateNotebook(next);
}

function validateNotebook(next: IdeaNotebook): IdeaNotebook {
  if (
    next.entries.length > 500 ||
    next.categories.length > 100 ||
    next.proposals.length > 100 ||
    encodeNotebook(next).length > 10_000_000
  )
    throw new IdeaConflict(
      "The notebook is too large. Merge or remove older entries before adding more.",
    );
  return next;
}
