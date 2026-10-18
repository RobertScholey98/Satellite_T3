#!/usr/bin/env node
/**
 * Validates a Satellite release version and prints `version`, `tag`, and `prerelease` as
 * `key=value` lines for `$GITHUB_OUTPUT`. Exits 1 with a reason on stderr when the version is
 * rejected.
 *
 *   node scripts/satellite-release-version.ts 2.0.0-beta.1 >> "$GITHUB_OUTPUT"
 */

export interface SatelliteReleaseVersion {
  readonly version: string;
  readonly tag: string;
  readonly prerelease: boolean;
}

export type SatelliteReleaseVersionResult =
  | { readonly ok: true; readonly release: SatelliteReleaseVersion }
  | { readonly ok: false; readonly reason: string };

/**
 * 1.x tags already exist, and the official T3 Code mobile app offers to replace a server whose
 * version is older than upstream's latest CLI release, so Satellite stays on 2.x or above.
 */
const MINIMUM_MAJOR = 2;
const NUMBER = "(0|[1-9]\\d*)";
const VERSION_PATTERN = new RegExp(
  `^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(alpha|beta|rc)\\.${NUMBER})?$`,
);

export function parseSatelliteReleaseVersion(input: string): SatelliteReleaseVersionResult {
  if (input.startsWith("v")) {
    return {
      ok: false,
      reason: `Enter the version without the leading v, for example ${input.slice(1)}.`,
    };
  }
  const match = VERSION_PATTERN.exec(input);
  if (!match) {
    return {
      ok: false,
      reason: `${input} is not a release version. Expected X.Y.Z or X.Y.Z-alpha.N, -beta.N, or -rc.N.`,
    };
  }
  if (Number(match[1]) < MINIMUM_MAJOR) {
    return {
      ok: false,
      reason: `${input} is below ${MINIMUM_MAJOR}.0.0. Satellite 2.x releases must not reuse 1.x versions.`,
    };
  }
  return {
    ok: true,
    release: { version: input, tag: `v${input}`, prerelease: match[4] !== undefined },
  };
}

if (import.meta.main) {
  const result = parseSatelliteReleaseVersion(process.argv[2] ?? "");
  if (!result.ok) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(1);
  }
  const { version, tag, prerelease } = result.release;
  process.stdout.write(`version=${version}\ntag=${tag}\nprerelease=${prerelease}\n`);
}
