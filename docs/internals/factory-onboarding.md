# Factory onboarding

Onboarding turns what an engineering manager learns about a project into configuration the
factory acts on. The first real onboarding showed what goes wrong when it does not: the manager
free-typed a report, the user answered its open choices in chat, and pickup then offered 30
Backlog tickets as Ready because the board's Issues mapping counted Backlog as Ready and nobody
was shown that. Terms are in the [glossary](./glossary.md#factory).

## The result is configuration, not a report

What the user approves is the manager's onboarding result: purpose, pickup switch, pickup scope,
pickup guidance, base branch, project rules, control paths, teams used and the manager's
concurrency cap. It is stored on the manager and lives as long as
the manager does. The proposal that produced it is discarded on approval, and so are the
manager's findings, which describe the project as it was that day and turn into noise within a
week.

Open choices are questions with options, answered on the card and stored as project rules beside
their question. A rule is only worth asking if every lead should read it, so rules render into the
manager's and its leads' role skills rather than living in the manager's memory. Purpose, pickup
guidance and rules form one project section appended after the role skill is rendered. Role
skills themselves come from the [factory config](./factory-config.md), which holds nothing
project-specific, so the project section is the only place a project shapes its agents.

The result is per project and stays out of the factory config. Where it names factory things, it
refers to them: teams used is a list of team ids, empty meaning all, and the config's team
definitions stay the only copy.

## Satellite detects what it acts on

Every fact a setting depends on comes from Satellite, not from the manager's reading: the board's
Ready columns and their titles, the labels on its items, and the repository's default branch. The
manager proposes; the card shows Satellite's own view next to the proposal. That is what makes the
Backlog mistake visible before approval instead of after. Facts Satellite does not act on, such as
branch protection, stay manager findings.

## Pickup is opt-in and narrower than Start

The Issues Ready set answers "what may I start by hand". Pickup answers "what may a manager take
on its own", which deserves a narrower, explicit yes, so pickup scope is a choice within the Ready
set and never inherits it. Pickup is off unless the user turns it on, and approval never starts it;
the user does, from the primed thread.

A project may have several managers. They divide tickets by label: columns may be shared, a label
belongs to one live manager, a manager with pickup on needs at least one label, and a ticket
carrying two managers' labels is skipped by both. Satellite refuses an overlapping scope at
approval or edit, because a race between two managers judging the same ticket cannot be undone on
the board.

## Approval primes a fresh thread

A provider conversation cannot be reset inside a thread, and an onboarding transcript is mostly
file reads the manager should not carry forward. Approval therefore creates a new manager thread,
primed only from the stored result, and swaps it into the current view with a history replace. The
onboarding thread ends as a read-only record. Re-onboarding runs the same swap from a new
onboarding thread seeded with the current result; cancelling it returns to the previous thread
unchanged.

## Control paths are the project's, exemptions are the team's

What must not change in a project, such as CI workflows and lint configuration, is a fact about the
project, so the manager proposes a structured list of paths with a reason for each and the user
confirms it on the card. A team whose job is the workflow itself would be blocked by that list, so a
team definition can carry a portable flag that lets it edit protected paths. The list lives with the
project; the flag lives with the team, because it describes what the team is for.
