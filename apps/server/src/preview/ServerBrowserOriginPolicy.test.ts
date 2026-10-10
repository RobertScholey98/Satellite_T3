import { describe, expect, it, vi } from "vite-plus/test";
import type { BrowserContext, Route, WebSocketRoute } from "playwright-core";
import { isRestrictedPreviewUrl, restrictPreviewContext } from "./ServerBrowserOriginPolicy.ts";

describe("restricted candidate browser origin", () => {
  it("allows only the exact approved HTTP origin", () => {
    const origin = "http://127.0.0.1:40123";
    expect(isRestrictedPreviewUrl(`${origin}/screen?q=1#state`, origin)).toBe(true);
    for (const url of [
      "http://127.0.0.1:40124/",
      "http://localhost:40123/",
      "https://127.0.0.1:40123/",
      "file:///C:/secret",
      "data:text/html,secret",
      "http://user:password@127.0.0.1:40123/",
      "http://127.0.0.1:40123.evil.test/",
    ])
      expect(isRestrictedPreviewUrl(url, origin)).toBe(false);
  });
  it("intercepts subresources before allowing network I/O and refuses websocket connections", async () => {
    let handler: ((route: Route) => Promise<void>) | undefined;
    let socketHandler: ((socket: WebSocketRoute) => void | Promise<void>) | undefined;
    const context = {
      route: vi.fn(async (_pattern, callback) => {
        handler = callback;
      }),
      routeWebSocket: vi.fn(async (_pattern, callback) => {
        socketHandler = callback;
      }),
    };
    await restrictPreviewContext(context as unknown as BrowserContext, "http://127.0.0.1:40123");
    const allowed = {
      request: () => ({ url: () => "http://127.0.0.1:40123/app.js" }),
      fetch: vi.fn(async () => ({ headers: () => ({}), status: () => 200 })),
      fulfill: vi.fn(),
      abort: vi.fn(),
    };
    const foreign = {
      ...allowed,
      request: () => ({ url: () => "http://127.0.0.1:9000/secrets" }),
      fetch: vi.fn(),
      fulfill: vi.fn(),
      abort: vi.fn(),
    };
    await handler!(allowed as unknown as Route);
    await handler!(foreign as unknown as Route);
    expect(allowed.fetch).toHaveBeenCalledWith({ maxRedirects: 0 });
    expect(allowed.fulfill).toHaveBeenCalledOnce();
    expect(foreign.fetch).not.toHaveBeenCalled();
    expect(foreign.abort).toHaveBeenCalledWith("blockedbyclient");
    const socket = { close: vi.fn() };
    await socketHandler!(socket as unknown as WebSocketRoute);
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
