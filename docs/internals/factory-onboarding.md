# Factory onboarding

Onboarding turns what a manager learns about a project into configuration the factory acts on. The
first real onboarding showed what goes wrong when it does not. The manager free-typed a report, the
user answered its open choices in chat, and pickup then offered 30 Backlog tickets as Ready. The
board's Issues mapping counted Backlog as Ready, and nobody was shown that. Terms are in the
[glossary](./glossary.md#factory).

## The result is configuration, not a report

What the user approves is the manager's onboarding result: purpose, pickup switch, pickup columns,
pickup guidance, project rules and control paths. It is stored on the
manager and lives as long as the manager does. The proposal that produced it is discarded on
approval, and so are the manager's findings. Findings describe the project as it was that day and
turn into noise within a week.

Open choices are questions with options. The user's answers are stored as project rules beside
their question. A rule is only worth asking if every lead should read it, so rules render into the
manager's and its leads' role skills rather than living in the manager's memory. Purpose, pickup
and rules form one project section, appended after the role skill is rendered
([`projectSection`](../../apps/server/src/factory/roleSkills.ts)).

The result is per project and never part of portable factory configuration. Where it names factory
things, such as the teams a manager may use, it refers to them by id.

## Satellite detects what it acts on

Every fact a setting depends on comes from Satellite, not from the manager's reading. Satellite
reads each board's Ready columns with their titles, the labels on its items, and the repository's
default branch, and stores them with the proposal. Approval checks pickup columns against the live
board again, because the mapping can change between proposal and approval. Facts Satellite does not
act on, such as branch protection, stay manager findings.

## Pickup is opt-in and narrower than Start

The Issues Ready set answers "what may I start by hand". Pickup answers "what may a manager take on
its own", which deserves a narrower, explicit yes. Pickup columns are therefore a choice within the
Ready set and never inherit it. Pickup is off unless the user turns it on. A pickup column that
stops being a Ready column is ignored rather than replaced. User-requested work can still name any
Ready ticket.

## Approval primes a fresh thread

A provider conversation cannot be reset inside a thread, and an onboarding transcript is mostly file
reads the manager should not carry forward. Approval therefore launches a new manager thread whose
first message is the role skill and the project section, points the manager at it, and settles the
onboarding thread. What the manager knows after onboarding is then exactly what the user approved.
The client swaps the new thread into the current view with a history replace. Approval never starts
pickup. A manager with pickup on waits in the `ready` state until the user starts it, so the first
tickets it takes are ones the user chose to let it take.

## Control paths are the project's

What must not change in a project, such as CI workflows and lint configuration, is a fact about the
project. The manager therefore proposes a structured list of paths with a reason for each, and the
user confirms it.
