/**
 * Embed this module in a self-contained document, or bundle it with your generator.
 * The host supplies identity and saved state. A page can load/save drafts; submission
 * is an explicit action in SatelliteT3's trusted document controls.
 */
export function createSatelliteDocumentClient({ onState, onConnection } = {}) {
  const protocol = "t3-document-v1";
  let binding = null;
  let answerRevision = 0;
  let readOnly = true;
  let sequence = 0;
  const pending = new Map();
  const mobile = Boolean(window.ReactNativeWebView);
  const send = (message) => {
    // Native WebView's one-argument bridge is not Window.postMessage.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    if (mobile) window.ReactNativeWebView.postMessage(JSON.stringify(message));
    else window.parent.postMessage(message, "*");
  };
  const update = (message) => {
    if (Number.isSafeInteger(message.expectedAnswerRevision)) {
      answerRevision = message.expectedAnswerRevision;
    }
    if (typeof message.readOnly === "boolean") readOnly = message.readOnly;
    if (message.result && Array.isArray(message.result.answers)) {
      onState?.({
        ...binding,
        answers: message.result.answers,
        answerRevision,
        readOnly,
        definition: message.definition,
      });
    }
  };
  const receive = (event) => {
    if (!mobile && event.source !== window.parent) return;
    let message;
    try {
      message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (!message || message.protocol !== protocol) return;
    if (message.type === "init") {
      if (
        ![message.sessionId, message.documentId, message.revisionId].every(
          (id) => typeof id === "string" && id.length > 0,
        )
      )
        return;
      // Duplicate ready/load acknowledgements must not erase edits in the document.
      if (binding) return;
      binding = {
        sessionId: message.sessionId,
        documentId: message.documentId,
        revisionId: message.revisionId,
      };
      update(message);
      onConnection?.(true);
      return;
    }
    if (
      !binding ||
      message.type !== "response" ||
      message.sessionId !== binding.sessionId ||
      message.documentId !== binding.documentId ||
      message.revisionId !== binding.revisionId
    )
      return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    clearTimeout(request.timer);
    if (!message.ok) {
      request.reject(new Error(message.error || "The document was not saved."));
      return;
    }
    update(message);
    request.resolve(message);
  };
  window.addEventListener("message", receive);
  // Android WebView may deliver messages to document rather than window.
  document.addEventListener("message", receive);
  send({ protocol, type: "ready" });

  const request = (method, answers, requestId) => {
    if (!binding)
      return Promise.reject(
        new Error("Open this document from SatelliteT3's Documents panel to save it."),
      );
    if (method === "saveDraft" && readOnly)
      return Promise.reject(new Error("This retained document is read-only."));
    const id = requestId ?? `${binding.sessionId}:${++sequence}`;
    if (pending.has(id)) return Promise.reject(new Error("This save is already pending."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            "Save acknowledgement unavailable. Keep your draft and check saved state before retrying.",
          ),
        );
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      send({
        ...binding,
        protocol,
        type: "request",
        requestId: id,
        method,
        ...(method === "saveDraft"
          ? { expectedAnswerRevision: answerRevision, result: { answers } }
          : {}),
      });
    });
  };
  return {
    get connected() {
      return binding !== null;
    },
    get readOnly() {
      return readOnly;
    },
    get answerRevision() {
      return answerRevision;
    },
    load: () => request("load"),
    saveDraft: (answers, requestId) => request("saveDraft", answers, requestId),
    dispose() {
      window.removeEventListener("message", receive);
      document.removeEventListener("message", receive);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Document closed."));
      }
      pending.clear();
    },
  };
}
