import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type DocumentDetail } from "@t3tools/contracts";
import {
  documentDraftHasChanges,
  documentMarkdownExport,
  documentOperationAcknowledged,
  prepareDocumentOperation,
} from "./documentDraft";

const answers = [{ itemId: "check", outcome: "broken" as const, notes: "Keep this note" }];
const detail: DocumentDetail = {
  document: {
    id: "doc",
    threadId: ThreadId.make("thread"),
    title: "Plan",
    kind: "plan",
    currentRevisionId: "revision",
    revisionNumber: 1,
    status: "draft",
    updatedAt: "2026-09-30T00:00:00Z",
  },
  revision: {
    id: "revision",
    documentId: "doc",
    number: 1,
    format: "markdown",
    contentHash: "hash",
    createdAt: "2026-09-30T00:00:00Z",
    definition: null,
  },
  content: "# Plan\n\nKeep source formatting, notes, and links.\n",
  answers: [],
  answerVersion: 0,
  lastSubmission: null,
};
describe("mobile document drafts", () => {
  it("exports ordinary Markdown and text plans with their full source body", () => {
    expect(documentMarkdownExport(detail, [])).toBe(detail.content);
    expect(
      documentMarkdownExport({ ...detail, revision: { ...detail.revision, format: "text" } }, []),
    ).toBe(detail.content);
  });

  it("recognizes clean initialized answers while retaining edited or ambiguous local drafts on fresh reads", () => {
    const review = {
      ...detail,
      revision: { ...detail.revision, definition: { items: [{ id: "check", title: "Check" }] } },
    };
    const clean = {
      answers: [{ itemId: "check", outcome: "pending" as const, notes: "" }],
      answerVersion: 0,
    };
    expect(documentDraftHasChanges(clean, review)).toBe(false);
    expect(documentDraftHasChanges({ ...clean, answers }, review)).toBe(true);
    expect(
      documentDraftHasChanges(
        prepareDocumentOperation(clean, "save", () => "ambiguous"),
        review,
      ),
    ).toBe(true);
    expect(
      documentDraftHasChanges(
        { ...clean, answers },
        { ...review, answers: [{ ...answers[0]!, notes: "Other device" }], answerVersion: 1 },
      ),
    ).toBe(true);
  });
  it("retains the same operation ID after a missing acknowledgement and revision remount", () => {
    const draft = prepareDocumentOperation({ answers, answerVersion: 2 }, "submit", () => "first");
    const restored = JSON.parse(JSON.stringify(draft));
    expect(
      prepareDocumentOperation(restored, "submit", () => "duplicate").operation.requestId,
    ).toBe("first");
    expect(
      prepareDocumentOperation(
        { ...draft, answers: [{ ...answers[0]!, notes: "Edited" }] },
        "submit",
        () => "edited",
      ).operation.requestId,
    ).toBe("edited");
  });

  it("reconciles an acknowledged save without accepting or overwriting a conflicting remote draft", () => {
    const draft = { answers, answerVersion: 2 };
    const saved = { answers, answerVersion: 3, lastSubmission: null };
    expect(documentOperationAcknowledged(draft, saved, "save")).toBe(true);
    expect(
      documentOperationAcknowledged(
        draft,
        { ...saved, answers: [{ ...answers[0]!, notes: "Other device" }] },
        "save",
      ),
    ).toBe(false);
    expect(documentOperationAcknowledged(draft, { ...saved, answerVersion: 2 }, "save")).toBe(
      false,
    );
    expect(draft).toEqual({ answers, answerVersion: 2 });
  });

  it("only recognizes a frozen submission with the retained local answers", () => {
    const saved = { answers, answerVersion: 3, lastSubmission: { answers } };
    expect(documentOperationAcknowledged({ answers, answerVersion: 2 }, saved, "submit")).toBe(
      true,
    );
    expect(documentOperationAcknowledged({ answers: [], answerVersion: 2 }, saved, "submit")).toBe(
      false,
    );
  });
});
