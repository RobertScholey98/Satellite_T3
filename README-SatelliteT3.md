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

Open a project, select a conversation, and submit a task. Use **Hide to Satellite pill** or
close the main window to leave the conversation running. Click the pill to return
to that conversation. Its menu provides **Open conversation** and **Quit SatelliteT3**.
Use the grip to drag the pill, or focus it and press Alt+arrow keys. Its position
survives relaunch and is kept on screen. The system tray also reopens the app.

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
window properties, hidden-window updates, reopen, quit, and position restoration.
Screenshots are saved below `.t3/verification/native-smoke/artifacts`.
