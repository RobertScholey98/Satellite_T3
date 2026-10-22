#!/usr/bin/env node

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

const RELEASE_BUMPS = ["major", "minor", "patch"] as const;
type ReleaseBump = (typeof RELEASE_BUMPS)[number];

const STABLE_TAG_PATTERN = new RegExp(`^v${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);

/**
 * Bumps the highest stable `vX.Y.Z` tag. Prerelease tags are ignored, so a major bump after
 * `v2.0.0-beta.1` yields 2.0.0 when the latest stable tag is 1.x.
 */
export function nextSatelliteReleaseVersion(
  tags: readonly string[],
  bump: ReleaseBump,
): SatelliteReleaseVersionResult {
  let latest: readonly [number, number, number] | undefined;
  for (const tag of tags) {
    const match = STABLE_TAG_PATTERN.exec(tag);
    if (!match) continue;
    const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
    if (!latest || compareVersions(version, latest) > 0) latest = version;
  }
  if (!latest) {
    return { ok: false, reason: "No stable vX.Y.Z tag to bump. Enter the version instead." };
  }
  const [major, minor, patch] = latest;
  const next =
    bump === "major"
      ? `${major + 1}.0.0`
      : bump === "minor"
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`;
  return parseSatelliteReleaseVersion(next);
}

function compareVersions(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/**
 * `satellite-release-version.ts <version>` validates an exact version.
 * `satellite-release-version.ts --bump <major|minor|patch>` reads tag names from stdin, one per
 * line, and bumps the latest stable one.
 */
if (import.meta.main) {
  const [first, bumpArg] = process.argv.slice(2);
  const bump = RELEASE_BUMPS.find((candidate) => candidate === bumpArg);
  const result: SatelliteReleaseVersionResult =
    first !== "--bump"
      ? parseSatelliteReleaseVersion(first ?? "")
      : bump
        ? nextSatelliteReleaseVersion((await readStdin()).split(/\s+/), bump)
        : { ok: false, reason: "Expected --bump major, minor, or patch." };
  if (!result.ok) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(1);
  }
  const { version, tag, prerelease } = result.release;
  process.stdout.write(`version=${version}\ntag=${tag}\nprerelease=${prerelease}\n`);
}
