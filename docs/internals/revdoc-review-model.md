# Revdoc review model

Status: accepted.

Revdoc keeps one living checklist for each worktree so that a person and agents can review the same
changes over several days. This record fixes how that checklist is owned and reconciled. Terms are
defined in the [glossary](./glossary.md#revdoc).

## Decision

- **One Review per worktree.** A Review is keyed by project and worktree. Every thread in the
  worktree shares it.
- **A generation pass is an upsert.** The pass receives the current Review and returns items. New
  items are added. Unchanged items keep their outcome and note. Items whose check text or covered
  code changed drop to needs retest and keep the note. Items the pass no longer proposes become
  stale; they are marked, not deleted, until the person dismisses them.
- **The database arbitrates.** The Review is service-owned and stored in the database. Every write
  carries the revision it was based on. A pass that lands on a Review edited during the run is
  rejected and reports a conflict.
- **`.revdoc/review.json` is an export.** It is written after every change for agents and tools
  without MCP access. The service never reads it back.
- **Reviews are transient.** When the worktree goes, the Review goes. There is no archive.

## Reason

The case that decided this is the maintainer's Friday case. On Friday a person half-reviews a
worktree, marks some items broken, and requests changes on others. Over the weekend an agent fixes
them. On Monday a new generation pass runs. The Review must come through with the person's
outcomes and notes intact, the fixed items flagged for retest, and no second document stacked on
top of the first.

A file-arbitrated design loses that case. Two writers race on the file, and the last write wins. A
design with one document per pass loses it too, because Monday's document does not carry Friday's
outcomes. One service-owned Review per worktree, reconciled by upsert against a revision, keeps
them.
