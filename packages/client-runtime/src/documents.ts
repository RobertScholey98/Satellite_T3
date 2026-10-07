import {
  DocumentAnswers,
  WS_METHODS,
  type DocumentAnswer,
  type DocumentDetail,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "./connection/registry.ts";
import { createEnvironmentRpcCommand } from "./state/runtime.ts";

export const DOCUMENT_BRIDGE_PROTOCOL = "t3-document-v1" as const;
export const DOCUMENT_HTML_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";

/** The host policy precedes every retained page script, including pages without a head. */
export function documentPreviewHtml(content: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${DOCUMENT_HTML_CSP}">${content.replace(/^\s*<!doctype[^>]*>/i, "")}`;
}
export interface DocumentBridgeBinding {
  readonly sessionId: string;
  readonly documentId: string;
  readonly revisionId: string;
}
const DocumentBridgeRequest = Schema.Struct({
  protocol: Schema.Literal(DOCUMENT_BRIDGE_PROTOCOL),
  type: Schema.Literal("request"),
  sessionId: Schema.String,
  documentId: Schema.String,
  revisionId: Schema.String,
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  method: Schema.Literals(["load", "saveDraft"]),
  expectedAnswerRevision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  result: Schema.optional(Schema.Struct({ answers: DocumentAnswers })),
});
const isBridgeRequest = Schema.is(DocumentBridgeRequest);
const isBridgeReady = Schema.is(
  Schema.Struct({
    protocol: Schema.Literal(DOCUMENT_BRIDGE_PROTOCOL),
    type: Schema.Literal("ready"),
  }),
);

/** Call only after verifying the sending frame/WebView is the bound document source. */
export function parseDocumentBridgeRequest(value: unknown, binding: DocumentBridgeBinding) {
  if (isBridgeReady(value)) return { type: "ready" } as const;
  if (!isBridgeRequest(value)) return null;
  if (
    value.sessionId !== binding.sessionId ||
    value.documentId !== binding.documentId ||
    value.revisionId !== binding.revisionId
  )
    return null;
  if (value.method === "saveDraft" && (!value.result || value.expectedAnswerRevision === undefined))
    return null;
  return value;
}

export function documentBridgeInit(binding: DocumentBridgeBinding, detail: DocumentDetail) {
  return {
    ...binding,
    protocol: DOCUMENT_BRIDGE_PROTOCOL,
    type: "init" as const,
    readOnly: isDocumentRevisionReadOnly(detail),
    expectedAnswerRevision: detail.answerVersion,
    result: { answers: detail.answers },
    definition: detail.revision.definition,
  };
}

export function isDocumentRevisionReadOnly(detail: DocumentDetail): boolean {
  return (
    detail.revision.id !== detail.document.currentRevisionId ||
    detail.document.status === "submitted" ||
    detail.lastSubmission !== null
  );
}

export function documentBridgeResponse(
  binding: DocumentBridgeBinding,
  requestId: string,
  response: {
    readonly ok: boolean;
    readonly result?: { readonly answers: readonly DocumentAnswer[] };
    readonly expectedAnswerRevision?: number;
    readonly readOnly?: boolean;
    readonly error?: string;
  },
) {
  return {
    ...binding,
    protocol: DOCUMENT_BRIDGE_PROTOCOL,
    type: "response" as const,
    requestId,
    ...response,
  };
}

export function initialDocumentAnswers(detail: DocumentDetail): DocumentAnswer[] {
  return (detail.revision.definition?.items ?? []).map(
    (item) =>
      detail.answers.find((answer) => answer.itemId === item.id) ?? {
        itemId: item.id,
        outcome: "pending",
        notes: "",
      },
  );
}

/** Stable IDs keep retained revision answers independent from later checklist changes. */
export function validateDocumentAnswers(
  detail: DocumentDetail,
  answers: readonly DocumentAnswer[],
): string | null {
  const known = new Set(detail.revision.definition?.items.map((item) => item.id) ?? []);
  const seen = new Set<string>();
  for (const answer of answers) {
    if (!known.has(answer.itemId)) return `Unknown checklist item: ${answer.itemId}`;
    if (seen.has(answer.itemId)) return `Duplicate checklist item: ${answer.itemId}`;
    seen.add(answer.itemId);
  }
  return null;
}

export function documentAnswersMarkdown(
  detail: DocumentDetail,
  answers: readonly DocumentAnswer[],
): string {
  const items = detail.revision.definition?.items ?? [];
  return [
    `# ${detail.document.title}`,
    `Revision ${detail.revision.number}`,
    "",
    ...answers.flatMap((answer) => {
      const title = items.find((item) => item.id === answer.itemId)?.title ?? answer.itemId;
      return [
        `- [${answer.outcome === "complete" ? "x" : " "}] ${title} — ${answer.outcome.replaceAll("_", " ")}`,
        ...(answer.notes ? [`  ${answer.notes.replaceAll("\n", "\n  ")}`] : []),
      ];
    }),
  ].join("\n");
}

export function createDocumentsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcCommand(runtime, {
      label: "documents:list",
      tag: WS_METHODS.documentsList,
    }),
    get: createEnvironmentRpcCommand(runtime, {
      label: "documents:get",
      tag: WS_METHODS.documentsGet,
    }),
    history: createEnvironmentRpcCommand(runtime, {
      label: "documents:history",
      tag: WS_METHODS.documentsHistory,
    }),
    saveDraft: createEnvironmentRpcCommand(runtime, {
      label: "documents:save-draft",
      tag: WS_METHODS.documentsSaveDraft,
    }),
    submit: createEnvironmentRpcCommand(runtime, {
      label: "documents:submit",
      tag: WS_METHODS.documentsSubmit,
    }),
    retry: createEnvironmentRpcCommand(runtime, {
      label: "documents:retry",
      tag: WS_METHODS.documentsRetry,
    }),
  };
}
