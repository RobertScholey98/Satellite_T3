import type { DocumentAnswer, DocumentDetail, DocumentSubmission } from "@t3tools/contracts";
import { documentAnswersMarkdown, initialDocumentAnswers } from "@t3tools/client-runtime/documents";

export type DocumentDraft = {
  readonly answers: readonly DocumentAnswer[];
  readonly answerVersion: number;
  readonly operation?: {
    readonly kind: "save" | "submit";
    readonly fingerprint: string;
    readonly requestId: string;
  };
};

function answerFingerprint(answers: readonly DocumentAnswer[]): string {
  return JSON.stringify(
    [...answers].sort((left, right) => left.itemId.localeCompare(right.itemId)),
  );
}

export function documentDraftHasChanges(draft: DocumentDraft, detail: DocumentDetail): boolean {
  return (
    draft.operation !== undefined ||
    answerFingerprint(draft.answers) !== answerFingerprint(initialDocumentAnswers(detail))
  );
}

export function documentMarkdownExport(
  detail: DocumentDetail,
  answers: readonly DocumentAnswer[],
): string {
  return detail.revision.definition === null && detail.revision.format !== "html"
    ? detail.content
    : documentAnswersMarkdown(detail, answers);
}

/** Keep an ambiguous operation's ID with its draft, including across revision switches. */
export function prepareDocumentOperation(
  draft: DocumentDraft,
  kind: "save" | "submit",
  newRequestId: () => string,
): DocumentDraft & { operation: NonNullable<DocumentDraft["operation"]> } {
  const fingerprint = JSON.stringify([kind, draft.answerVersion, answerFingerprint(draft.answers)]);
  return {
    ...draft,
    operation:
      draft.operation?.fingerprint === fingerprint
        ? draft.operation
        : { kind, fingerprint, requestId: newRequestId() },
  };
}

/** A fresh read may acknowledge a lost response, but never replaces divergent local answers. */
export function documentOperationAcknowledged(
  draft: DocumentDraft,
  saved: Pick<DocumentDetail, "answers" | "answerVersion"> & {
    readonly lastSubmission: Pick<DocumentSubmission, "answers"> | null;
  },
  kind: "save" | "submit",
): boolean {
  if (kind === "submit")
    return (
      saved.lastSubmission !== null &&
      answerFingerprint(saved.lastSubmission.answers) === answerFingerprint(draft.answers)
    );
  return (
    saved.answerVersion > draft.answerVersion &&
    answerFingerprint(saved.answers) === answerFingerprint(draft.answers)
  );
}
