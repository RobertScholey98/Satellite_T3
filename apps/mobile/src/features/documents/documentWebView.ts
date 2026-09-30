/** Snapshots have no server credentials or network access. Only checklist HTML gets a draft bridge. */
export function documentWebViewHtml(content: string, interactive: boolean): string {
  const bridge = interactive
    ? `<script>window.postMessage=function(value){window.ReactNativeWebView.postMessage(JSON.stringify(value));};</script>`
    : "";
  return documentPreviewHtml(
    `<meta name="viewport" content="width=device-width,initial-scale=1">${bridge}${content}`,
  );
}

export function documentWebViewResponse(value: unknown): string {
  const serialized = JSON.stringify(value).replaceAll("<", "\\u003c");
  return `window.dispatchEvent(new MessageEvent('message',{data:${serialized}}));true;`;
}

export function isDocumentSnapshotNavigation(url: string): boolean {
  return url === "about:blank" || url.startsWith("about:blank#");
}
import { documentPreviewHtml } from "@t3tools/client-runtime/documents";
