import { ThreadId, type DocumentDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  documentAnswersMarkdown,
  documentPreviewHtml,
  documentBridgeInit,
  initialDocumentAnswers,
  isDocumentRevisionReadOnly,
  parseDocumentBridgeRequest,
  validateDocumentAnswers,
} from "./documents.ts";

const binding = { sessionId: "session-1", documentId: "doc-1", revisionId: "revision-1" };
const detail = {
  document: {
    id: "doc-1",
    threadId: ThreadId.make("thread-1"),
    title: "Review",
    kind: "review",
    currentRevisionId: "revision-1",
    revisionNumber: 1,
    status: "draft",
    updatedAt: "2026-09-30",
  },
  revision: {
    id: "revision-1",
    documentId: "doc-1",
    number: 1,
    format: "html",
    contentHash: "hash",
    createdAt: "2026-09-30",
    definition: {
      items: [
        { id: "check-1", title: "Remote reconnect" },
        { id: "check-2", title: "Mobile review" },
      ],
    },
  },
  content: "<h1>Review</h1>",
  answers: [{ itemId: "check-1", outcome: "broken", notes: "Lost connection" }],
  answerVersion: 4,
  lastSubmission: null,
} satisfies DocumentDetail;
const request = {
  protocol: "t3-document-v1",
  type: "request",
  ...binding,
  requestId: "request-1",
  method: "saveDraft",
  expectedAnswerRevision: 4,
  result: { answers: detail.answers },
};
describe("bound document bridge", () => {
  it("places the host CSP before any retained script, including documents without a head", () => {
    const content = '<script>parent.postMessage({type:"ready"},"*")</script><h1>Review</h1>';
    const html = documentPreviewHtml(content);
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script>"));
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain(content);
  });
  it("accepts only a bound save with schema-valid answers and a comparison version", () => {
    expect(parseDocumentBridgeRequest(request, binding)).toEqual(request);
    expect(
      parseDocumentBridgeRequest({ ...request, expectedAnswerRevision: undefined }, binding),
    ).toBeNull();
    expect(
      parseDocumentBridgeRequest({ ...request, expectedAnswerRevision: -1 }, binding),
    ).toBeNull();
    expect(
      parseDocumentBridgeRequest(
        {
          ...request,
          result: { answers: [{ itemId: "check-1", outcome: "approved", notes: "" }] },
        },
        binding,
      ),
    ).toBeNull();
  });
  it("rejects messages from stale sessions and other documents or retained revisions", () => {
    for (const field of ["sessionId", "documentId", "revisionId"] as const) {
      expect(parseDocumentBridgeRequest({ ...request, [field]: "different" }, binding)).toBeNull();
    }
  });
  it("never exposes submission, approval, or turn creation as page methods", () => {
    for (const method of ["submit", "approve", "startTurn", "retryDelivery"]) {
      expect(parseDocumentBridgeRequest({ ...request, method }, binding)).toBeNull();
    }
  });
  it("allows a source-checked ready handshake and publishes the bound context", () => {
    expect(
      parseDocumentBridgeRequest({ protocol: "t3-document-v1", type: "ready" }, binding),
    ).toEqual({ type: "ready" });
    expect(documentBridgeInit(binding, detail)).toMatchObject({
      ...binding,
      expectedAnswerRevision: 4,
      readOnly: false,
      result: { answers: detail.answers },
    });
  });
  it("historical revisions are read-only even when they have never been submitted", () => {
    const historical = {
      ...detail,
      document: { ...detail.document, currentRevisionId: "revision-2" },
    };
    expect(isDocumentRevisionReadOnly(historical)).toBe(true);
    expect(documentBridgeInit(binding, historical).readOnly).toBe(true);
  });
  it("submitted revisions remain read-only", () => {
    expect(
      isDocumentRevisionReadOnly({
        ...detail,
        document: { ...detail.document, status: "submitted" },
      }),
    ).toBe(true);
  });
});
describe("review answers", () => {
  it("initializes missing answers as pending while retaining saved outcomes and notes", () => {
    expect(initialDocumentAnswers(detail)).toEqual([
      ...detail.answers,
      { itemId: "check-2", outcome: "pending", notes: "" },
    ]);
  });
  it("rejects duplicate answers and IDs outside the retained checklist", () => {
    expect(validateDocumentAnswers(detail, [...detail.answers, ...detail.answers])).toContain(
      "Duplicate",
    );
    expect(
      validateDocumentAnswers(detail, [{ itemId: "foreign", outcome: "complete", notes: "" }]),
    ).toContain("Unknown");
    expect(validateDocumentAnswers(detail, initialDocumentAnswers(detail))).toBeNull();
  });
  it("exports outcome and notes against the selected revision's item titles", () => {
    const markdown = documentAnswersMarkdown(detail, detail.answers);
    expect(markdown).toContain("Revision 1");
    expect(markdown).toContain("Remote reconnect — broken");
    expect(markdown).toContain("Lost connection");
  });
});
