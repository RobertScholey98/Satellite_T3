import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const restartApp = makeIpcMethod({
  channel: IpcChannels.RESTART_APP_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.lifecycle.restartApp")(function* () {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* lifecycle.relaunch("settings-restart");
  }),
});
