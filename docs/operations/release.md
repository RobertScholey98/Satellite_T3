# Release runbook

> For maintainers. Using Satellite? See [docs/user](../user/).

Satellite publishes desktop builds to this fork's
[GitHub Releases](https://github.com/RobertScholey98/Satellite_T3/releases) from
[`.github/workflows/release.yml`](../../.github/workflows/release.yml): a Windows x64
installer that updates itself, and macOS Apple Silicon and Intel builds installed by hand.
The workflow runs on GitHub-hosted runners and needs no secrets beyond the built-in token.

## Publish a release

1. Choose a version (see [Version rules](#version-rules)). Publish prereleases such as
   `2.0.0-beta.1` before a stable version: installed Windows builds follow the latest stable
   release, and an update migrates their data.
2. Make sure **SatelliteT3 CI** passed on the commit you will release. The release jobs run no
   tests, so **Resolve release** refuses a commit whose CI `Check` has not passed.
3. Start the workflow in either of two ways:
   - **Actions → SatelliteT3 Release → Run workflow.** Select the branch to build, usually
     `main`, and enter the version without the `v`. The workflow creates the `v` tag on that
     branch's commit when it publishes. Optionally fill in **release_notes**; they appear above
     the generated notes, so a stable release has its notes the moment it becomes latest.
   - **Push a tag:** `git tag v2.0.0 <commit> && git push origin v2.0.0`. The workflow builds
     the tagged commit. Edit the release afterwards to add notes.
4. Wait for **Publish GitHub Release**. Release notes are generated from merged pull requests.

To test the pipeline, tick **Dry run**, or run
`gh workflow run release.yml --ref <branch> -f version=2.0.0-alpha.1 -f dry_run=true`. A dry
run builds and checks every asset, uploads them with `SHA256SUMS` as the `release-assets` run
artifact, and creates no tag or release. It also needs passing CI on the branch's commit.

A failed run can be rerun with the same version from the same commit. A version whose tag
already names a different commit fails in **Resolve release**; pick a new version.

## Version rules

[`scripts/satellite-release-version.ts`](../../scripts/satellite-release-version.ts) accepts
`X.Y.Z` and `X.Y.Z-alpha.N`, `-beta.N`, or `-rc.N`, with no leading `v`.

- The major version is at least 2. Satellite 1.x tags run up to `v1.2.1` and must not be reused.
- Keep Satellite's major above upstream's. Upstream's official mobile app offers to update a
  server when upstream's newest CLI release is newer than the server's version, which would
  replace a Satellite server with upstream's.
- Versions with a suffix are GitHub prereleases and never marked latest, so stable Windows
  installs are not offered them. Plain versions are marked latest.
- Package manifests keep upstream's versions in the tree. The release jobs stamp the release
  version into them with `scripts/update-release-package-versions.ts`, as upstream's release does,
  so version bumps never conflict with an upstream sync.

## What the workflow does

1. **Resolve release** validates the version, checks the remote tag, and requires CI's `Check`
   to have passed on the commit.
2. **Build JS bundle** builds the server, web client, and Electron main once, with no T3 Connect
   configuration, and shares them with every target as the `js-bundle` artifact.
3. **Desktop Windows x64**, **Desktop macOS arm64**, and **Desktop macOS x64** each call
   upstream's reusable [`release-desktop.yml`](../../.github/workflows/release-desktop.yml) on a
   runner of the target's architecture (`windows-2025`, `macos-15`, `macos-15-intel`). They package
   the bundle with `scripts/build-desktop-artifact.ts`, unsigned, with no CLI archive and no WSL
   runtime.
4. **Verify macOS** extracts each ZIP, checks it holds one app with a valid signature and no update
   configuration, runs the packaged server's `--help`, and verifies the DMG.
5. **Publish GitHub Release** fails on a missing asset or any macOS update manifest, writes
   `SHA256SUMS`, and creates the release titled `SatelliteT3 v<version>`.

| Asset                                     | Purpose                          |
| ----------------------------------------- | -------------------------------- |
| `SatelliteT3-<version>-x64.exe`           | Windows installer                |
| `SatelliteT3-<version>-x64.exe.blockmap`  | Windows differential update data |
| `latest.yml`                              | Windows update feed              |
| `SatelliteT3-<version>-arm64.dmg`, `.zip` | macOS Apple Silicon              |
| `SatelliteT3-<version>-x64.dmg`, `.zip`   | macOS Intel                      |
| `SHA256SUMS`                              | Checksums of every asset above   |

## Update feed

- **Windows.** The build stamps the Actions repository into `resources/app-update.yml`
  (`provider: github`, release type `release`). Installed builds read `latest.yml` from the latest
  release. The installer upgrades 1.x in place because the app id stays `com.satellitet3.prototype`
  ([`productIdentity.ts`](../../packages/contracts/src/productIdentity.ts)); changing it would
  install a second copy beside the first.
- **macOS.** Builds are ad-hoc signed with publishing disabled, so they carry no feed. Squirrel.Mac
  installs only Developer ID signed updates. Users download each release by hand.
- A desktop-hosted server asked to update itself hands the request to the desktop updater, so it
  follows the same feed.

## Local packaging

The workflow's packaging step is the same script you run locally:

```sh
T3CODE_DESKTOP_VERSION=2.0.0-alpha.0 vp run dist:desktop:dmg:arm64
```

It writes `SatelliteT3-2.0.0-alpha.0-arm64.dmg` and `.zip` to `release/`. See
[Desktop artifacts](./development.md#desktop-artifacts) for prerequisites and other targets.
Launch a packaged build only with `T3CODE_HOME` set to a scratch directory: without it the app
opens `~/.satellite-t3`, the installed app's live data.

## What the workflow does not do

No code signing or notarization, no Linux or Windows arm64 builds, no CLI archives, npm package,
AUR package, hosted web app, marketing site, or announcements, and no nightly or preview channels.
Windows builds do not bundle a WSL runtime, so the WSL backend reports that the build lacks WSL
support. Upstream's
[release runbook](https://github.com/pingdotgg/t3code/blob/e58a4857130a93cc58b45dd6ebee14cf08df04ec/docs/operations/release.md)
covers those, including the Windows payload checks the build script still enforces.

## Upstream syncs

`release-desktop.yml` is upstream's file. Satellite adds only the `wsl_runtime` input, which
defaults to upstream's behaviour. CI lints every workflow with actionlint, which also checks the
inputs `release.yml` passes to `release-desktop.yml`, so an upstream change to those inputs fails
a pull request instead of a release. When upstream adds a required input, add it to the three
desktop jobs.
