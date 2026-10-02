import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { installWindowsDoubleControl } from "./WindowsDoubleControl.ts";

const native = vi.hoisted(() => ({
  register: vi.fn<(device: Buffer) => boolean>(() => true),
  input: Buffer.alloc(40),
  bytes: 40,
}));
vi.mock("ffi-rs", () => ({
  DataType: { Boolean: 6, U8Array: 10, U32: 20, BigInt: 16 },
  open: vi.fn(),
  load: vi.fn((request) => {
    if (request.funcName === "RegisterRawInputDevices")
      return native.register(Buffer.from(request.paramsValue[0]));
    native.input.copy(request.paramsValue[2]);
    return native.bytes;
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  native.register.mockReset().mockReturnValue(true);
});

describe("Windows double-Ctrl listener", () => {
  const window = () => ({
    isDestroyed: vi.fn(() => false),
    getNativeWindowHandle: () => Buffer.from([42, 0, 0, 0, 0, 0, 0, 0]),
    hookWindowMessage: vi.fn<BrowserWindow["hookWindowMessage"]>(),
    unhookWindowMessage: vi.fn(),
  });

  it("receives keyboard input in the background and unregisters on disposal", async () => {
    const main = window();
    const action = vi.fn();
    const dispose = await installWindowsDoubleControl(main as unknown as BrowserWindow, action);
    const device = native.register.mock.calls[0]![0] as Buffer;
    expect(device.readUInt16LE(0)).toBe(1);
    expect(device.readUInt16LE(2)).toBe(6);
    expect(device.readUInt32LE(4)).toBe(0x100);
    expect(device.readBigUInt64LE(8)).toBe(42n);
    const receive = main.hookWindowMessage.mock.calls[0]![1];
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const input = (flags: number) => {
      native.input.fill(0);
      native.input.writeUInt32LE(1, 0);
      native.input.writeUInt16LE(flags, 26);
      native.input.writeUInt16LE(0x11, 30);
      receive(Buffer.alloc(8), Buffer.alloc(8));
      now += 40;
    };
    input(0);
    input(1);
    input(2);
    input(3);
    expect(action).toHaveBeenCalledOnce();
    dispose();
    const removed = native.register.mock.calls[1]![0] as Buffer;
    expect(removed.readUInt32LE(4)).toBe(1);
    expect(removed.readBigUInt64LE(8)).toBe(0n);
    expect(main.unhookWindowMessage).toHaveBeenCalledWith(0xff);
  });

  it("removes the message hook when Windows rejects registration", async () => {
    native.register.mockReturnValue(false);
    const main = window();
    await expect(
      installWindowsDoubleControl(main as unknown as BrowserWindow, vi.fn()),
    ).rejects.toThrow("Windows refused");
    expect(main.unhookWindowMessage).toHaveBeenCalledWith(0xff);
  });

  it("does nothing after the window closes", async () => {
    const main = window();
    main.isDestroyed.mockReturnValue(true);
    await installWindowsDoubleControl(main as unknown as BrowserWindow, vi.fn());
    expect(main.hookWindowMessage).not.toHaveBeenCalled();
    expect(native.register).not.toHaveBeenCalled();
  });
});
