/**
 * Satellite's identity. Every surface that names the app, locates its data, or fetches a release
 * reads it from here. Files that cannot import code (manifests, HTML, launcher scripts) carry
 * these values as literals, and `scripts/lib/product-identity-consumers.test.ts` fails when they
 * drift. Upstream's names for T3 Connect, the `t3` CLI, URL schemes, the package scope, and
 * environment variables stay upstream's and are not listed here.
 */

/** The product name every surface shows. */
export const PRODUCT_NAME = "Satellite";
/** @public Read by the web manifest drift check. */
export const PRODUCT_SHORT_NAME = "Satellite";
/** Shown after the name on stable builds, as in "Satellite (Alpha)". */
export const PRODUCT_STAGE_LABEL = "Alpha";

/** Directory under the user's home that holds installed Satellite's T3 home. */
export const PRODUCT_HOME_DIRECTORY_NAME = ".satellite-t3";

/**
 * Chromium profile folders under the OS app data directory. 2.x starts a new production profile
 * so a rollback to 1.x still finds its own; on Windows it copies only Local State, which holds
 * the safeStorage key, from the 1.x profile. Never a T3 Code profile.
 */
export const DESKTOP_PROFILE_NAMES = {
  production: "satellite-t3-v2",
  legacyProduction: "satellite-t3",
  development: "satellite-t3-dev",
} as const;

/**
 * The 1.x values. Windows matches them to upgrade the same app and keep taskbar pins.
 * @public Read by the desktop build.
 */
export const DESKTOP_APP_ID = "com.satellitet3.prototype";
export const DESKTOP_APP_USER_MODEL_IDS = {
  production: "com.satellitet3.prototype",
  development: "com.satellitet3.prototype.dev",
} as const;

/** The only GitHub repository any Satellite release fetch may read, as `owner/name`. */
export const RELEASE_REPOSITORY = "RobertScholey98/Satellite_T3";
/** @public */
export const REPOSITORY_URL = `https://github.com/${RELEASE_REPOSITORY}`;
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;
/** @public */
export const ISSUES_URL = `${REPOSITORY_URL}/issues`;

/**
 * Installer metadata. The stable product name sets the Windows executable and install folder.
 * @public Read by the desktop build.
 */
export const DESKTOP_PACKAGING = {
  productNames: {
    stable: `${PRODUCT_NAME} (${PRODUCT_STAGE_LABEL})`,
    nightly: `${PRODUCT_NAME} (Nightly)`,
  },
  artifactPrefix: "SatelliteT3",
  description: "Satellite desktop build",
  homepage: REPOSITORY_URL,
  author: "Satellite contributors",
  linuxMaintainer: "Robert Scholey <RobertScholey98@users.noreply.github.com>",
  protocolDisplayName: PRODUCT_NAME,
  macUsageDescriptions: {
    localNetwork: `${PRODUCT_NAME} connects to devices on your local network for remote environments and commands run by terminals and coding agents.`,
    screenCapture: `${PRODUCT_NAME} captures the active window when you use the window capture shortcut.`,
  },
} as const;

/** @public Repository-relative icon paths for each build channel, read by the brand asset map. */
export const PRODUCT_ICON_PATHS = {
  development: {
    iconComposerProject: "assets/satellite/dev/app-icon.icon",
    iosIconPng: "assets/satellite/dev/satellite-dev-ios-1024.png",
    macIconPng: "assets/satellite/dev/satellite-dev-macos-1024.png",
    universalIconPng: "assets/satellite/dev/satellite-dev-universal-1024.png",
    windowsIconIco: "assets/satellite/dev/satellite-dev-windows.ico",
    webFaviconIco: "assets/satellite/dev/satellite-dev-web-favicon.ico",
    webFavicon16Png: "assets/satellite/dev/satellite-dev-web-favicon-16x16.png",
    webFavicon32Png: "assets/satellite/dev/satellite-dev-web-favicon-32x32.png",
    webAppleTouchIconPng: "assets/satellite/dev/satellite-dev-web-apple-touch-180.png",
  },
  nightly: {
    iconComposerProject: "assets/satellite/nightly/app-icon.icon",
    iosIconPng: "assets/satellite/nightly/satellite-nightly-ios-1024.png",
    macIconPng: "assets/satellite/nightly/satellite-nightly-macos-1024.png",
    universalIconPng: "assets/satellite/nightly/satellite-nightly-universal-1024.png",
    windowsIconIco: "assets/satellite/nightly/satellite-nightly-windows.ico",
    webFaviconIco: "assets/satellite/nightly/satellite-nightly-web-favicon.ico",
    webFavicon16Png: "assets/satellite/nightly/satellite-nightly-web-favicon-16x16.png",
    webFavicon32Png: "assets/satellite/nightly/satellite-nightly-web-favicon-32x32.png",
    webAppleTouchIconPng: "assets/satellite/nightly/satellite-nightly-web-apple-touch-180.png",
  },
  production: {
    iconComposerProject: "assets/satellite/prod/app-icon.icon",
    iosIconPng: "assets/satellite/prod/satellite-ios-1024.png",
    macIconPng: "assets/satellite/prod/satellite-macos-1024.png",
    universalIconPng: "assets/satellite/prod/satellite-universal-1024.png",
    windowsIconIco: "assets/satellite/prod/satellite-windows.ico",
    webFaviconIco: "assets/satellite/prod/satellite-web-favicon.ico",
    webFavicon16Png: "assets/satellite/prod/satellite-web-favicon-16x16.png",
    webFavicon32Png: "assets/satellite/prod/satellite-web-favicon-32x32.png",
    webAppleTouchIconPng: "assets/satellite/prod/satellite-web-apple-touch-180.png",
    logoSvg: "assets/satellite/prod/logo.svg",
  },
} as const;

/** @public macOS disk image backgrounds by update channel, read by the desktop build. */
export const DESKTOP_DMG_BACKGROUND_PATHS = {
  latest: "assets/satellite/dmg/dmg-background-latest.svg",
  nightly: "assets/satellite/dmg/dmg-background-nightly.svg",
} as const;
