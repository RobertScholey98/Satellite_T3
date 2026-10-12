import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryExecution from "./FactoryExecution.ts";

// The factory's own gates as an environment with no managers sees them: no thread is managed, so
// every gate admits. Core tests use `ThreadGovernance.layerUngoverned` instead.
export const layerUnmanagedExecution = Layer.succeed(FactoryExecution.FactoryExecution, {
  runtimePolicyFor: () => Effect.succeed(undefined),
  assertSelectionFor: () => Effect.void,
  assertDelegationFor: () => Effect.void,
  qualify: () => Effect.die("This fixture cannot qualify managed factory execution."),
});

export const layerUnmanagedControls = Layer.succeed(FactoryControlAccess.FactoryControlAccess, {
  membership: () => Effect.succeed(undefined),
  assertExecution: () => Effect.void,
  assertDirection: () => Effect.void,
});
