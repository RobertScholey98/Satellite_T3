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

## Implementation

- [`RevdocReconcile.ts`](../../apps/server/src/revdoc/RevdocReconcile.ts) applies the rules above
  as one pure function; its literal fixtures sit beside it. Needs retest is derived on read in
  [`RevdocFingerprint.ts`](../../apps/server/src/revdoc/RevdocFingerprint.ts) from the fingerprints
  an outcome or result was recorded against. The person's outcome wins over an older AI result, so a
  new outcome clears the marker.
- [`RevdocStore.ts`](../../apps/server/src/revdoc/RevdocStore.ts) commits every change in one
  transaction that checks the expected revision. The tables are Satellite migration 100. Passes
  are keyed by worktree, not by Review, because the first generation pass runs before its Review
  exists.
- A batched generation pass commits partial upserts that never stale, and saves each batch on its
  pass row with the server ids its partial commit assigned. That is what lets a resumed pass
  match the checks it already created instead of adding duplicates.
- Generation calls upstream's text generation through the optional `generateStructured` operation.
  Providers that cannot run it leave it out (ACP registry, Muse) or refuse it (OpenCode 2).
- A test pass is an upstream delegated task. Upstream accepts delegation only under an active parent
  run, so a pass started from an idle thread first posts a short kick-off message. Each later section
  is a follow-up message to the same child. The pass advances when the section's delegated task row
  on the parent settles, not when the child's run ends. Upstream records a follow-up as a new row
  only after the previous row has its result, so advancing on the run end loses that row.
- Worktree removal reaches Revdoc through a decorated git workflow service that
  [`SatelliteServer.ts`](../../apps/server/src/satellite/SatelliteServer.ts) provides above
  upstream's transports. Settled-worktree cleanup removes worktrees with raw git, so the lifecycle
  reactor listens to its report stream instead.
