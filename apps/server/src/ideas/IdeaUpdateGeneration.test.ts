import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  IdeaArtifactId,
  IdeaCategoryId,
  IdeaEntryId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { createIdeaNotebook } from "./IdeaNotebook.ts";
import {
  boundIdeaUpdateContext,
  IdeaUpdateGenerationResult,
  normalizeIdeaUpdateResult,
  validateIdeaUpdateProjection,
  validateIdeaUpdateSources,
  validateIdeaUpdateCoverage,
} from "./IdeaUpdateGeneration.ts";
import { constrainClaudeIdeaOptions } from "./ClaudeIdeaPolicy.ts";
import { validateIdeaIssueDrafts } from "./IdeaPromotion.ts";

const decodeIdeaUpdateGenerationResult = Schema.decodeSync(IdeaUpdateGenerationResult);
const blank = () => createIdeaNotebook(ThreadId.make("test-idea"), "2026-09-30T00:00:00.000Z");
const note = {
  kind: "entry.save" as const,
  id: IdeaEntryId.make("new-id"),
  baseRevision: 0,
  categoryId: IdeaCategoryId.make("notes"),
  title: "Flow",
  markdown: "Saved content",
  sources: [{ kind: "message" as const, messageId: MessageId.make("old") }],
};

describe("idea update boundaries", () => {
  it.each([undefined, null])("normalizes updates without a title: %s", (title) => {
    const result = normalizeIdeaUpdateResult(
      decodeIdeaUpdateGenerationResult({
        edits: [note],
        summary: "Saved a note.",
        ...(title === undefined ? {} : { title }),
      }),
    );
    expect(result).toEqual({
      edits: [{ ...note, restore: false }],
      summary: "Saved a note.",
    });
  });

  it("preserves explicit restore requests for rejection by the update validator", () => {
    const result = normalizeIdeaUpdateResult(
      decodeIdeaUpdateGenerationResult({
        edits: [{ ...note, restore: true }],
        summary: "Restore a note.",
        title: "Idea workflow",
      }),
    );
    expect(result.title).toBe("Idea workflow");
    expect(validateIdeaUpdateSources(blank(), result.edits, new Map([["message:old", 1]]))).toBe(
      "Automatic updates cannot restore a deleted note.",
    );
  });

  it("keeps a new design study complete when an older study already filled the document budget", () => {
    const notebook = { ...blank(), update: { ...blank().update, processedSequence: 4 } };
    const context = boundIdeaUpdateContext(
      notebook,
      [],
      [
        { id: "previous", name: "Previous study", text: "old".repeat(50_000), sequence: 2 },
        { id: "new", name: "Current study", text: "new".repeat(34_000), sequence: 5 },
      ],
    );
    expect(context.documents.find((document) => document.id === "new")?.text).toHaveLength(102_000);
    expect(context.documents.find((document) => document.id === "new")?.truncated).toBe(false);
    expect(context.documents.find((document) => document.id === "previous")?.truncated).toBe(true);
    expect(
      validateIdeaUpdateCoverage(
        notebook,
        [],
        context,
        new Map([
          ["artifact:previous", 2],
          ["artifact:new", 5],
        ]),
      ),
    ).toBeNull();
  });
  it("refuses to advance over omitted new messages and truncated new documents", () => {
    const notebook = blank();
    const messages = Array.from({ length: 7 }, (_, index) => ({
      id: "m" + index,
      sequence: index + 1,
      role: "user",
      text: "x".repeat(20_000),
    }));
    const context = boundIdeaUpdateContext(notebook, messages, []);
    expect(validateIdeaUpdateCoverage(notebook, messages, context, new Map())).toContain(
      "remains behind",
    );
    expect(
      validateIdeaUpdateCoverage(
        { ...notebook, update: { ...notebook.update, processedSequence: 5 } },
        messages,
        context,
        new Map(),
      ),
    ).toBeNull();
    const documents = boundIdeaUpdateContext(
      notebook,
      [],
      [{ id: "document", name: "Long document", text: "x".repeat(250_000) }],
    );
    expect(
      validateIdeaUpdateCoverage(notebook, [], documents, new Map([["artifact:document", 3]])),
    ).toContain("unread content");
  });
  it("rejects deleted notes recreated with a new identity from old evidence", () => {
    const notebook = {
      ...blank(),
      deletedEntries: [{ id: IdeaEntryId.make("deleted-id"), throughSequence: 8 }],
    };
    expect(validateIdeaUpdateSources(notebook, [note], new Map([["message:old", 7]]))).toContain(
      "newer",
    );
    expect(
      validateIdeaUpdateSources(
        notebook,
        [{ ...note, sources: [{ kind: "message", messageId: MessageId.make("new") }] }],
        new Map([["message:new", 9]]),
      ),
    ).toBeNull();
  });
  it("rejects citations to a removed attachment even when its registration event survives", () => {
    expect(
      validateIdeaUpdateSources(
        blank(),
        [{ ...note, sources: [{ kind: "artifact", artifactId: IdeaArtifactId.make("removed") }] }],
        new Map([["artifact:removed", 12]]),
      ),
    ).toContain("outside");
  });
  it("bounds total excerpts and refuses destructive edits to truncated notes", () => {
    const notebook = {
      ...blank(),
      pitch: { ...blank().pitch, markdown: "x".repeat(100_000) },
      entries: Array.from({ length: 50 }, (_, index) => ({
        id: IdeaEntryId.make("entry-" + index),
        title: "Long note",
        categoryId: IdeaCategoryId.make("notes"),
        document: { ...blank().pitch, markdown: "x".repeat(50_000) },
        sources: [],
      })),
    };
    const context = boundIdeaUpdateContext(
      notebook,
      Array.from({ length: 100 }, (_, index) => ({
        id: "message-" + index,
        sequence: index,
        role: "user",
        text: "x".repeat(50_000),
      })),
      Array.from({ length: 30 }, (_, index) => ({
        id: "doc-" + index,
        name: "Document",
        text: "x".repeat(50_000),
      })),
    );
    expect(
      context.discussion.reduce((sum, message) => sum + message.text.length, 0),
    ).toBeLessThanOrEqual(100_000);
    expect(
      context.documents.reduce((sum, document) => sum + document.text.length, 0),
    ).toBeLessThanOrEqual(125_000);
    expect(
      validateIdeaUpdateProjection(
        [{ kind: "entry.delete", id: IdeaEntryId.make("entry-0"), baseRevision: 0 }],
        context,
      ),
    ).toContain("preserved");
    expect(
      validateIdeaUpdateProjection(
        [{ kind: "pitch.save", markdown: "Replacement", baseRevision: 0 }],
        context,
      ),
    ).toContain("Shorten");
  });
  it("removes configured execution paths from the Claude idea policy", () => {
    const options = constrainClaudeIdeaOptions({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      resume: "native-session",
      agent: "writer",
      agents: {},
      tools: ["Bash", "Write"],
      additionalDirectories: ["/project"],
      settingSources: ["user", "project"],
      extraArgs: { "dangerously-skip-permissions": null },
      hooks: {},
      persistSession: true,
    });
    expect(options.tools).toEqual(["AskUserQuestion"]);
    expect(options.resume).toBeUndefined();
    expect(options.agent).toBeUndefined();
    expect(options.additionalDirectories).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.extraArgs).toEqual({ bare: null, "disable-slash-commands": null });
    expect(options.persistSession).toBe(false);
    expect(options.allowDangerouslySkipPermissions).toBe(false);
  });
  it("refuses issue drafts that depend on local idea artifacts", () => {
    expect(
      validateIdeaIssueDrafts([
        { id: "one", title: "Implement", body: "See [flow](idea-entry:creation)", labels: [] },
      ]),
    ).toContain("cannot depend");
    expect(
      validateIdeaIssueDrafts([
        {
          id: "one",
          title: "Implement",
          body: "Create an idea from the standard home composer. Acceptance: the project repository remains unchanged.",
          labels: [],
        },
      ]),
    ).toBeNull();
  });
});
