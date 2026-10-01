import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { restartApp } from "./lifecycle.ts";

describe("restart app IPC", () => {
  for (const isDevelopment of [true, false]) {
    it.effect(
      `waits for shutdown before restarting ${isDevelopment ? "development" : "packaged"} app`,
      () =>
        Effect.gen(function* () {
          const requested = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();
          const exited = yield* Deferred.make<number>();
          const events: string[] = [];
          const layer = Layer.mergeAll(
            DesktopLifecycle.layer,
            DesktopState.layer,
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              isDevelopment,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
            Layer.mock(ElectronTheme.ElectronTheme, {}),
            Layer.mock(DesktopWindow.DesktopWindow, {
              flushMainWindowBounds: Effect.sync(() => {
                events.push("flush");
              }),
            }),
            Layer.mock(DesktopShutdown.DesktopShutdown, {
              request: Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
              awaitComplete: Deferred.await(completed),
            }),
            Layer.mock(ElectronApp.ElectronApp, {
              relaunch: () =>
                Effect.sync(() => {
                  events.push("relaunch");
                }),
              exit: (code) => Deferred.succeed(exited, code).pipe(Effect.asVoid),
            }),
          );
          yield* Effect.gen(function* () {
            yield* restartApp.handler(undefined);
            yield* Deferred.await(requested);
            assert.deepEqual(events, ["flush"]);
            assert.isFalse(yield* Deferred.isDone(exited));
            yield* Deferred.succeed(completed, undefined);
            assert.equal(yield* Deferred.await(exited), isDevelopment ? 75 : 0);
            assert.deepEqual(events, isDevelopment ? ["flush"] : ["flush", "relaunch"]);
          }).pipe(Effect.provide(layer));
        }),
    );
  }
});
