# Satellite

Satellite is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code), where
I experiment with integrating ideas that relate directly to my own workflow.
Release artifacts and the development launcher use the name **SatelliteT3**.

## Why this fork exists

I forked T3 Code to have a place to try ideas in the tools I use every day and
see how they fit together in practice. The direction comes from my own workflow,
and will evolve as I use it.

The experiments focus on the work around an agent conversation: deciding what to
build, running the work in an isolated worktree, and reviewing what changed.

T3 Code supplies the foundation: provider sessions, conversations, terminals,
checkpoints, source control, and remote environments. Satellite keeps those
capabilities and adds its own workflow. This is an independent fork; T3's hosted
services, app-store listings, and release channels are operated by upstream.

## Install Satellite

Download the Windows x64 `.exe` or the macOS `.dmg` (`arm64` for Apple Silicon,
`x64` for Intel) from
[this fork's releases](https://github.com/RobertScholey98/Satellite_T3/releases).
Installers are unsigned. Installed builds use `~/.satellite-t3/userdata`. Windows
receives desktop updates from this fork.

On macOS, drag the app from the DMG into Applications. The builds are ad-hoc
signed, not notarized, and updated manually. If macOS blocks the first launch, try
opening the app once, then go to **System Settings → Privacy & Security → Open
Anyway** and confirm. Only do this for a download you trust from this fork.

For source builds, follow the setup below. The Satellite release workflow ships
Windows x64 and macOS arm64/x64. Web and mobile source remain in the repository.
It does not bundle a WSL runtime or publish a standalone CLI.

### Set up a provider

Install and authenticate at least one provider before starting a thread. Open
**Settings → Providers** to enable and configure it on the machine running agents.

| Provider    | Setup                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`, or use [Connect with ChatGPT](./docs/user/providers-codex.md#connect-with-chatgpt). |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`.                                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli) and run `agent login`.                                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli) and run `grok login`.                                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai) and run `opencode auth login`.                                                                                                  |
| Antigravity | Enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No separate CLI is required.                                                       |

Existing provider logins are reused. See [provider setup](./docs/user/install.md#providers)
for executable paths, separate accounts, and provider updates.

## Build and run from source

Use **Node 24** (`^24.13.1`) and **pnpm 11.10.0**, as pinned in `package.json`.

```powershell
git clone https://github.com/RobertScholey98/Satellite_T3.git SatelliteT3
cd SatelliteT3
pnpm install --frozen-lockfile
pnpm run dev:satellite
```

The first launch builds the web client and server before opening Electron. Keep
the launch terminal running and read the selected ports from `[dev-runner]`.
Local desktop development needs no `.env` file or hosted-service account.

### Install `vp`

The repository uses Vite+. The pnpm commands above use the checkout's installed
tools; install the global `vp` command to use the other development commands directly.

macOS / Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Windows PowerShell:

```powershell
irm https://vite.plus/ps1 | iex
```

See the [Vite+ getting started guide](https://viteplus.dev/guide/) for details.
With `vp` installed, `vp i` installs dependencies. `vp run dev` starts the web
client and server; `vp run dev:desktop` starts the inherited desktop runner.
Use `pnpm run dev:satellite` for Satellite's isolated desktop configuration.

See the [development runbook](./docs/operations/development.md) for worktrees,
remote access, focused checks, and native packaging prerequisites. To build a
Windows installer locally after installing those prerequisites:

```powershell
pnpm run dist:desktop:win:x64
```

### Data locations

| Run                      | Server data                         |
| ------------------------ | ----------------------------------- |
| `pnpm run dev:satellite` | `<checkout>/.t3/satellite/userdata` |
| Installed SatelliteT3    | `~/.satellite-t3/userdata`          |

The development launcher disables automatic updates. It does not migrate existing T3 or Satellite data. Development and installed
builds keep separate server data.

## Guides

- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Source control](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Remote access](./docs/user/remote-access.md) and [updates](./docs/user/updating.md)
- [All documentation](./docs/README.md) · [Architecture](./docs/internals/overview.md)

Report Satellite issues and suggest changes in
[this fork's issue tracker](https://github.com/RobertScholey98/Satellite_T3/issues).
See [CONTRIBUTING.md](./CONTRIBUTING.md) before preparing a change.

## Original T3 installation reference

The original setup commands are retained here for anyone who also uses upstream
T3 Code. **These install T3 Code, not Satellite.** They do not include this fork's
features. Satellite's installation and source setup are above.

<details>
<summary>Upstream CLI and desktop installation commands</summary>

Install the upstream CLI on macOS / Linux:

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

Or in Windows PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Run `t3` to start the server and open its local web app. `t3 service install`
keeps it running in the background on supported hosts, `t3 update` updates it,
and `t3 --help` shows the command reference. Use `npx t3@latest` to try it without
installing. See [background services](./docs/user/background-service.md).

Upstream desktop downloads are available from
[T3 Code releases](https://github.com/pingdotgg/t3code/releases):

| Platform           | Command                                                      |
| ------------------ | ------------------------------------------------------------ |
| Windows            | `winget install T3Tools.T3Code`                              |
| macOS              | `brew install --cask t3-code`                                |
| Debian / Ubuntu    | Download the `.deb`, then `sudo apt install ./T3-Code-*.deb` |
| Arch Linux stable  | `yay -S t3code-bin`                                          |
| Arch Linux nightly | `yay -S t3code-nightly-bin`                                  |

T3 also operates its [hosted web app](https://app.t3.codes) and publishes mobile
apps for [iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824)
and [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code).
These are upstream clients, not Satellite distributions.

</details>

## Credits and license

Satellite builds on [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools and
its contributors. The [MIT license](./LICENSE), upstream history, and
[third-party notices](./docs/user/open-source-licenses.md) are retained.
