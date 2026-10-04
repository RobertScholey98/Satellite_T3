# Install Satellite

Satellite's release workflow publishes Windows x64 installers and macOS disk images.
Download the `.exe` for Windows or the `.dmg` for macOS (`arm64` for Apple Silicon,
`x64` for Intel) from [this fork's releases](https://github.com/RobertScholey98/Satellite_T3/releases).
These builds use `~/.satellite-t3/userdata`; they do not migrate
existing T3 Code or development data.

On macOS, open the DMG and drag Satellite into Applications. The macOS builds have
an ad-hoc signature but are not signed with an Apple Developer ID or notarized.
If macOS blocks the app, try opening it once, then go to **System Settings → Privacy
& Security → Open Anyway** and confirm. Only do this for a download you trust from
this fork. To update, quit Satellite and replace it with the newer app from the
DMG; your data stays in place.

For a source checkout, use the [README setup](../../README.md#build-and-run-from-source).
The development launcher uses separate data and disables automatic updates.

## Requirements

Install and authenticate a provider before starting a thread. You can launch
Satellite and configure providers afterwards. Local desktop use needs no T3
Connect account or `.env` file.

## Desktop workspace

The workspace opens on launch. macOS uses a normal window with a Dock entry and
does not show Pill mode in Settings. On Windows, closing or minimizing in Pill mode
collapses the workspace while agents continue working. Click the pill or double-tap Ctrl to
return. See [desktop usage](../../README.md#use-the-desktop-workspace) for pinning,
position, status, and switching to a normal window.

## Other clients and upstream installations

Web, mobile, and other desktop platforms remain in the source tree. See the
[development runbook](../operations/development.md) and
[mobile README](../../apps/mobile/README.md) for source builds.

The [original T3 installation commands](../../README.md#original-t3-installation-reference)
are retained for the upstream CLI, desktop packages, and mobile apps. They install
upstream T3 Code and do not provide Satellite's fork features. The hosted app at
`app.t3.codes` is also upstream. Satellite currently publishes no standalone CLI,
Linux installer, mobile store release, or bundled WSL runtime.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from Satellite's provider settings.                                                                                       |

Provider CLIs must be on the server's `PATH`. If Satellite cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

Satellite warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when Satellite can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Satellite does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Satellite](./updating.md): update this fork and understand connected-server updates.
