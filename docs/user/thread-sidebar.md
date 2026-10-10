# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start project management

On web and desktop, create an engineering manager from the thread sidebar. Choose
the project on its owning environment, an authenticated Codex model, and the local
path and exact commit of your owned skills repository. Each project has one manager.

The manager delegates onboarding to a separate lead thread. Open either thread to
discuss the investigation, and review its report for project instructions, quality
checks, verification tools, and decisions that need your input. Onboarding uses a
read-only copy of committed files; it omits untracked files, credential paths, and
symlinks. It does not authorize implementation or merging.

The owning environment needs a local Docker Linux engine and the discovery image.
If preparation fails, the manager keeps its identity and explains what needs fixing.
Before either thread starts, **Edit setup and retry** lets you correct the model or
skills revision. After startup, retry preserves the existing conversation and access
boundary. Reports remain available when their conversation is archived or deleted.

After reviewing the report, approve the project's execution boundary: the existing
files teams may edit, directories where they may create files, protected controls,
and required checks. Approval captures an immutable baseline and verifies that the
environment can enforce it. A failed check leaves setup editable. The current
runner supports direct Node verification commands; unsupported toolchains need a
qualified runner before implementation can start.

Use **Autonomy defaults** for environment-wide permissions and the manager's
autonomy settings for individual overrides. Clearing an override restores that
setting's defaults. Permission increases apply to future assignments unless you
explicitly extend selected active grants. Reductions constrain active work and
remain in effect even if you later raise the defaults. Grant extensions preserve
task scope and outstanding human approvals. Workflow changes always require your
review; weakening project safeguards always requires a separately authorized task.

Once the manager is ready, use **Assign work** to set a task, completion condition,
complexity, and its permitted files. A new implementation lead appears under the
manager as an ordinary thread. It starts from the project's current committed
revision and keeps the approved workflow, permissions, and model choices recorded
for that assignment. Preparation failures remain visible and can be retried.

Use **Model defaults** or **Team models** to approve exact models and options and
favor them for lead, worker, and reviewer roles at different task complexities.
Managers inherit defaults unless overridden. Removing an approved model stops
affected active work; adding it back does not silently restore that work's grant.

To continue work you already started, choose **Hand over thread**. Handover stops
its running team before capturing the current work, including staged and untracked
files. The existing conversation, branch, worktree, and PR links stay attached.
Protected-control changes need a separately authorized rule-change assignment.

### Guide, pause, or stop managed work

Messages to an implementation lead or its app-owned workers are guidance. The
lead receives a reference to guidance you give its workers. Scope and priority
decisions can be escalated to the engineering manager without changing the
assignment's permissions.

Choose **Take over thread** to suspend parent direction while you work directly
with that thread. Its tools and current scope stay available. **Hand back thread**
restores parent coordination and eligible queued messages. Existing manual queue
holds still require the ordinary queue resume action.

Open **Controls** beside the manager, or **Manager and project controls** in a
managed conversation. **Pause manager** stops manager coordination while existing
teams continue within their grants. **Pause project** stops the manager and all its
managed teams. Both preserve edited work. Resume releases only the selected pause;
other pauses, takeovers, permission restrictions, and approval waits remain active.

**Cancel assignment** starts stopping its dedicated team immediately. Once stopping
is confirmed, provide a reason for its retrospective. Dismissing that prompt leaves
**Add reason** available in the conversation and assignment details. If stopping
fails, the assignment remains blocked and offers a retry. Control state and missing
reasons survive restarting the environment.

### Follow progress, dependencies, and recovery

Open **Assignment details** to see the lead's latest progress and evidence, its
current wait, and any supporting assignments. Dependency approval authorizes
separate work. The original team resumes only after delivery is confirmed and
its lead records that the result is usable. A merged PR needs host evidence;
an investigation needs its actual report message at the agreed recipient.

If a team stops with authorized work remaining, the manager receives a recorded
recovery incident. An independent diagnosis thread inspects a read-only snapshot
of the unfinished work. Its findings support an in-scope replan or replacement
lead. Replacement preserves the edited workspace, assignment permissions, and
recovery allowance; prior conversations remain linked. When the allowance is
exhausted, the human decision includes the failure, attempts, options, and a
recommendation. Expected review, dependency, and human-decision waits do not
consume recovery cycles. Observation and recovery receipts survive restart.

