# Factory config

The factory config is the user's portable factory: workers, leads, managers, teams, the model pool
and the recovery allowance. One config serves many projects and travels between machines, so it
holds nothing that belongs to a project, a machine or a credential. Terms are defined in the
[glossary](./glossary.md#factory).

## Files, not database rows

The config lives in files under `<T3 home>/factory/` on the environment that runs the factory, one
Markdown file per definition with YAML frontmatter:

```
factory/
  factory.yaml                          # format version, model pool, recovery allowance
  workers/<id>.md                       # name, model list; body is the worker's description
  leads/<id>.md                         # body is added to the fixed lead protocol
  managers/<id>.md                      # body is added to the fixed manager protocol
  teams/<id>/team.md                    # name, use-when; body is how the team works
  teams/<id>/lead.md                    # this team's copy of a lead
  teams/<id>/members/<id>.md            # a copy of a worker, plus its count
```

Why files: definitions are prose prompts that the user and agents edit, diff and share. A directory
of small files merges cleanly in Git when two machines change different definitions, and makes
"change every copy" a text search. A single JSON document or database rows would put prompts in
escaped strings and turn every edit into a conflict on one record.

The file or folder name is the definition's id. It is derived from the name at creation and never
changes; renaming edits only `name`. Projects refer to teams by this id.

Files Satellite writes must be byte-stable: fixed key order, LF endings, no timestamps, generated
ids, absolute paths or machine names. Re-saving an unchanged definition produces no diff. A file
that fails to decode is reported and skipped; the rest of the config keeps working.

## Copies, not references

A team holds copies of the worker and lead definitions it was built from, and a project's manager
holds a copy of its manager definition. Editing a definition never changes an existing copy. This
is deliberate: a team's members are exactly what its files say, a team exports whole, and deleting
or renaming a definition can never break a team. To land a change everywhere, edit every copy.

## Models are portable names

Definitions name models as `driver/model` with optional options, never a provider instance id,
which differs between machines. A definition's model list is a priority order: the first entry the
environment can run is used. A **dynamic** list is instead a menu the starter of the agent picks
from per task: the lead for a team member, the manager for a team's lead. Briefs list only the
entries the environment can run.

The model pool in `factory.yaml` is the factory-wide allow-list and cost guard. Every listed model
must be in it, and imports cannot widen it without the user's say-so. On each environment the
usable pool is the pool filtered to what that environment can run.

## What stays out of the config

| Kept elsewhere                                                               | Owner                                |
| ---------------------------------------------------------------------------- | ------------------------------------ |
| Protected paths, pickup guidance, project rules, teams used, concurrency cap | The manager's onboarding result      |
| A manager's own instructions and models                                      | The manager record                   |
| Environment concurrency cap, digest interval                                 | The environment, in its database     |
| Git identity and every secret                                                | The environment and its secret store |

There are no project-level overrides of definitions, and project role-skill files
(`.satellite/factory/roles/`) are retired. A project that needs a variant team gets its own team in
the factory config. Where the two meet, an onboarding result names teams by id, and deleting a team
warns with every manager whose result lists it.

Two limits gate a new assignment and both must have room: the environment's cap, counted across
all projects, and the manager's cap from its onboarding result. The factory enforces both.

## Protected paths and exempt teams

The project lists the paths no team may edit. A team whose job is the workflow itself sets
`mayEditProtectedPaths: true` in its `team.md`, and an assignment staffed by that team skips the
protected-path check. The flag is portable because it describes the team, not the project. The
assignment's team snapshot carries it, so editing the team cannot change a running check.

## Briefs

A manager's or lead's brief is the fixed protocol, then the instructions from its definition copy,
then the project section the onboarding result renders: purpose, pickup guidance and project
rules. A team member's brief is its description followed by the same project section. The factory
config never edits the project section.

## The optional config repo

The config directory can be a checkout of a Git repository the user connects. Sync is manual:
saving only writes files, **Push** commits all local changes as one commit and pushes, **Pull**
fetches and replays local changes on top, and **Discard local changes** resets to the last pull.
Local edits are experiments until pushed; the repo is the confirmed copy. A file changed on both
sides stops the pull and asks; nothing is discarded silently. Git runs on the environment with its
own credentials; Satellite stores no token. Agents never pull or push.

Disconnecting keeps the files and removes the checkout, warning first about unpushed changes.

## Export and import

An export is built from definitions, never by archiving the directory, so `.git`, scratch files and
anything in the table above cannot leak. An import previews each definition as new, same or
different, merges by default with a per-definition choice (keep mine, take theirs, keep both), and
offers replace with a backup. An import is a local change like any other.

## Migration from the database

Environments that saved a factory config before this format get files written once at startup
when `factory.yaml` is missing. Role allow-lists become dynamic starter workers, lead models by
size become a dynamic default lead, and each preset becomes a team of copies. Environment role-skill
files at `<T3 home>/factory/roles/<role>.md`, the old override location, become the instructions of
the matching starter worker, default lead or default manager, and the `roles/` folder is removed
once they are written. The concurrency cap seeds the environment cap only. Manager caps and pickup
guidance move with the onboarding result's own migration. The database row is kept as the rollback
copy, and project overrides with no new home are shown to the user rather than dropped.
