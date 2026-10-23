# Upstream sync

Satellite is a fork of `pingdotgg/t3code`. A sync merges `upstream/main` into Satellite's
integration branch. The rules that keep a sync small are in
[Satellite fork constraints](../internals/satellite-fork-constraints.md).

## Where Satellite touches upstream

Satellite registers its features through a few fork-owned modules. Each reaches an upstream file
through a line or two, so a conflict at one of those lines resolves by keeping both sides.

Each fork module or feature below names the upstream files it touches; keep both sides there.

| Fork module or feature    | Upstream file                                                                                     | The touch                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SatelliteServer.ts`      | `apps/server/src/server.ts`                                                                       | One `Layer.provideMerge` of its `layer`, with `layerPullRequestService` provided for the factory's control-path check, and `withMcpToolkits` in the `McpHttpServer` pipe |
| `SatelliteWsRpc.ts`       | `apps/server/src/ws.ts`                                                                           | Captures `makeConnectionLayer` and merges it per connection                                                                                                              |
| `SatelliteRpcRegistry.ts` | `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/observability/RpcInstrumentation.ts` | Spread the scope and aggregate-label tables                                                                                                                              |
| `satelliteRpc.ts`         | `packages/contracts/src/rpc.ts`, `packages/contracts/src/index.ts`                                | Spreads `SATELLITE_WS_METHODS`, merges `WsSatelliteRpcGroup`, and exports the Satellite contracts files                                                                  |
| `SatelliteMigrations.ts`  | `apps/server/src/persistence/Sqlite.ts`                                                           | Runs migrations through `runMigrationsWithSatellite`                                                                                                                     |
| Factory assignment digest | `packages/provider-core/src/server/textGeneration.ts`, `textGenerationOperations.ts`              | Optional `generateSummary` on `ProviderTextGeneration`, built in `fromRunner`                                                                                            |
| Factory assignment digest | `apps/server/src/textGeneration/TextGeneration.ts`                                                | Dispatches `generateSummary` to the selected instance                                                                                                                    |
| Factory assignment digest | `apps/server/src/provider/Drivers/CodexManagedProvider.ts`                                        | One `generateSummary` entry in the hand-wrapped operations                                                                                                               |
| Factory assignment digest | `packages/provider-opencode/src/server/textGeneration.ts`                                         | `generateSummary` in the operation literals of its error schemas                                                                                                         |

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
5. A conflict in a file listed in `scripts/rebrand-files.txt` resolves by taking upstream's side,
   running `node scripts/rebrand.ts`, then running `vp fmt` on the rewritten files, since the
   longer name can rewrap lines. For a file the list marks `hand-edited`, re-apply Satellite's
   other hunks for it afterwards. CI's `node scripts/rebrand.ts --check` catches a missed rerun,
   not a new upstream file that names T3 Code, so add such files to the list when the text is
   user-facing. A line that must keep upstream's name, such as text recorded in a replay
   fixture, carries a `rebrand:keep` comment.
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
