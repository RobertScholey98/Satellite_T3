export function ideaDocumentHtml(document: string): string {
  const escaped = document
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; frame-src about:; connect-src 'none'; form-action 'none'; base-uri 'none';"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style></head><body><iframe sandbox="allow-scripts" srcdoc="${escaped}"></iframe></body></html>`;
}
