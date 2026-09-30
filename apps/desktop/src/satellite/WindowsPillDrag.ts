export interface WindowsPillDragApi {
  readonly isLeftButtonDown: () => boolean;
  readonly getCursorPosition: () => { readonly x: number; readonly y: number } | undefined;
  readonly releaseCapture: () => void;
  readonly postMessage: (
    handle: bigint,
    message: number,
    command: bigint,
    point: bigint,
  ) => boolean;
}

export function startWindowsPillDragWithApi(handle: Buffer, api: WindowsPillDragApi): boolean {
  const windowHandle =
    handle.length === 8
      ? handle.readBigUInt64LE()
      : handle.length === 4
        ? BigInt(handle.readUInt32LE())
        : undefined;
  if (windowHandle === undefined || windowHandle === 0n || !api.isLeftButtonDown()) return false;
  const cursor = api.getCursorPosition();
  if (!cursor) return false;
  const point = BigInt(((cursor.x & 0xffff) | ((cursor.y & 0xffff) << 16)) >>> 0);
  api.releaseCapture();
  return api.postMessage(windowHandle, 0x0112, 0xf012n, point);
}

let dragPromise: Promise<(handle: Buffer) => boolean> | undefined;

/** Load before the gesture. Invoke on Electron's main thread to release its mouse capture. */
export function loadWindowsPillDrag(): Promise<(handle: Buffer) => boolean> {
  dragPromise ??= import("ffi-rs").then(({ DataType, load, open }) => {
    const library = "satellite-pill-drag-user32";
    open({ library, path: "user32.dll" });
    const api = {
      isLeftButtonDown: () =>
        (load({
          library,
          funcName: "GetAsyncKeyState",
          retType: DataType.I16,
          paramsType: [DataType.I32],
          paramsValue: [0x01],
        }) &
          0x8000) !==
        0,
      getCursorPosition: () => {
        const point = Buffer.alloc(8);
        const found = load({
          library,
          funcName: "GetCursorPos",
          retType: DataType.Boolean,
          paramsType: [DataType.U8Array],
          paramsValue: [point],
        });
        return found ? { x: point.readInt32LE(0), y: point.readInt32LE(4) } : undefined;
      },
      releaseCapture: () => {
        load({
          library,
          funcName: "ReleaseCapture",
          retType: DataType.Boolean,
          paramsType: [],
          paramsValue: [],
        });
      },
      postMessage: (handle, message, command, point) =>
        load({
          library,
          funcName: "PostMessageW",
          retType: DataType.Boolean,
          paramsType: [DataType.BigInt, DataType.U32, DataType.BigInt, DataType.BigInt],
          paramsValue: [handle, message, command, point],
        }),
    } satisfies WindowsPillDragApi;
    return (handle: Buffer) => startWindowsPillDragWithApi(handle, api);
  });
  return dragPromise;
}
