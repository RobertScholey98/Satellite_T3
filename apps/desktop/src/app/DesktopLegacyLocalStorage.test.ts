import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";

it.effect("does not import T3 data into Satellite's retained Chromium profile", () =>
  Effect.gen(function* () {
    const legacyStorage = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
    yield* legacyStorage.load("C:\\Users\\alice\\AppData\\Roaming\\satellite-t3");
    assert.isTrue(Option.isNone(yield* legacyStorage.take));
    yield* legacyStorage.complete;
    assert.isTrue(Option.isNone(yield* legacyStorage.take));
  }).pipe(Effect.provide(DesktopLegacyLocalStorage.layer)),
);
