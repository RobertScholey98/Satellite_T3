import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { startWindowsPillDragWithApi, type WindowsPillDragApi } from "./WindowsPillDrag.ts";

function nativeHandle(bytes = 8) {
  const handle = Buffer.alloc(bytes);
  if (bytes === 8) handle.writeBigUInt64LE(41n);
  if (bytes === 4) handle.writeUInt32LE(41);
  return handle;
}

function makeApi() {
  return {
    isLeftButtonDown: vi.fn(() => true),
    getCursorPosition: vi.fn<WindowsPillDragApi["getCursorPosition"]>(() => ({ x: 120, y: 80 })),
    releaseCapture: vi.fn(() => undefined),
    postMessage: vi.fn<WindowsPillDragApi["postMessage"]>(() => true),
  } satisfies WindowsPillDragApi;
}

describe("Windows pill native drag", () => {
  it.each([4, 8])("starts a move for a %i-byte HWND after releasing capture", (bytes) => {
    const api = makeApi();
    const calls: string[] = [];
    api.releaseCapture.mockImplementation(() => {
      calls.push("release");
    });
    api.postMessage.mockImplementation(() => {
      calls.push("post");
      return true;
    });

    assert.isTrue(startWindowsPillDragWithApi(nativeHandle(bytes), api));
    assert.deepEqual(calls, ["release", "post"]);
    assert.deepEqual(api.postMessage.mock.calls, [[41n, 0x0112, 0xf012n, 5243000n]]);
  });

  it("rejects a delayed start after the button was released", () => {
    const api = makeApi();
    api.isLeftButtonDown.mockReturnValue(false);
    assert.isFalse(startWindowsPillDragWithApi(nativeHandle(), api));
    assert.lengthOf(api.getCursorPosition.mock.calls, 0);
    assert.lengthOf(api.releaseCapture.mock.calls, 0);
    assert.lengthOf(api.postMessage.mock.calls, 0);
  });

  it("packs signed physical coordinates on monitors left and above the primary", () => {
    const api = makeApi();
    api.getCursorPosition.mockReturnValue({ x: -1920, y: -1080 });
    assert.isTrue(startWindowsPillDragWithApi(nativeHandle(), api));
    assert.deepEqual(api.postMessage.mock.calls, [[41n, 0x0112, 0xf012n, 4224252032n]]);
  });

  it("does not release capture when cursor lookup fails", () => {
    const api = makeApi();
    api.getCursorPosition.mockReturnValue(undefined);
    assert.isFalse(startWindowsPillDragWithApi(nativeHandle(), api));
    assert.lengthOf(api.releaseCapture.mock.calls, 0);
    assert.lengthOf(api.postMessage.mock.calls, 0);
  });

  it.each([Buffer.alloc(3), Buffer.alloc(8)])("rejects an invalid or null HWND", (handle) => {
    const api = makeApi();
    assert.isFalse(startWindowsPillDragWithApi(handle, api));
    assert.lengthOf(api.isLeftButtonDown.mock.calls, 0);
    assert.lengthOf(api.postMessage.mock.calls, 0);
  });

  it("reports a failed native post", () => {
    const api = makeApi();
    api.postMessage.mockReturnValue(false);
    assert.isFalse(startWindowsPillDragWithApi(nativeHandle(), api));
  });
});
