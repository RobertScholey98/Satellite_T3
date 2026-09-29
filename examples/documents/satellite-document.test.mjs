import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { createSatelliteDocumentClient } from "./satellite-document.js";

let host;
let messages;
let windowListeners;
let documentListeners;
let client;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const binding = { sessionId: "preview-1", documentId: "review-1", revisionId: "revision-2" };
const answers = [{ itemId: "hide", outcome: "broken", notes: "Pill disappeared" }];
const init = {
  ...binding,
  protocol: "t3-document-v1",
  type: "init",
  readOnly: false,
  expectedAnswerRevision: 7,
  result: { answers: [] },
};
NodeTest.beforeEach(() => {
  messages = [];
  host = { postMessage: (message) => messages.push(message) };
  windowListeners = new Set();
  documentListeners = new Set();
  globalThis.window = {
    parent: host,
    addEventListener: (_name, listener) => windowListeners.add(listener),
    removeEventListener: (_name, listener) => windowListeners.delete(listener),
  };
  globalThis.document = {
    addEventListener: (_name, listener) => documentListeners.add(listener),
    removeEventListener: (_name, listener) => documentListeners.delete(listener),
  };
});
NodeTest.afterEach(() => {
  client?.dispose();
  client = undefined;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});
const receive = (data, source = host) => {
  for (const listener of windowListeners) listener({ data, source });
};

NodeTest.test("standalone documents cannot save until a host binds their identity", async () => {
  client = createSatelliteDocumentClient();
  NodeAssert.deepEqual(messages, [{ protocol: "t3-document-v1", type: "ready" }]);
  await NodeAssert.rejects(client.saveDraft(answers), /Documents panel/);
  receive(init, { differentFrame: true });
  NodeAssert.equal(client.connected, false);
});

NodeTest.test(
  "saving uses the bound revision and acknowledges only the correlated server response",
  async () => {
    const states = [];
    client = createSatelliteDocumentClient({ onState: (state) => states.push(state) });
    receive(init);
    receive({ ...init, result: { answers } });
    NodeAssert.equal(states.length, 1, "a duplicate init must not replace a user's edits");
    const saved = client.saveDraft(answers, "save-1");
    const request = messages.at(-1);
    NodeAssert.deepEqual(request, {
      ...binding,
      protocol: "t3-document-v1",
      type: "request",
      requestId: "save-1",
      method: "saveDraft",
      expectedAnswerRevision: 7,
      result: { answers },
    });
    const response = {
      ...binding,
      protocol: "t3-document-v1",
      type: "response",
      requestId: "save-1",
      ok: true,
      expectedAnswerRevision: 8,
      result: { answers },
    };
    receive({ ...response, sessionId: "different-session" });
    NodeAssert.equal(client.answerRevision, 7);
    receive(response);
    await saved;
    NodeAssert.equal(client.answerRevision, 8);
    NodeAssert.deepEqual(states.at(-1).answers, answers);
  },
);

NodeTest.test(
  "a conflicting save preserves the previous state version for deliberate recovery",
  async () => {
    client = createSatelliteDocumentClient();
    receive(init);
    const saved = client.saveDraft(answers, "conflict-1");
    const rejected = NodeAssert.rejects(saved, /changed on another device/);
    receive({
      ...binding,
      protocol: "t3-document-v1",
      type: "response",
      requestId: "conflict-1",
      ok: false,
      error: "Answers changed on another device",
    });
    await rejected;
    NodeAssert.equal(client.answerRevision, 7);
  },
);

NodeTest.test("historical or submitted reviews reject edits", async () => {
  client = createSatelliteDocumentClient();
  receive({ ...init, readOnly: true });
  await NodeAssert.rejects(client.saveDraft(answers), /read-only/);
  NodeAssert.equal(messages.length, 1);
});

NodeTest.test("mobile WebView uses the same JSON contract", async () => {
  window.ReactNativeWebView = { postMessage: (message) => messages.push(JSON.parse(message)) };
  client = createSatelliteDocumentClient();
  for (const listener of documentListeners) listener({ data: JSON.stringify(init) });
  const loaded = client.load();
  const request = messages.at(-1);
  NodeAssert.equal(request.method, "load");
  for (const listener of documentListeners)
    listener({
      data: JSON.stringify({
        ...binding,
        protocol: "t3-document-v1",
        type: "response",
        requestId: request.requestId,
        ok: true,
        expectedAnswerRevision: 9,
        result: { answers },
      }),
    });
  await loaded;
  NodeAssert.equal(client.answerRevision, 9);
});
