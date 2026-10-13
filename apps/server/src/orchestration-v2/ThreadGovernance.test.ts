import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import type * as Layer from "effect/Layer";

import type * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import type * as PullRequestActionGate from "../pullRequest/PullRequestActionGate.ts";
import type * as PullRequestService from "../pullRequest/PullRequestService.ts";
import type * as CodexAdapterV2 from "./Adapters/CodexAdapterV2.ts";
import type * as ConfinedProviderLaunch from "./Adapters/ConfinedProviderLaunch.ts";
import type * as CheckpointService from "./CheckpointService.ts";
import type * as EffectWorker from "./EffectWorker.ts";
import type * as Orchestrator from "./Orchestrator.ts";
import type * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import type * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import type * as RuntimePolicy from "./RuntimePolicy.ts";
import { directionSender, type ThreadGovernance } from "./ThreadGovernance.ts";

type Requires<L extends Layer.Any, Service> = [Service] extends [Layer.Services<L>] ? true : false;

it("cannot compose a shared path without its governance", () => {
  // Checked by the type checker: a gate read as an optional service would switch off silently
  // when its layer is missing, so each shared path must require its gate.
  const required: ReadonlyArray<true> = [
    true satisfies Requires<typeof Orchestrator.layer, ThreadGovernance>,
    true satisfies Requires<typeof ProviderTurnStartService.layer, ThreadGovernance>,
    true satisfies Requires<typeof EffectWorker.layerExecutor, ThreadGovernance>,
    true satisfies Requires<typeof CheckpointService.layer, ThreadGovernance>,
    true satisfies Requires<typeof ProviderRuntimeRecoveryService.layer, ThreadGovernance>,
    true satisfies Requires<typeof RuntimePolicy.layerFromProjectStore, ThreadGovernance>,
    true satisfies Requires<typeof OrchestratorMcpService.layer, ThreadGovernance>,
    true satisfies Requires<
      typeof CodexAdapterV2.layerAppServerClientFactory,
      ConfinedProviderLaunch.ConfinedProviderLaunch
    >,
    true satisfies Requires<
      typeof PullRequestService.layer,
      PullRequestActionGate.PullRequestActionGate
    >,
  ];
  assert.lengthOf(required, 9);
});

it("uses actual human provenance and treats scheduled or unowned messages as automation", () => {
  const managerId = ThreadId.make("manager");
  assert.equal(directionSender({ createdBy: "user" }), undefined);
  assert.equal(directionSender({ createdBy: "system" }), null);
  assert.equal(directionSender({ createdBy: "user", senderThreadId: managerId }), managerId);
});
