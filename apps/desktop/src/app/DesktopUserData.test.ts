import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each([false, true])(
  "resolves Satellite's isolated profile without accessing other profiles (development: %s)",
  (isDevelopment) =>
    Effect.gen(function* () {
      const result = yield* resolveUserDataPath({
        appDataDirectory: "C:\\Users\\alice\\AppData\\Roaming",
        isDevelopment,
      });
      assert.equal(
        result,
        `C:\\Users\\alice\\AppData\\Roaming\\satellite-t3${isDevelopment ? "-dev" : ""}`,
      );
    }).pipe(Effect.provide(NodePath.layerWin32)),
);
