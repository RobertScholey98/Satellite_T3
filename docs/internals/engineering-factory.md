# Engineering factory

The factory (`apps/server/src/factory`) runs engineering managers and their teams. It also adds
checks to orchestration code that every thread uses. This page covers the constraints that span
those boundaries. For the user-facing behaviour, see [engineering managers](../user/engineering-managers.md).

## Confinement

- A managed thread runs only inside its Docker boundary.
  [`RuntimePolicyV2`](../../apps/server/src/orchestration-v2/RuntimePolicy.ts) asks
  `ThreadGovernance.confinementFor` about every thread, which the factory answers with
  `FactoryExecution.runtimePolicyFor`. When that returns a confinement, Codex starts in the
  container through `ConfinedProviderLaunch`, which the factory implements with
  [`prepareFactoryLaunch`](../../apps/server/src/factory/FactoryConfinedLaunch.ts), and every
  other driver is refused. Runtime-policy overrides skip managed threads. Never add a
  host fallback. A failed launch must surface as a failure.
- The host never reads or writes an assignment volume directly. Volume access goes through
  [`FactoryVolumeHelper`](../../apps/server/src/factory/FactoryVolumeHelper.ts), which runs in a
  short-lived container with no network and a read-only root.
- Authority holds are files in the boundary's authority directory: revocation, suspension,
  incidents, integration holds and delivery holds. Two places check them:
  [`assertFactoryProfileActive`](../../apps/server/src/factory/FactoryProfileAuthority.ts) on the
  host, and the volume helper inside its container. A new kind of hold needs both checks.
- Protected controls cannot be changed from inside the boundary. `/controls` and `/workflow` are
  mounted read-only. [`factoryProtectedPath`](../../apps/server/src/factory/FactoryBoundaryPaths.ts)
  covers configuration files, agent instructions, and files that tools load without an explicit
  import. An agent can write one of these only with a control-change grant.
- Native Codex subagents are disabled. They would run in the same container, but `spawn_agent`
  accepts any catalog model and reasoning effort, even when its schema hides those arguments. That
  choice never reaches [`FactoryModelAdmission`](../../apps/server/src/factory/FactoryModelAdmission.ts),
  so teams delegate with `delegate_task`. When you bump `FACTORY_AGENT_IMAGE`, rerun the live probe
  in `FactoryCodexLaunch.test.ts`.
- The model credential is inside the container, and the container has network access. A shell
  command can still call a model directly. The model policy governs supported delegation paths
  only. Do not describe it as spend enforcement.

## Lineage

[`resolveFactoryLineage`](../../apps/server/src/factory/FactoryLineage.ts) decides which factory
record owns a thread. Every access check uses it.

- A subagent child inherits its parent's assignment, boundary, model policy and controls. A child
  that has not been projected yet resolves through its pending parent.
- A fork is an ordinary thread that a human created. The lineage walk stops at a fork edge. Do not
  make forks inherit factory policy.
- A broken chain fails closed only in a managed project. A broken chain is a deleted or missing
  ancestor, an orphaned subagent, a chain that crosses projects, or a cycle or implausibly deep
  chain. Elsewhere the thread is ordinary, so the factory never blocks unrelated work.
- With no managers, resolution reads nothing. Keep these checks cheap for people who never use the
  factory.

## Gates in shared orchestration

Shared code imports nothing from the factory. It asks seams that core owns, and the factory
implements them:
[`ThreadGovernance`](../../apps/server/src/orchestration-v2/ThreadGovernance.ts) for direction,
confinement, model admission and restart ownership,
[`ConfinedProviderLaunch`](../../apps/server/src/orchestration-v2/Adapters/ConfinedProviderLaunch.ts)
for the container launch and its authority checks, and
[`PullRequestActionGate`](../../apps/server/src/pullRequest/PullRequestActionGate.ts) for actions on
managed PRs. These shared paths consult them:

- [`Orchestrator`](../../apps/server/src/orchestration-v2/Orchestrator.ts) checks who may direct a
  thread.
- [`ProviderTurnStartService`](../../apps/server/src/orchestration-v2/ProviderTurnStartService.ts)
  admits each turn start.
- [`EffectWorker`](../../apps/server/src/orchestration-v2/EffectWorker.ts) and
  [`ProviderRuntimeRecoveryService`](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
  hand restart recovery to the factory.
- [`CheckpointService`](../../apps/server/src/orchestration-v2/CheckpointService.ts) excludes
  managed threads from host checkpoints.
- [`PullRequestService`](../../apps/server/src/pullRequest/PullRequestService.ts) routes actions on
  managed PRs through the factory gate.
- [`OrchestratorMcpService`](../../apps/server/src/mcp/OrchestratorMcpService.ts) and
  [`FactoryMcpGuard`](../../apps/server/src/factory/FactoryMcpGuard.ts) limit managed tool calls.

A new path that starts, continues or directs provider work, or that acts on a managed PR, needs the
same check.

## Server composition must stay type-checked

A missing layer in `server.ts` is a compile error at `runServer`, and only the compiler catches
it reliably. Effect builds a layer once per reference, so a layer provided in one branch can
satisfy a requirement that another branch forgot, and the server still boots. Keep the WebSocket
handlers split into the core and Satellite layers in `ws.ts`. A single `toLayer` over every RPC
exceeds the compiler's instantiation limit. tsgo then drops the error and widens the server's
requirements to `any` (TS377030), so a missing layer compiles again.

The seams are required services, so a missing factory layer is a compile error rather than a gate
that silently switches off. `ThreadGovernance.test.ts` checks that each shared path still requires
its seam. Never read a seam through `Effect.serviceOption`. Each seam has an admit-everything
default (`layerUngoverned`, `layerUnconfined`, `layerUnmanaged`) for tests and compositions without
managers. Only `server.ts` provides the factory's layers; providing a default inside a core
composition layer would silently replace them.

## State storage

Known limit: factory state is one JSON row (`factory_state`) that every command rewrites and every
subscribed client receives whole, because the decider works on the full snapshot; moving to an
event log or normalized tables would need per-entity storage and client deltas.

## Deployment signal

Merge groups tell deployment pipelines when to wait. Satellite labels each member PR
`satellite-merge-group` and sets a `satellite/merge-group` commit status on member heads and merge
commits. The [contracts](../../packages/contracts/src/factoryMerge.ts) define both names.

- Users copy [`merge-group-gate.mjs`](../../scripts/factory/merge-group-gate.mjs) into their own
  repositories, and it has its own copy of both names. Treat them as a public API, because renaming
  either one breaks gates that Satellite cannot update. Keep the script free of dependencies and
  limited to reads.
- The gate treats a commit with no labelled PR as ungrouped and lets it deploy. That is why
  [`FactoryMergeOperation`](../../apps/server/src/factory/FactoryMergeOperation.ts) refuses to merge
  a member until GitHub confirms its label. When a PR leaves its group, remove its label, or its own
  deployment waits until the gate times out.
- [`FactoryMergeSignal`](../../apps/server/src/factory/FactoryMergeSignal.ts) reads GitHub before
  each write, so a replay after a restart repeats nothing. New signal writes must do the same.
