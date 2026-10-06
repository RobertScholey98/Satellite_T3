import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { loadWindowsDwm } from "./WindowsDwm.ts";

const native = vi.hoisted(() => ({
  result: 0,
  thumbnail: 0x123456789n,
  calls: [] as { readonly funcName: string; readonly paramsValue: unknown[] }[],
}));

vi.mock("ffi-rs", () => ({
  DataType: { I32: 1, U32: 2, U8Array: 3, BigInt: 4 },
  open: vi.fn(),
  load: (request: { readonly funcName: string; readonly paramsValue: unknown[] }) => {
    native.calls.push(request);
    if (request.funcName === "DwmRegisterThumbnail") {
      const output = request.paramsValue[2];
      if (!Buffer.isBuffer(output))
        throw new Error("Expected a writable thumbnail output pointer.");
      output.writeBigUInt64LE(native.thumbnail);
    }
    return native.result;
  },
}));

function handle(value = 42n, bytes = 8) {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 8) buffer.writeBigUInt64LE(value);
  else buffer.writeUInt32LE(Number(value));
  return buffer;
}

function lastBuffer(index: number) {
  const buffer = native.calls.at(-1)?.paramsValue[index];
  if (!Buffer.isBuffer(buffer)) throw new Error("Expected a native structure buffer.");
  return buffer;
}

beforeEach(() => {
  native.result = 0;
  native.thumbnail = 0x123456789n;
  native.calls.length = 0;
});

describe("Windows DWM boundary", () => {
  it("caches the native adapter", async () => {
    expect(await loadWindowsDwm()).toBe(await loadWindowsDwm());
  });

  it.each([4, 8])("disables transitions for a %i-byte HWND using a Win32 BOOL", async (bytes) => {
    const api = await loadWindowsDwm();
    api.disableTransitions(handle(42n, bytes));
    expect(native.calls[0]).toEqual({
      library: "satellite-dwmapi",
      funcName: "DwmSetWindowAttribute",
      retType: 1,
      paramsType: [4, 2, 3, 2],
      paramsValue: [42n, 3, Buffer.from([1, 0, 0, 0]), 4],
    });
  });

  it("retains pointer precision through thumbnail registration and disposal", async () => {
    const api = await loadWindowsDwm();
    const thumbnail = api.registerThumbnail(handle(9007199254740993n), handle(52n));
    expect(native.calls[0]?.paramsValue.slice(0, 2)).toEqual([9007199254740993n, 52n]);
    expect(thumbnail).toBe(native.thumbnail);
    api.unregisterThumbnail(thumbnail);
    expect(native.calls.at(-1)?.paramsValue).toEqual([native.thumbnail]);
  });

  it("packs a client thumbnail rectangle, opacity, and visibility with native alignment", async () => {
    const api = await loadWindowsDwm();
    api.updateThumbnail(42n, { x: -20, y: -10, width: 240, height: 120 }, 128);
    const properties = lastBuffer(1);
    expect(properties.length).toBe(48);
    expect(properties.readUInt32LE(0)).toBe(29);
    expect([4, 8, 12, 16].map((offset) => properties.readInt32LE(offset))).toEqual([
      -20, -10, 220, 110,
    ]);
    expect(properties.subarray(20, 36)).toEqual(Buffer.alloc(16));
    expect(properties.readUInt8(36)).toBe(128);
    expect(properties.subarray(37, 40)).toEqual(Buffer.alloc(3));
    expect(properties.readInt32LE(40)).toBe(1);
    expect(properties.readInt32LE(44)).toBe(1);
  });

  it.each([
    { width: 240, height: 120, opacity: 0 },
    { width: 0, height: 120, opacity: 255 },
    { width: 240, height: 0, opacity: 255 },
  ])("hides a thumbnail with no visible area or opacity: %j", async (input) => {
    const api = await loadWindowsDwm();
    api.updateThumbnail(
      42n,
      { x: 0, y: 0, width: input.width, height: input.height },
      input.opacity,
    );
    expect(lastBuffer(1).readInt32LE(40)).toBe(0);
  });

  it.each([Buffer.alloc(3), Buffer.alloc(8)])(
    "rejects invalid or null window handles",
    async (input) => {
      const api = await loadWindowsDwm();
      expect(() => api.disableTransitions(input)).toThrow("valid native window handle");
      expect(() => api.registerThumbnail(handle(), input)).toThrow("valid native window handle");
      expect(native.calls).toHaveLength(0);
    },
  );

  it("rejects successful registration without a thumbnail handle", async () => {
    native.thumbnail = 0n;
    const api = await loadWindowsDwm();
    expect(() => api.registerThumbnail(handle(), handle())).toThrow("null thumbnail");
  });

  it("reports native HRESULT failures for every operation", async () => {
    native.result = -2147024809;
    const api = await loadWindowsDwm();
    expect(() => api.disableTransitions(handle())).toThrow(
      "DwmSetWindowAttribute failed with HRESULT 0x80070057",
    );
    expect(() => api.registerThumbnail(handle(), handle())).toThrow(
      "DwmRegisterThumbnail failed with HRESULT 0x80070057",
    );
    expect(() => api.updateThumbnail(42n, { x: 0, y: 0, width: 10, height: 10 }, 255)).toThrow(
      "DwmUpdateThumbnailProperties failed with HRESULT 0x80070057",
    );
    expect(() => api.unregisterThumbnail(42n)).toThrow(
      "DwmUnregisterThumbnail failed with HRESULT 0x80070057",
    );
  });
});
