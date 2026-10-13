import type { BrowserContext } from "playwright-core";

export const isRestrictedPreviewUrl = (url: string, origin: string) => {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
};

export async function restrictPreviewContext(context: BrowserContext, origin: string) {
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (!isRestrictedPreviewUrl(url, origin)) {
      await route.abort("blockedbyclient");
      return;
    }
    // Chromium follows a continued request's redirect chain without routing each hop.
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers().location;
    if (
      response.status() >= 300 &&
      response.status() < 400 &&
      location &&
      !isRestrictedPreviewUrl(new URL(location, url).href, origin)
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.fulfill({ response });
  });
  // The first qualified runtime has no websocket or service-worker dependency.
  await context.routeWebSocket("**/*", (socket) => socket.close());
}
