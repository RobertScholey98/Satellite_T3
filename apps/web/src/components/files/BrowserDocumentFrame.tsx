import type { Ref } from "react";

/**
 * Chromium's viewer opens with its own toolbar, a thumbnail rail and a small
 * zoom. The panel header is the only chrome we want, so ask for the page
 * alone, fitted to the panel width. Pinch and keyboard zoom, scrolling, text
 * selection and find still work inside the frame.
 */
const PDF_VIEWER_FRAGMENT = "#toolbar=0&view=FitH";

export const isPdfPreviewFile = (path: string): boolean =>
  /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");

/**
 * Renders an HTML or PDF document from its URL. HTML runs in a sandboxed frame
 * with an opaque origin, so a page cannot reach the app's session or storage.
 * The built-in PDF viewer needs an unsandboxed frame; a PDF runs no scripts.
 */
export function BrowserDocumentFrame({
  src,
  title,
  pdf,
  srcDoc,
  frameRef,
  onLoad,
  restricted = false,
}: {
  readonly src: string;
  readonly title: string;
  readonly pdf: boolean;
  readonly srcDoc?: string;
  readonly frameRef?: Ref<HTMLIFrameElement>;
  readonly onLoad?: () => void;
  readonly restricted?: boolean;
}) {
  const className = "min-h-0 flex-1 border-0 bg-white";
  return pdf ? (
    // oxlint-disable-next-line react/iframe-missing-sandbox
    <iframe key={src} src={`${src}${PDF_VIEWER_FRAGMENT}`} title={title} className={className} />
  ) : (
    <iframe
      key={src}
      ref={frameRef}
      src={src}
      srcDoc={srcDoc}
      onLoad={onLoad}
      title={title}
      className={className}
      sandbox={
        restricted
          ? "allow-scripts allow-modals allow-downloads"
          : "allow-scripts allow-forms allow-popups allow-modals"
      }
    />
  );
}
