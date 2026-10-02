import type { BrowserWindow } from "electron";
import { createDoubleControlDetector } from "./doubleControl.ts";

/** Receive Windows keyboard messages even while the workspace is hidden, without suppressing keys. */
export async function installWindowsDoubleControl(
  window: BrowserWindow,
  onDoubleControl: () => void,
): Promise<() => void> {
  const { DataType, load, open } = await import("ffi-rs");
  if (window.isDestroyed()) return () => {};
  const library = "satellite-keyboard-user32";
  open({ library, path: "user32.dll" });
  const handle = window.getNativeWindowHandle();
  const pointerSize = handle.length;
  const headerSize = 8 + pointerSize * 2;
  const device = Buffer.alloc(8 + pointerSize);
  device.writeUInt16LE(1, 0); // Generic desktop usage page.
  device.writeUInt16LE(6, 2); // Keyboard.
  const register = (remove: boolean) => {
    device.writeUInt32LE(remove ? 1 : 0x100, 4); // RIDEV_REMOVE / RIDEV_INPUTSINK.
    if (remove) device.fill(0, 8);
    else handle.copy(device, 8);
    return load({
      library,
      funcName: "RegisterRawInputDevices",
      retType: DataType.Boolean,
      paramsType: [DataType.U8Array, DataType.U32, DataType.U32],
      paramsValue: [device, 1, device.length],
    });
  };
  const detect = createDoubleControlDetector();
  const data = Buffer.alloc(headerSize + 16);
  const size = Buffer.alloc(4);
  window.hookWindowMessage(0x00ff, (_wParam, lParam) => {
    size.writeUInt32LE(data.length);
    const bytes = load({
      library,
      funcName: "GetRawInputData",
      retType: DataType.U32,
      paramsType: [DataType.BigInt, DataType.U32, DataType.U8Array, DataType.U8Array, DataType.U32],
      paramsValue: [
        pointerSize === 8 ? lParam.readBigUInt64LE() : BigInt(lParam.readUInt32LE()),
        0x10000003, // RID_INPUT.
        data,
        size,
        headerSize,
      ],
    });
    if (bytes !== data.length || data.readUInt32LE(0) !== 1) return;
    const flags = data.readUInt16LE(headerSize + 2);
    const virtualKey = data.readUInt16LE(headerSize + 6);
    const key = virtualKey === 0x11 ? ((flags & 2) !== 0 ? 0xa3 : 0xa2) : virtualKey;
    if (detect(key, (flags & 1) !== 0, performance.now())) onDoubleControl();
  });
  if (!register(false)) {
    window.unhookWindowMessage(0x00ff);
    throw new Error("Windows refused to register the double-Ctrl shortcut.");
  }
  return () => {
    register(true);
    if (!window.isDestroyed()) window.unhookWindowMessage(0x00ff);
  };
}
