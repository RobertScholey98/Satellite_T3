import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { PRODUCT_ICON_PATHS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const ROOT_DIR = "/repo";

const defaultEnvironmentInput = {
  dirname: `${ROOT_DIR}/apps/desktop/dist-electron`,
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: `${ROOT_DIR}/apps/desktop`,
  isPackaged: false,
  resourcesPath: `${ROOT_DIR}/apps/desktop/resources`,
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const developmentEnv = { VITE_DEV_SERVER_URL: "http://localhost:5173" };

const resolveIconPaths = (
  input: {
    readonly environment?: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput>;
    readonly env?: Record<string, string | undefined>;
    readonly exists?: (candidate: string) => boolean;
    readonly probedPaths?: string[];
  } = {},
) =>
  Effect.gen(function* () {
    const assets = yield* DesktopAssets.DesktopAssets;
    return yield* assets.iconPaths;
  }).pipe(
    Effect.provide(
      DesktopAssets.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({
              exists: (candidate) =>
                Effect.sync(() => {
                  input.probedPaths?.push(candidate);
                  return input.exists?.(candidate) ?? true;
                }),
            }),
            DesktopEnvironment.layer({
              ...defaultEnvironmentInput,
              ...input.environment,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  NodePath.layerPosix,
                  DesktopConfig.layerTest({ ...input.env }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

describe("DesktopAssets", () => {
  it.effect.each([
    {
      run: "an unpackaged development run on macOS",
      env: developmentEnv,
      platform: "darwin",
      icons: PRODUCT_ICON_PATHS.development,
      pngPath: PRODUCT_ICON_PATHS.development.macIconPng,
    },
    {
      run: "an unpackaged development run on Windows",
      env: developmentEnv,
      platform: "win32",
      icons: PRODUCT_ICON_PATHS.development,
      pngPath: PRODUCT_ICON_PATHS.development.universalIconPng,
    },
    {
      run: "an unpackaged production run on Windows",
      env: {},
      platform: "win32",
      icons: PRODUCT_ICON_PATHS.production,
      pngPath: PRODUCT_ICON_PATHS.production.universalIconPng,
    },
  ] as const)("takes Satellite's icons from the source tree for $run", (testCase) => {
    const probedPaths: string[] = [];

    return Effect.gen(function* () {
      const iconPaths = yield* resolveIconPaths({
        env: { ...testCase.env },
        environment: { platform: testCase.platform },
        probedPaths,
      });

      assert.equal(
        Option.getOrUndefined(iconPaths.ico),
        `${ROOT_DIR}/${testCase.icons.windowsIconIco}`,
      );
      assert.equal(Option.getOrUndefined(iconPaths.png), `${ROOT_DIR}/${testCase.pngPath}`);
      assert.isEmpty(probedPaths.filter((candidate) => /\/assets\/(?:dev|prod)\//.test(candidate)));
    });
  });

  it.effect("resolves nothing from the source tree for a packaged run", () => {
    const probedPaths: string[] = [];

    return Effect.gen(function* () {
      const iconPaths = yield* resolveIconPaths({
        environment: { isPackaged: true, platform: "win32" },
        probedPaths,
      });

      assert.equal(
        Option.getOrUndefined(iconPaths.ico),
        `${ROOT_DIR}/apps/desktop/resources/icon.ico`,
      );
      assert.equal(
        Option.getOrUndefined(iconPaths.png),
        `${ROOT_DIR}/apps/desktop/resources/icon.png`,
      );
      assert.isEmpty(
        probedPaths.filter((candidate) => candidate.startsWith(`${ROOT_DIR}/assets/`)),
      );
    });
  });

  it.effect("falls through to the packaged resource when the source tree icon is missing", () =>
    Effect.gen(function* () {
      const iconPaths = yield* resolveIconPaths({
        env: developmentEnv,
        environment: { platform: "win32" },
        exists: (candidate) => !candidate.startsWith(`${ROOT_DIR}/assets/`),
      });

      assert.equal(
        Option.getOrUndefined(iconPaths.ico),
        `${ROOT_DIR}/apps/desktop/resources/icon.ico`,
      );
    }),
  );
});
