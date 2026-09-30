import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import {
  documentWebViewHtml,
  documentWebViewResponse,
  isDocumentSnapshotNavigation,
} from "./documentWebView";

describe("mobile document transport", () => {
  it("preserves bound result data as data rather than executable document content", () => {
    const message = {
      sessionId: "one",
      result: {
        answers: [{ notes: "</script>\"; throw new Error('unsafe'); //\n😀", outcome: "broken" }],
      },
    };
    const received: unknown[] = [];
    NodeVM.runInNewContext(documentWebViewResponse(message), {
      window: { dispatchEvent: (event: { data: unknown }) => received.push(event.data) },
      MessageEvent: class {
        constructor(
          _type: string,
          readonly options: { data: unknown },
        ) {}
        get data() {
          return this.options.data;
        }
      },
    });
    expect(received).toEqual([message]);
  });

  it("transports page draft requests through the native message channel", () => {
    const received: string[] = [];
    const script = documentWebViewHtml("<p>Review</p>", true).match(/<script>(.*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const window = {
      ReactNativeWebView: { postMessage: (value: string) => received.push(value) },
      postMessage: (_value: unknown, _targetOrigin?: string) => {},
    };
    NodeVM.runInNewContext(script!, { window });
    const request = { protocol: "t3-document-v1", method: "saveDraft", result: { answers: [] } };
    // This is the WebView native channel shim, not a browser cross-origin postMessage.
    window.postMessage(request, "*");
    expect(received.map((value) => JSON.parse(value))).toEqual([request]);
  });

  it("prevents snapshots from navigating into network, file, or executable origins", () => {
    for (const url of [
      "https://server.invalid/api",
      "http://localhost:3000",
      "file:///private",
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "about:blank.evil",
    ])
      expect(isDocumentSnapshotNavigation(url)).toBe(false);
    expect(isDocumentSnapshotNavigation("about:blank")).toBe(true);
    expect(isDocumentSnapshotNavigation("about:blank#section")).toBe(true);
  });
});
