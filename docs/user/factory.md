# Factory

The factory is a standing engineering manager for a project. It watches the project's issue board,
starts small tickets on its own, commissions a lead thread with a team for each one, and brings
anything that needs you back to you. Every manager, lead and team thread is an ordinary thread, so
you can read it, answer its questions and take it over at any time.

## Setting it up

Open **Factory** from the bottom of the sidebar, or choose **Open factory** in the command palette.
**Configuration** holds every factory setting. The first time, it offers a starting point: a model
pool from your enabled Claude and Codex models and one **Standard** team of an implementer, a
reviewer and a verifier. Nothing is saved until you press **Save**.

- **Pickup** is the guidance the manager reads before starting a Ready ticket on its own, and how
  many assignments may run at once. Leave the guidance empty and nothing starts without you. Pickup
  needs a connected board; see [Issues](./issues.md).
- **Models** is the pool every factory thread must start on, with the manager's model, the lead's
  model by ticket size, and an allow-list per worker role.
- **Teams** lists the presets the manager chooses from. A preset has a name, when to use it, its
  members with a count each, and how the team works together. A project can add its own presets
  or replace an environment preset by name. Ask the manager in its thread for a custom team; it may
  ask you to save one as a preset.
- **Role skills** shows where each role's instructions come from. Put a file at
  `.satellite/factory/roles/<role>.md` in the project to customise a role there.
- **Behaviour** sets the recovery allowance per assignment and how often team digests refresh.

## Creating a manager

On the new-thread screen, turn on the **Engineering manager** toggle left of the checkout selector.
Type a name for the manager and send. The manager's thread opens pinned and starts onboarding: it
reads the project, proposes what it found and which files it must never change, and asks you to
approve. A project has one manager; retire it from its **Factory** row to create another.

## Living with a manager

The manager's thread is where you talk to it. Its details panel has a **Factory** row with its
state, how many assignments are running, and its last pickup decision, plus a menu to pause the
manager, pause the manager and its teams, resume, or retire it. The Issues page shows the same
status beside the sync time, and a ticket's detail says why the manager picked it up or skipped it.
**Start** on a ticket always wins over the manager's decision.

While you view the manager or any of its team threads, the right side shows two cards. **Team
activity** has one tab per assignment with a short digest of what the team is doing, written by
your text-generation model and refreshed on the interval you set; **Refresh** rewrites it on demand
and says **Up to date** when nothing new happened. **Team threads** lists each team's lead and
members, with the same waiting marker the sidebar uses, and a **Manager** button to go back. Lead
and team threads leave the sidebar while their manager runs; search and the command palette still
find them.

A lead's details panel shows **Lead for the manager** with the assignment's state. Its menu, and
the ticket chip's menu, offer **Take over** (the manager stops steering that assignment while you
drive the team), **Hand back**, and **Cancel assignment**, which asks for a reason the team's retro
records.

## Retro triage

When an assignment ends, its team and then the manager hold a retro. Findings become ticket drafts
in a **Retro triage** column that appears first on the project's board while it has a manager. The
column lives only in Satellite; nothing reaches GitHub or Azure DevOps until you approve a draft.
Open a card to edit it, then **Approve** or drag it to a Ready column to file the ticket there.
**Dismiss** hides a draft behind the **Dismissed** filter, where **Restore** brings it back.

Drafts about the factory itself are tinted and never go to a board. When one proposes a setting or
a team preset, **Apply** shows the change and makes it; it refuses if the setting changed since the
retro. **Discuss with manager** opens the manager's thread with the finding ready to send.

## Dashboard

**Factory**, **Dashboard** lists each manager with its state and running count, the number of
Retro triage cards per project, and team stats: tasks finished per team with median tokens, cost,
agent time and wall time, plus recoveries and review rounds. Select a team to see its finished
assignments with their outcome and the retro's verdict. Token totals across providers are
approximate, and the stats never include the digests.
