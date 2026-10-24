# Factory

The factory is a standing engineering manager for a project. It watches the project's issue board,
starts small tickets on its own, commissions a lead thread with a team for each one, and brings
anything that needs you back to you. Every manager, lead and team thread is an ordinary thread, so
you can read it, answer its questions and take it over at any time.

## Setting it up

Open **Factory** from the bottom of the sidebar, or choose **Open factory** in the command palette.
**Configuration** holds every factory setting. The first time, it offers a starter set: a model
pool from your enabled Claude and Codex models, implementer, reviewer and verifier workers, a
default lead and manager, and one **Standard** team.

- **Model pool** is the list of models the factory may use at all, and the recovery allowance per
  assignment. A model you add on another machine that this one can't run shows as unavailable here
  and is skipped.
- **Workers** are the building blocks of teams: a name, models, and a description of what the
  worker is and does. **Leads** and **Managers** follow a fixed protocol, so they report, hand back
  and hold retros the same way; what you write for them is added on top.
- **Teams** combine one lead with workers, each with a count. Adding a worker or lead to a team
  copies it, so you can rewrite a member's description for that team alone. Editing the worker
  later doesn't change the team. **May edit protected paths** lets a team change files the project
  protects, for teams whose job is the workflow itself.
- A model list runs its first available model in order. Turn on **Dynamic** to let the lead pick
  per task for a member, or the manager per ticket for a team's lead. An empty list means any model
  in the pool.
- The environment's **concurrency cap** and the git identity stay on this machine. A manager also
  has its own cap, set when you approve its onboarding; work starts only when both have room.
- **Runs on** appears when this machine has more than one instance of a provider, such as two Claude
  accounts. It picks which one runs the factory's models for that provider; **First available** uses
  whichever comes first. It stays on this machine. If the chosen instance goes away, the factory uses
  the first available one and Settings says so.

The factory config is a folder of Markdown files under `factory/` in Satellite's data directory,
one per worker, lead, manager and team. You can edit them by hand; Settings shows any file it
couldn't read. Configuration lists them as they are on the machine running the factory, including
when you connect to a remote one.

## Sharing your factory

**Config repo** keeps the factory folder in a Git repository you own, so the same workers and teams
follow you between machines. Connect it with a repository URL this machine can already push to;
Satellite uses the machine's own Git credentials and never stores a token. Nothing syncs on its
own: changes stay local until you **Push**, **Pull** brings in the repository's changes, and
**Check** shows whether there is anything to pull. When a file changed in both places, choose
**Keep mine** or **Take theirs** for it. **Discard local changes** returns to the last pull and keeps
a backup.

**Share** exports the whole config, or chosen teams, as a `.satellite-factory.zip` with no secrets
or machine settings. Importing one shows each worker, lead, manager and team as new, the same, or
different from yours; keep yours, take theirs, or keep both. Models the import needs that your pool
lacks are added only if you tick them. **Replace** swaps your config for the import and backs up
yours first.

## Creating a manager

On the new-thread screen, turn on the **Engineering manager** toggle left of the checkout selector.
Type a name for the manager and send. The manager's thread opens pinned and starts onboarding: it
reads the project and proposes how it should work. A project can have several managers. Each picks
up only from its own pickup columns, and a ticket one manager is working on is not offered to
another.

The proposal appears as a card in the manager's thread. Review it there:

- **Pickup** is off unless you turn it on. Turning it on lists each connected board's Ready columns
  by name, with none ticked; tick the columns the manager may take tickets from on its own. Columns
  you leave unticked stay available to **Start**. Pickup needs a connected board; see
  [Issues](./issues.md).
- **Questions** are the manager's open choices, with its recommended answer selected. Pick another
  option or write your own. Your answers become project rules the manager and every lead it starts
  follow.
- **Protected paths** are the files no team may change. Untick any you want teams to edit.
- **Findings** are things the manager noticed. They are not kept after approval; use **Draft
  ticket** for one you want to act on.

**Send back** sends your note to the manager so it can revise the proposal. **Approve** saves the
result and replaces the onboarding conversation with a fresh manager thread that starts from your
approved answers alone. The onboarding thread is settled and kept as a record. If you turned pickup
on, the manager picks up nothing until you press **Start picking up**; until then you can still give
it work in its thread.

## Living with a manager

The manager's thread is where you talk to it. Its details panel has a **Factory** row with its
state, how many assignments are running, and its last pickup decision, plus a menu to pause the
manager, pause the manager and its teams, resume, or retire it. The Issues page shows the same
status beside the sync time, and a ticket's detail says why the manager picked it up or skipped it.
**Start** on a ticket always wins over the manager's decision.

While you view the manager or any of its team threads, the right side shows a card for each team
at work, the team you are in first, listing its lead and members with the same waiting marker
the sidebar uses. The thread's details move to the top left, and on a team thread **Back to
manager** sits above them; in a narrow window both stay at the top right, above the teams. Lead
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

Drafts about the factory itself are tinted and never go to a board. When one proposes a setting, a
team, or a worker, lead or manager, **Apply** shows the whole change and makes it; it refuses if
that setting or file changed since the retro. **Discuss with manager** opens the manager's thread with the finding ready to send.

## Dashboard

**Factory**, **Dashboard** lists each manager with its state and running count, the number of
Retro triage cards per project, and team stats: tasks finished per team with median tokens, cost,
agent time and wall time, plus recoveries and what each team member used, its helpers included. Select a team to see its finished
assignments with their outcome and the retro's verdict. Token totals across providers are
approximate.
