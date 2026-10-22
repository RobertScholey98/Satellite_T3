import { assert, it } from "@effect/vitest";

import {
  nextSatelliteReleaseVersion,
  parseSatelliteReleaseVersion,
} from "./satellite-release-version.ts";

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

it("bumps the highest stable tag, ignoring prereleases and unrelated tags", () => {
  const tags = ["v0.0.44", "v1.2.1", "v1.10.0", "v1.9.9", "v3.0.0-beta.1", "v0.0.44-nightly.1", ""];
  assert.deepStrictEqual(nextSatelliteReleaseVersion(tags, "major"), {
    ok: true,
    release: { version: "2.0.0", tag: "v2.0.0", prerelease: false },
  });
  const v2Tags = [...tags, "v2.3.4"];
  assert.deepStrictEqual(nextSatelliteReleaseVersion(v2Tags, "minor"), {
    ok: true,
    release: { version: "2.4.0", tag: "v2.4.0", prerelease: false },
  });
  assert.deepStrictEqual(nextSatelliteReleaseVersion(v2Tags, "patch"), {
    ok: true,
    release: { version: "2.3.5", tag: "v2.3.5", prerelease: false },
  });
});

it("refuses a bump that stays below 2.x", () => {
  assert.deepStrictEqual(nextSatelliteReleaseVersion(["v1.2.1"], "minor"), {
    ok: false,
    reason: "1.3.0 is below 2.0.0. Satellite 2.x releases must not reuse 1.x versions.",
  });
});

it("asks for an exact version when there is no stable tag", () => {
  assert.deepStrictEqual(nextSatelliteReleaseVersion(["v2.0.0-rc.1"], "patch"), {
    ok: false,
    reason: "No stable vX.Y.Z tag to bump. Enter the version instead.",
  });
});
