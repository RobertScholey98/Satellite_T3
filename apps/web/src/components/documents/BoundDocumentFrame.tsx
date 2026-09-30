import type { DocumentDetail } from "@t3tools/contracts";
import {
  documentBridgeInit,
  documentBridgeResponse,
  documentPreviewHtml,
  isDocumentRevisionReadOnly,
  parseDocumentBridgeRequest,
  validateDocumentAnswers,
} from "@t3tools/client-runtime/documents";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { randomUUID } from "~/lib/utils";
import { BrowserDocumentFrame } from "../files/BrowserDocumentFrame";

export function BoundDocumentFrame({
  detail,
  dirty,
  saveDraft,
  loadDraft,
}: {
  readonly detail: DocumentDetail;
  readonly dirty: boolean;
  readonly saveDraft: (
    answers: DocumentDetail["answers"],
    expectedAnswerVersion: number,
    requestId: string,
  ) => Promise<DocumentDetail>;
  readonly loadDraft: () => Promise<DocumentDetail>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ detail, dirty, saveDraft, loadDraft });
  useLayoutEffect(() => {
    latest.current = { detail, dirty, saveDraft, loadDraft };
  }, [detail, dirty, saveDraft, loadDraft]);
  const binding = useMemo(
    () => ({
      sessionId: randomUUID(),
      documentId: detail.document.id,
      revisionId: detail.revision.id,
    }),
    [detail.document.id, detail.revision.id],
  );
  const initialize = () =>
    frame.current?.contentWindow?.postMessage(documentBridgeInit(binding, detail), "*");
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(documentBridgeInit(binding, detail), "*");
  }, [binding, detail]);
  useEffect(() => {
    const receive = async (event: MessageEvent<unknown>) => {
      const source = frame.current?.contentWindow;
      if (!source || event.source !== source) return;
      const request = parseDocumentBridgeRequest(event.data, binding);
      if (!request) return;
      const send = (response: Parameters<typeof documentBridgeResponse>[2]) =>
        source.postMessage(
          documentBridgeResponse(
            binding,
            request.type === "request" ? request.requestId : "",
            response,
          ),
          "*",
        );
      if (request.type === "ready") {
        source.postMessage(documentBridgeInit(binding, latest.current.detail), "*");
        return;
      }
      if (request.method === "load") {
        try {
          const current = await latest.current.loadDraft();
          send({
            ok: true,
            result: { answers: current.answers },
            expectedAnswerRevision: current.answerVersion,
            readOnly: isDocumentRevisionReadOnly(current),
          });
        } catch (error) {
          send({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      try {
        const current = latest.current;
        if (isDocumentRevisionReadOnly(current.detail))
          throw new Error("Submitted and historical revisions are read-only.");
        if (current.dirty)
          throw new Error(
            "The host review has unsaved changes. Save the host draft before saving from this page.",
          );
        if (!request.result || request.expectedAnswerRevision === undefined) return;
        const validation = validateDocumentAnswers(current.detail, request.result.answers);
        if (validation) throw new Error(validation);
        const saved = await current.saveDraft(
          request.result.answers,
          request.expectedAnswerRevision,
          request.requestId,
        );
        send({
          ok: true,
          result: { answers: saved.answers },
          expectedAnswerRevision: saved.answerVersion,
          readOnly: isDocumentRevisionReadOnly(saved),
        });
      } catch (error) {
        send({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    };
    const listener = (event: MessageEvent<unknown>) => {
      void receive(event);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [binding]);
  return (
    <BrowserDocumentFrame
      src={`about:blank#${detail.revision.id}`}
      srcDoc={documentPreviewHtml(detail.content)}
      title={detail.document.title}
      pdf={false}
      frameRef={frame}
      onLoad={initialize}
      restricted
    />
  );
}
