import { assert, it } from "@effect/vitest";

import { parseSatelliteReleaseVersion } from "./satellite-release-version.ts";

it("accepts stable versions as latest releases", () => {
  assert.deepStrictEqual(parseSatelliteReleaseVersion("2.0.0"), {
    ok: true,
    release: { version: "2.0.0", tag: "v2.0.0", prerelease: false },
  });
  assert.deepStrictEqual(parseSatelliteReleaseVersion("12.3.40"), {
    ok: true,
    release: { version: "12.3.40", tag: "v12.3.40", prerelease: false },
  });
});

it("marks alpha, beta, and rc versions as prereleases", () => {
  for (const version of ["2.0.0-alpha.0", "2.0.0-beta.3", "2.1.0-rc.12"]) {
    assert.deepStrictEqual(parseSatelliteReleaseVersion(version), {
      ok: true,
      release: { version, tag: `v${version}`, prerelease: true },
    });
  }
});

it("rejects a leading v and names the version to enter instead", () => {
  assert.deepStrictEqual(parseSatelliteReleaseVersion("v2.0.0"), {
    ok: false,
    reason: "Enter the version without the leading v, for example 2.0.0.",
  });
});

it("rejects malformed versions", () => {
  for (const version of [
    "",
    "2",
    "2.0",
    "2.0.0.0",
    "02.0.0",
    "2.0.0-alpha",
    "2.0.0-nightly.1",
    "2.0.0-beta.01",
    "2.0.0+build.1",
    " 2.0.0",
  ]) {
    assert.deepStrictEqual(parseSatelliteReleaseVersion(version), {
      ok: false,
      reason: `${version} is not a release version. Expected X.Y.Z or X.Y.Z-alpha.N, -beta.N, or -rc.N.`,
    });
  }
});

it("rejects majors below 2 so 1.x versions are never reused", () => {
  for (const version of ["1.3.0", "0.1.14", "1.2.1-rc.1"]) {
    assert.deepStrictEqual(parseSatelliteReleaseVersion(version), {
      ok: false,
      reason: `${version} is below 2.0.0. Satellite 2.x releases must not reuse 1.x versions.`,
    });
  }
});
