# Satellite fork constraints

Satellite is re-ported onto upstream T3 Code and merges upstream forward. These rules keep that
merge cheap and keep upstream's clients working against a Satellite server. Each rule names the
mistake it prevents. The procedure for a sync is in the [upstream sync runbook](../operations/upstream-sync.md).

## Mobile wire compatibility

The official T3 Code mobile app connects to Satellite servers. Satellite does not ship its own
mobile client and makes no changes to `apps/mobile`, so every contract the mobile app reads must
keep upstream's shape.

- Satellite contract changes are additive only: new WS methods, new union members, and new optional
  fields. Never rename, remove, or reshape an upstream contract, and never make an upstream optional
  field required.
- Satellite keeps upstream's `ORCHESTRATION_PROTOCOL_VERSION` in
  [`environment.ts`](../../packages/contracts/src/environment.ts) and follows upstream's bumps. A
  Satellite-only bump would make upstream clients treat the server as incompatible.
- Web and mobile tests run in CI because they are the cheapest check that a contract change stayed
  additive.

## Release version

The mobile app checks upstream's CLI releases and offers a server update when upstream's newest
version is greater than the version the server reports. See `findEnvironmentUpdate` in
[`environment-maintenance.ts`](../../apps/mobile/src/features/settings/environment-maintenance.ts).
A Satellite server reporting a lower version than upstream would be offered an upstream update that
replaces Satellite.

Satellite's major version therefore stays above upstream's major. That is why Satellite 2.x ships
while upstream is at 0.x. If upstream's major ever reaches Satellite's, Satellite bumps its major
before its next release. Do not propose version schemes that track upstream's numbers.

## Migration ledger

Upstream's migrator records each migration's id and name in `effect_sql_migrations`. It skips every
id up to the highest one recorded, whatever name was recorded there. From the first V2 migration
(id 55) on, `assertV2MigrationsCanRun` in
[`Migrations.ts`](../../apps/server/src/persistence/Migrations.ts) refuses to start when a recorded
name differs from upstream's.

Any Satellite id in upstream's list therefore collides with a future upstream migration, and
renumbering upstream's migrations to make room breaks every database that later meets upstream's
numbering. Satellite migrations run from their own Satellite table with their own ids. Never add an
id to upstream's migration list and never renumber an upstream migration.

Satellite's schema lives in `satellite_migrations`. The Satellite migrator in
[`SatelliteMigrations.ts`](../../apps/server/src/satellite/persistence/SatelliteMigrations.ts) is
Effect's migrator on that table, run after upstream's from the one migration call in
[`Sqlite.ts`](../../apps/server/src/persistence/Sqlite.ts). It has the same skip rule, so Satellite
ids start at 100 and the migrator refuses a lower id at startup. A Satellite migration at 55 to 99
would run on fresh installs and be skipped on upgraded ones.

Ids 55 to 69 in `satellite_migrations` are records of what a database once ran, never pending work.
Satellite 1.x recorded 55 to 60 in upstream's table (55 to 62 from v1.1.12). Dev builds since
2026-10-09 also recorded upstream's V2 migrations at 63 to 66 and their own at 67 to 69.
[`repairSatelliteLegacyLedger.ts`](../../apps/server/src/satellite/persistence/repairSatelliteLegacyLedger.ts)
moves those rows into `satellite_migrations` with their ids, names and timestamps, renumbers 63 to 66
back to upstream's 55 to 58, drops the schema of features the port does not carry, and keeps the
issue board tables for the boards migration. It runs in one transaction on `statev2.sqlite` after
upstream's copy from `state.sqlite` (see [legacy orchestration migration](./legacy-orchestration-migration.md))
and before upstream's migrator. It is the only Satellite code that writes upstream's ledger, and it
matches exact id and name pairs so it never touches a row upstream wrote.

## Confined footprint

Satellite code is additive. Features are new services, new contracts files, new web components,
and new MCP tools. Edits to upstream files are limited to registration points:

- handler tables, RPC groups, and method tables
- route lists and layer composition in the server entry
- authorization and instrumentation tables
- settings schema extensions
- one mount in the web root route
- the one persistence seam that runs Satellite migrations and the ledger repair

Every PR lists the upstream files it edits and why. Measure the footprint as the number of upstream
files Satellite modifies or deletes relative to the upstream merge base:

```bash
git fetch upstream
git diff --name-only --no-renames --diff-filter=MD "$(git merge-base HEAD upstream/main)" HEAD | wc -l
```

Run it before and after a change. Growth outside registration points needs a reason in the PR.

## Registration module shape

Satellite reaches upstream through a small set of fork-owned modules. Each touches an upstream file
through a line or two, so a merge conflict at that line resolves by keeping both sides. Later
features register through these modules instead of editing upstream handler code.

- [`SatelliteServer.ts`](../../apps/server/src/satellite/SatelliteServer.ts) provides Satellite's
  services, reactors and startup steps as `layer`, which `server.ts` provides with one
  `Layer.provideMerge`, and its MCP toolkits through `withMcpToolkits`, one line in the
  `McpHttpServer.layer` pipe. HTTP routes join it with the first feature that needs one.
- [`SatelliteWsRpc.ts`](../../apps/server/src/satellite/SatelliteWsRpc.ts) provides Satellite
  handlers. `ws.ts` captures `makeConnectionLayer` once, merges its layer per connection, and builds
  upstream's handlers from `WsCoreRpcGroup`.
- [`SatelliteRpcRegistry.ts`](../../apps/server/src/satellite/SatelliteRpcRegistry.ts) holds
  Satellite's scope table and aggregate-label table, each typed to need one entry per Satellite
  method. `RpcAuthorization.ts` and `RpcInstrumentation.ts` spread them.
- [`satelliteRpc.ts`](../../packages/contracts/src/satelliteRpc.ts) holds Satellite methods.
  `rpc.ts` spreads `SATELLITE_WS_METHODS` into `WS_METHODS` and defines `WsRpcGroup` as upstream's
  `WsCoreRpcGroup` merged with `WsSatelliteRpcGroup`. The client runtime resubscribes its stream
  methods on reconnect through `SatelliteWsSubscriptionMethod`.
- One product identity contract holds the names, icons, and update feed that every surface reads.
- One web root coordinator component holds Satellite's app-level effects. It mounts once in
  upstream's root route.

The last two arrive with the first change that needs them.
[`SatelliteRpcRegistration.test.ts`](../../apps/server/src/satellite/SatelliteRpcRegistration.test.ts)
fails when a Satellite method lacks a scope, a label, or a handler, or shadows an upstream method.

For scale, these touch points on Satellite's pre-port main measured +5/-2 lines in the RPC
contracts file, +11 in the server file, +7/-1 in authorization, +2 in instrumentation, and +2 in the
web root route. A WS handler edit is a few lines. A large diff in an upstream file means the feature
is not registered through its module.
