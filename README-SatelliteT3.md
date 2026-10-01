# SatelliteT3 Windows prototype

T3 Code with Satellite's always-available pill. T3 owns conversations, providers,
worktrees, terminals, and execution. The pill is a small desktop view of the selected
conversation; it does not run another agent or workflow engine.

## Launch

Use Node 24 and pnpm 11. From this directory in PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm run dev:satellite
```

The launch script invokes upstream's Vite+ desktop development runner. Its first
launch builds the web client and server before opening Electron. Leave the launch
terminal running. Ports are selected automatically; read them from `[dev-runner]`.
Existing supported provider logins are used by upstream without copying credentials.

## Use

SatelliteT3 starts as a pill and stays out of the taskbar. Click the pill to expand
the workspace from its position, then open a project, select a conversation, and
submit a task. Closing, minimizing, pressing Escape, or clicking outside collapses
the workspace while the conversation keeps running. Use **Keep workspace open** to
prevent collapse when clicking outside. Drag anywhere on the pill, or focus it
and press Alt+arrow keys; its position survives relaunch and is kept on screen.
The pill menu and system tray can open the workspace or **Quit SatelliteT3**.

Blue means working, amber means input or approval is needed, green means the latest
turn explicitly completed, red means an error, and gray means idle or unavailable.
Clicking the pill does not approve requests or resolve pending questions.

## Documents

Agents can publish retained plans, reports, and manual verification checklists to
the thread's **Documents** panel. Review outcomes and notes can be saved as drafts,
exported to Markdown, or explicitly submitted to the agent. Published revisions,
saved answers, and submission/delivery history stay on the environment host.
Interactive HTML documents can use the JSON bridge to load and save draft answers.

See [Documents and manual reviews](docs/user/documents.md) for usage and
[Document authoring](docs/operations/document-authoring.md) for the example generator
and protocol. Existing provider session data and T3's built-in proposed plans keep
their normal storage; file documents enter this library when published explicitly.

## Isolation and scope

- Server data: `.t3/satellite/userdata` in this checkout.
- Windows Chromium profile: `%APPDATA%/satellite-t3-dev`.
- Windows app ID: `com.satellitet3.prototype.dev`.
- No existing T3 or Satellite data is migrated. Automatic updates and URL-handler
  registration are disabled for this launcher.
- This is a local Windows desktop prototype. Web/mobile clients and other platforms
  are outside the pill's scope. Upstream provider capabilities remain unchanged.
- The pill follows the selected conversation. It is not a queue for every task.

The upstream README and license notices are retained. Upstream history is preserved;
`upstream` points to `pingdotgg/t3code` and `origin` to the personal fork.

## Verification

Fork CI builds the desktop app and runs focused Satellite tests on GitHub's Windows
runners. The manual **Windows Tests** workflow runs additional package or file checks.
Upstream publishing, deployment, mobile builds, and contributor moderation workflows
are removed from this fork.

## Windows releases

The **SatelliteT3 Release** workflow builds an unsigned Windows x64 installer and
publishes it with checksums and automatic-update files to this fork's GitHub Releases.
GitHub Actions must be enabled. It uses the built-in workflow token; no release
secrets are required.

Commit and push the changes you want to ship, then tag that commit:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

Use a new version for each release. Tags such as `v0.1.0-alpha.1`,
`v0.1.0-beta.1`, and `v0.1.0-rc.1` publish prereleases; plain `v0.1.0` releases
are marked latest. To retry a failed run, use GitHub Actions' rerun control or run
the release workflow manually with the existing tag. Publishing an already
published version fails rather than replacing its assets.

Download the `.exe` from GitHub Releases and install it. Installed builds start
with the pill, store server data under `~/.satellite-t3/userdata`, and use the
`satellite-t3` Chromium profile. They do not migrate the development launcher's
data. Automatic updates point at the repository that built the installer;
stable installs follow stable releases. These initial releases are unsigned and
do not bundle a Linux WSL runtime or publish standalone CLI archives.

The real GPT-6.1 Sol continuity test created a file in a disposable repository while
the main window was hidden. The pill showed working and completed states; clicking
it restored and focused the correct conversation. Approval/input and unavailable
states are covered by focused tests and explicitly labelled development fixtures.
Live provider approval prompts have not been exercised.

After the initial desktop build, run the native fixture test with:

```powershell
node scripts/satellite-smoke.mjs
```

It uses separate `.t3/verification` data, runs no provider turns, and checks native
window clipping, expansion/collapse motion, zoom, pinning, quit, and position
restoration. Screenshots, video, and frame measurements are saved below
`.t3/verification/native-smoke/artifacts`.