### Review and deliver managed work

The implementation team owns its PR, independent review, required checks, and
merge process. Open **Assignment details → Delivery and review** to inspect the
candidate, review findings, and reasons delivery is waiting. Human approval applies
to the exact PR head and evidence shown; changed work needs fresh verification and
approval. Give corrections directly to the implementation lead. The manager keeps
visibility while human review is pending, without directing that work.

Changed user flows pause implementation for a concrete flow proposal. Approve or
reject that proposal in the assignment details before implementation continues.
Substantial UI work also needs an independent reviewer to exercise the frozen
candidate and capture screenshots. In **Delivery settings**, configure a supported
Node preview entry point and pinned image before requesting this verification.
Preview data is disposable and the app has no external network access; a preview
that needs an unavailable service remains blocked with an explanation.

Screenshot publication requires a separate project setting. Enabling it allows
the host to publish the verified images to immutable evidence refs in that project's
repository and link them in the PR. Check that the preview contains suitable test
data before enabling this setting.

Human approval is the default. To permit routine autonomous merges, configure an
explicit project merge rule and grant the manager that delivery autonomy. Both
must allow the work. Major UI changes and unclear eligibility still require human
approval. The host rechecks the current permissions and PR evidence immediately
before merging, and records delivery only after the host confirms the actual merge.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

To choose where a new worktree lives, use **New worktree** beside the new-thread
heading on web or desktop. Enter a folder name and new branch, then choose a local
or remote source branch. The folder is created directly inside the selected
project's root on its environment, and the new worktree is selected for your
draft. You can change the selection before sending your prompt.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Explore an idea

Select **Idea** when starting a new thread to discuss a feature before committing
to implementation. Each idea belongs to its project and environment and keeps one
conversation. Return to it through **Ideas** in the sidebar footer. Idea activity
stays out of the ordinary thread list and work notifications.

Ideas use your selected provider and model, with the same tools, skills and access
settings as ordinary threads. Ask the agent to save previews and documents in the
notebook so they stay with the idea. Background notebook updates run separately
and cannot use the conversation's general-purpose tools.

OpenCode ideas use the environment's local OpenCode installation so the agent can
access notebook tools and documents. If ordinary threads use an external OpenCode
server, configure the model and sign-in locally too.

The notebook starts with an empty pitch. Background updates organise the discussion
into notes and keep the pitch current. Choose their model in **Settings → General
→ Text generation → Idea updates**. This setting is separate from thread titles.
Automatic uses a default model from the idea's provider. If that provider is disabled
or removed, it uses another enabled provider.
You can edit the pitch and notes, add attachments, and follow linked phrases to
their supporting notes. If an update conflicts with your edits, review its proposal
in the notebook. Failed updates can be retried while you continue the conversation.

Use **Promote to issues** to prepare `/promote` in the existing conversation. Review
the proposed issues and their GitHub repository before publishing. Issue descriptions
contain the implementation context, so they remain useful after the idea is gone.
Publishing embeds text and does not upload notebook attachments.
Full promotion settles the idea; partial promotion leaves its remaining scope active.
New discussion or manual content changes reopen a settled idea.

Deleting an idea permanently removes its conversation, notebook and owned files
after confirmation. Published issues remain on GitHub.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each work thread without a project works in its own folder under `~/.t3/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo when no text field is focused; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

Agents connected through T3 Code can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

Turn on **Settings → General → Working section (beta)** on web and desktop, or **Settings →
Thread behavior → Working section** on iOS and Android, to move threads that are working or
monitoring into a collapsed **Working** section below the active list. A thread returns to the top
of the active list when it finishes, fails, or needs an approval or answer. The Working section
lists the thread you last sent work to first. Pinned threads stay in the pinned section. Each
device keeps its own choice.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled.

Change these rules in **Settings → General** on web and desktop, or **Settings → Thread behavior** on mobile.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
On web and desktop, press **Resume** in an empty composer to continue a limited
or interrupted turn manually.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Auto-resume limited
threads** in **Settings → General** on web and desktop, or **Settings → Thread
behavior** on mobile, to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Sending a new message, archiving, or settling the
thread prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze limited threads** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.
Stop on a thread also stops the subagents it delegated to.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

## Snooze until later

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.
