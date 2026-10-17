// @effect-diagnostics nodeBuiltinImport:off - reads tracked files directly to compare them with the identity module.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CLI_RELEASE_BASE_URL_ENV,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
} from "@t3tools/shared/cliRelease";
import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_DMG_BACKGROUND_PATHS,
  DESKTOP_PACKAGING,
  PRODUCT_ICON_PATHS,
  PRODUCT_NAME,
  PRODUCT_SHORT_NAME,
  PRODUCT_STAGE_LABEL,
  RELEASE_REPOSITORY,
  RELEASES_URL,
} from "../../packages/contracts/src/productIdentity.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
const read = (file: string) => NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8");

/** Upstream release paths that stay, each with the reason Satellite never runs them. */
const UPSTREAM_RELEASE_URL_ALLOWLIST = [
  // Upstream's marketing site, which Satellite does not deploy.
  "apps/marketing/",
  // Upstream's AUR packages. Satellite removed the workflow that publishes them.
  "packaging/aur/",
  // Still upstream's until Satellite's release workflow is ported; delete this entry then.
  ".github/workflows/release.yml",
];

describe("static identity consumers", () => {
  it("the desktop manifest names the stable product", () => {
    expect(JSON.parse(read("apps/desktop/package.json")).productName).toBe(
      DESKTOP_PACKAGING.productNames.stable,
    );
  });

  it("the web app manifest names Satellite", () => {
    const manifest = JSON.parse(read("apps/web/public/manifest.webmanifest"));
    expect({ name: manifest.name, short_name: manifest.short_name }).toEqual({
      name: PRODUCT_NAME,
      short_name: PRODUCT_SHORT_NAME,
    });
  });

  it("the web entry page names Satellite and shows a static boot image", () => {
    const html = read("apps/web/index.html");
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe(
      `${PRODUCT_NAME} (${PRODUCT_STAGE_LABEL})`,
    );
    expect(/id="boot-shell-card" aria-label="([^"]*)"/.exec(html)?.[1]).toBe(
      `${PRODUCT_NAME} splash screen`,
    );
    expect(/id="boot-shell-logo"[^>]*alt="([^"]*)"/.exec(html)?.[1]).toBe(PRODUCT_NAME);
    expect(html).not.toContain("<animate");
  });

  it("the desktop dev launcher uses the product display names", () => {
    expect(
      /const APP_DISPLAY_NAME = isDevelopment \? "([^"]*)" : "([^"]*)";/
        .exec(read("apps/desktop/scripts/electron-launcher.mjs"))
        ?.slice(1),
    ).toEqual([`${PRODUCT_NAME} (Dev)`, DESKTOP_PACKAGING.productNames.stable]);
  });

  it("the npm launcher downloads from Satellite's releases by default", () => {
    expect(
      /process\.env\.T3CODE_RELEASE_BASE_URL \|\|\s*"([^"]*)"/.exec(
        read("scripts/npm-launcher/t3.mjs"),
      )?.[1],
    ).toBe(`${RELEASES_URL}/download`);
  });

  it("the committed web icons are Satellite's production icons", () => {
    const production = PRODUCT_ICON_PATHS.production;
    const pairs = [
      ["apps/web/public/favicon.ico", production.webFaviconIco],
      ["apps/web/public/favicon-16x16.png", production.webFavicon16Png],
      ["apps/web/public/favicon-32x32.png", production.webFavicon32Png],
      ["apps/web/public/apple-touch-icon.png", production.webAppleTouchIconPng],
    ] as const;
    const drifted = pairs.filter(
      ([committed, source]) =>
        !NodeFS.readFileSync(NodePath.join(repoRoot, committed)).equals(
          NodeFS.readFileSync(NodePath.join(repoRoot, source)),
        ),
    );
    expect(drifted).toEqual([]);
  });

  it("every icon and disk image reference resolves to a file", () => {
    const references = [
      ...Object.values(PRODUCT_ICON_PATHS).flatMap((channel) => Object.values(channel)),
      ...Object.values(DESKTOP_DMG_BACKGROUND_PATHS),
    ];
    expect(references.filter((file) => !NodeFS.existsSync(NodePath.join(repoRoot, file)))).toEqual(
      [],
    );
  });
});

describe("release sources", () => {
  it("builds CLI release URLs from Satellite's repository unless the operator overrides them", () => {
    expect(CLI_RELEASE_BASE_URL_ENV).toBe("T3CODE_RELEASE_BASE_URL");
    expect(cliReleaseDownloadBaseUrl("2.0.0")).toBe(
      `https://github.com/${RELEASE_REPOSITORY}/releases/download/v2.0.0`,
    );
    expect(cliReleaseIndexPageUrl(1)).toBe(
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100&page=1`,
    );
    expect(cliReleaseDownloadBaseUrl("2.0.0", "https://mirror.example/releases")).toBe(
      "https://mirror.example/releases/v2.0.0",
    );
  });

  it("no tracked source defaults to upstream's release downloads or index", () => {
    const upstreamRelease =
      /github\.com\/pingdotgg\/t3code\/releases|api\.github\.com\/repos\/pingdotgg\/t3code\/releases/;
    // The official T3 Code mobile app is upstream's and checks upstream's releases.
    const sources = NodeChildProcess.execFileSync(
      "git",
      ["ls-files", "--", ":!.repos", ":!apps/mobile"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\n")
      .filter(
        (file) =>
          /\.(c?[jt]sx?|mjs|json|ya?ml|sh|ps1|html|astro)$|(^|\/)PKGBUILD$/.test(file) &&
          !/\.test\.[cm]?[jt]sx?$/.test(file),
      );
    const hits = sources.filter(
      (file) =>
        !UPSTREAM_RELEASE_URL_ALLOWLIST.some((allowed) => file.startsWith(allowed)) &&
        NodeFS.existsSync(NodePath.join(repoRoot, file)) &&
        upstreamRelease.test(read(file)),
    );
    expect(hits).toEqual([]);
  });
});
