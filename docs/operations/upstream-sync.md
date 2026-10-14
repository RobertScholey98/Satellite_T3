# Upstream sync

Satellite is a fork of `pingdotgg/t3code`. A sync merges `upstream/main` into `main`.

## Where Satellite touches upstream

Satellite registers its features through a few fork-owned modules. Each reaches an upstream file
through a line or two, so a conflict there resolves by keeping both sides. Product names that
surfaces read come from `PRODUCT_NAME` in `packages/contracts/src/productIdentity.ts`.

| Fork module                                              | Upstream line                                             |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `packages/contracts/src/satelliteRpc.ts`                 | `WS_METHODS` spread and `WsRpcGroup` merge in `rpc.ts`    |
| `apps/server/src/satellite/SatelliteWsRpc.ts`            | handler layer capture and merge in `ws.ts`                |
| `apps/server/src/satellite/SatelliteRpcRegistry.ts`      | spreads in `RpcAuthorization.ts`, `RpcInstrumentation.ts` |
| `apps/server/src/satellite/SatelliteServer.ts`           | `Layer.provideMerge` and MCP pipe in `server.ts`          |
| `apps/web/src/components/SatelliteRootCoordinators.tsx`  | one mount in `routes/__root.tsx`                          |
| `apps/mobile/src/features/satellite/satelliteScreens.ts` | one spread in `Stack.tsx`                                 |

## Procedure

1. Fetch and merge:

   ```bash
   git fetch upstream
   git merge upstream/main
   ```

2. For each conflicted file listed in `scripts/rebrand-files.txt` that differs from upstream only by
   the product name, take upstream's side: `git checkout --theirs <file>`.
3. Run `node scripts/rebrand.ts`. It rewrites upstream's product name in every listed file.
4. Resolve the remaining conflicts by hand. These are real behaviour changes.
5. Run `node scripts/rebrand.ts --check`. CI runs the same check and fails on any listed file that
   still names upstream's product.

To rebrand a file that upstream adds, add its path to `scripts/rebrand-files.txt` and rerun the
script.

`node scripts/fork-footprint.ts` reports how many upstream files Satellite modifies, how many of
those the rebrand script reproduces, and the lines Satellite adds at each registration point. Run it
before and after a sync to see whether the fork's footprint grew.
