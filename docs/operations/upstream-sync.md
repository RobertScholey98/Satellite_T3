# Upstream sync

Satellite is a fork of `pingdotgg/t3code`. A sync merges `upstream/main` into Satellite's
integration branch. The rules that keep a sync small are in
[Satellite fork constraints](../internals/satellite-fork-constraints.md).

## Where Satellite touches upstream

Satellite registers its features through a few fork-owned modules. Each reaches an upstream file
through a line or two, so a conflict at one of those lines resolves by keeping both sides.

No fork module is registered yet. The first change that adds one starts a table here naming each
fork module and the upstream line it touches, and every later registration adds its row.

## Procedure

1. Add the upstream remote once, then fetch and merge:

   ```bash
   git remote add upstream https://github.com/pingdotgg/t3code.git
   git fetch upstream
   git merge upstream/main
   ```

2. A conflict at a registration line listed above resolves by keeping both sides.
3. A modify/delete conflict on a workflow or helper that Satellite deleted resolves by keeping the
   deletion: `git rm <file>`.
4. Upstream migrations are never renumbered. Satellite migrations live in their own table, so a new
   upstream migration merges as-is.
5. A conflict in a file listed in `scripts/rebrand-files.txt` that differs only in the product
   name resolves by taking upstream's side and running `node scripts/rebrand.ts`. CI's
   `node scripts/rebrand.ts --check` catches a missed rerun, not a new upstream file that names
   T3 Code, so add such files to the list when the text is user-facing.
6. An identity seam (a name, home directory, profile, app id, icon, or release URL) resolves by
   taking upstream's line and reading the value from
   [`productIdentity.ts`](../../packages/contracts/src/productIdentity.ts) again.
   `scripts/lib/product-identity-consumers.test.ts` fails when a static file drifts from it or a
   source defaults to upstream's releases.
7. Resolve the remaining conflicts by hand. These are real behavior changes.

Report the footprint before and after a sync. It counts the upstream files Satellite modifies or
deletes relative to the upstream merge base:

```bash
git diff --name-only --no-renames --diff-filter=MD "$(git merge-base HEAD upstream/main)" HEAD | wc -l
```

If the count grows, find the new files with the same command without `| wc -l` and check that each
one is a registration point.
