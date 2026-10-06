# Satellite desktop releases

The [SatelliteT3 Release workflow](../../.github/workflows/release.yml) builds an
unsigned Windows x64 installer and ad-hoc signed macOS arm64/x64 DMG and ZIP files.
It publishes them to this fork's GitHub Releases with checksums and Windows
automatic-update files. It uses the built-in workflow
token; no release secrets are required. GitHub Actions must be enabled.

## Publish a version

In GitHub Actions, open **SatelliteT3 Release**, choose **Run workflow**, select
the branch to build, and enter a version without the `v` prefix, such as `0.1.3`
or `0.1.3-beta.1`. The workflow builds that branch's commit, then creates the tag
and publishes the release after its checks and build succeed. If the tag already
exists, it must point to the commit being built.

You can also commit and push the changes you want to ship, then tag that commit:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

Use `vX.Y.Z` for a stable release, or `vX.Y.Z-alpha.N`, `vX.Y.Z-beta.N`, or
`vX.Y.Z-rc.N` for a prerelease. Plain versions are marked latest; prereleases are
not. Choose an unused version for each release.

The workflow checks out the selected commit, installs dependencies, runs focused lint,
desktop/web typechecks, and desktop, web, startup, and packaging tests. It builds
Windows on `windows-2025`, Apple Silicon on `macos-15`, and Intel on
`macos-15-intel`. All builds use the same resolved commit. After every build
succeeds and verifies its preload bundle, it publishes:

- `SatelliteT3-<version>-x64.exe`
- The installer's `.blockmap`
- `latest.yml` (Windows updates)
- `SatelliteT3-<version>-arm64.dmg` and `.zip`
- `SatelliteT3-<version>-x64.dmg` and `.zip`
- `SHA256SUMS`

It does not publish npm packages, standalone CLI archives, Linux installers,
mobile builds, a hosted web app, or a WSL runtime. There is no scheduled nightly
release or upstream deployment step.

To retry a failed run, use GitHub Actions' rerun control or manually run the
workflow from the same commit with the same version. Publishing an already published version fails
rather than replacing its assets.

## Install and update behavior

Installed builds use `~/.satellite-t3/userdata` and the `satellite-t3` Chromium
profile. Development data is separate and is not migrated.

The workflow sets `T3CODE_DESKTOP_UPDATE_REPOSITORY` to the repository running it,
so Windows installers check this fork's releases. Stable installations follow stable
releases. macOS builds use an ad-hoc signature without notarization and omit the
update feed: Squirrel.Mac requires Developer ID signing for automatic updates.
Users install and update them manually from the DMG; see [installation](../user/install.md). The `dev:satellite` launcher disables automatic updates.

Before updating, finish or stop active work: installing an update restarts the
app and its local server. See [updating](../user/updating.md).

## Local packaging

Install the [Windows packaging prerequisites](./development.md#windows-installer-prerequisites),
then run:

```powershell
pnpm install --frozen-lockfile
pnpm run dist:desktop:win:x64
```

On macOS, install the [DMG prerequisites](./development.md#macos-dmg-prerequisites),
then run either architecture's build:

```sh
pnpm run dist:desktop:dmg:arm64
pnpm run dist:desktop:dmg:x64
```

Artifacts are written to `release/`. Set `T3CODE_DESKTOP_VERSION` to choose the
version and `T3CODE_DESKTOP_UPDATE_REPOSITORY` to choose an update repository
(`owner/repo`). Use `--keep-stage` when inspecting packaging failures.

The shared packager still supports Linux, Developer ID signing, and a custom WSL
payload. Those require their own setup; see the
[development prerequisites](./development.md#desktop-artifacts) and the
[upstream packaging reference](https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md).
They are not part of this fork's release workflow.
