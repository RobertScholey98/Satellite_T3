import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/** Satellite keeps its existing Chromium profile independently of the server's T3 home. */
export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: { readonly appDataDirectory: string; readonly isDevelopment: boolean }) {
    const path = yield* Path.Path;
    return path.join(
      input.appDataDirectory,
      input.isDevelopment ? "satellite-t3-dev" : "satellite-t3",
    );
  },
);
