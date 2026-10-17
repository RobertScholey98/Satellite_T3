import { PRODUCT_ICON_PATHS } from "../../packages/contracts/src/productIdentity.ts";

const { development, nightly, production } = PRODUCT_ICON_PATHS;

export const BRAND_ASSET_PATHS = {
  developmentIconComposerProject: development.iconComposerProject,
  developmentIosIconPng: development.iosIconPng,
  developmentUniversalIconPng: development.universalIconPng,

  productionIconComposerProject: production.iconComposerProject,
  productionIosIconPng: production.iosIconPng,
  productionMacIconPng: production.macIconPng,
  productionLinuxIconPng: production.universalIconPng,
  productionWindowsIconIco: production.windowsIconIco,
  productionWebFaviconIco: production.webFaviconIco,
  productionWebFavicon16Png: production.webFavicon16Png,
  productionWebFavicon32Png: production.webFavicon32Png,
  productionWebAppleTouchIconPng: production.webAppleTouchIconPng,

  nightlyIconComposerProject: nightly.iconComposerProject,
  nightlyIosIconPng: nightly.iosIconPng,
  nightlyMacIconPng: nightly.macIconPng,
  nightlyLinuxIconPng: nightly.universalIconPng,
  nightlyWindowsIconIco: nightly.windowsIconIco,
  nightlyWebFaviconIco: nightly.webFaviconIco,
  nightlyWebFavicon16Png: nightly.webFavicon16Png,
  nightlyWebFavicon32Png: nightly.webFavicon32Png,
  nightlyWebAppleTouchIconPng: nightly.webAppleTouchIconPng,

  developmentDesktopIconPng: development.macIconPng,
  developmentWindowsIconIco: development.windowsIconIco,
  developmentWebFaviconIco: development.webFaviconIco,
  developmentWebFavicon16Png: development.webFavicon16Png,
  developmentWebFavicon32Png: development.webFavicon32Png,
  developmentWebAppleTouchIconPng: development.webAppleTouchIconPng,
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand {
  return /^[^-+]+-(?:nightly|preview)\./.test(version) ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
