export interface WindowsDwmApi {
  readonly disableTransitions: (handle: Buffer) => void;
  readonly registerThumbnail: (destination: Buffer, source: Buffer) => bigint;
  readonly updateThumbnail: (
    thumbnail: bigint,
    bounds: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
    opacity: number,
  ) => void;
  readonly unregisterThumbnail: (thumbnail: bigint) => void;
}

function windowHandle(handle: Buffer): bigint {
  const value =
    handle.length === 8
      ? handle.readBigUInt64LE()
      : handle.length === 4
        ? BigInt(handle.readUInt32LE())
        : 0n;
  if (value === 0n) throw new Error("DWM requires a valid native window handle.");
  return value;
}

function checkResult(operation: string, result: number): void {
  if (result < 0)
    throw new Error(`${operation} failed with HRESULT 0x${(result >>> 0).toString(16)}.`);
}

let dwmPromise: Promise<WindowsDwmApi> | undefined;

export function loadWindowsDwm(): Promise<WindowsDwmApi> {
  dwmPromise ??= import("ffi-rs").then(({ DataType, load, open }) => {
    const library = "satellite-dwmapi";
    open({ library, path: "dwmapi.dll" });
    return {
      disableTransitions(handle) {
        const disabled = Buffer.alloc(4);
        disabled.writeInt32LE(1);
        checkResult(
          "DwmSetWindowAttribute",
          load({
            library,
            funcName: "DwmSetWindowAttribute",
            retType: DataType.I32,
            paramsType: [DataType.BigInt, DataType.U32, DataType.U8Array, DataType.U32],
            paramsValue: [windowHandle(handle), 3, disabled, disabled.length],
          }),
        );
      },
      registerThumbnail(destination, source) {
        const thumbnail = Buffer.alloc(8);
        checkResult(
          "DwmRegisterThumbnail",
          load({
            library,
            funcName: "DwmRegisterThumbnail",
            retType: DataType.I32,
            paramsType: [DataType.BigInt, DataType.BigInt, DataType.U8Array],
            paramsValue: [windowHandle(destination), windowHandle(source), thumbnail],
          }),
        );
        const handle = thumbnail.readBigUInt64LE();
        if (handle === 0n) throw new Error("DwmRegisterThumbnail returned a null thumbnail.");
        return handle;
      },
      updateThumbnail(thumbnail, bounds, opacity) {
        // Win32 RECT uses signed LONGs; BYTE opacity is padded before the two four-byte BOOLs.
        const properties = Buffer.alloc(48);
        properties.writeUInt32LE(1 | 4 | 8 | 16, 0);
        properties.writeInt32LE(Math.round(bounds.x), 4);
        properties.writeInt32LE(Math.round(bounds.y), 8);
        properties.writeInt32LE(Math.round(bounds.x + bounds.width), 12);
        properties.writeInt32LE(Math.round(bounds.y + bounds.height), 16);
        properties.writeUInt8(Math.round(Math.max(0, Math.min(255, opacity))), 36);
        properties.writeInt32LE(bounds.width > 0 && bounds.height > 0 && opacity > 0 ? 1 : 0, 40);
        properties.writeInt32LE(1, 44);
        checkResult(
          "DwmUpdateThumbnailProperties",
          load({
            library,
            funcName: "DwmUpdateThumbnailProperties",
            retType: DataType.I32,
            paramsType: [DataType.BigInt, DataType.U8Array],
            paramsValue: [thumbnail, properties],
          }),
        );
      },
      unregisterThumbnail(thumbnail) {
        checkResult(
          "DwmUnregisterThumbnail",
          load({
            library,
            funcName: "DwmUnregisterThumbnail",
            retType: DataType.I32,
            paramsType: [DataType.BigInt],
            paramsValue: [thumbnail],
          }),
        );
      },
    } satisfies WindowsDwmApi;
  });
  return dwmPromise;
}
