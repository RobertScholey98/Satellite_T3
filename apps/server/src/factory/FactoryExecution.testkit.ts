import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { FactoryExecution } from "./FactoryExecution.ts";

export const layerUnmanaged = Layer.succeed(FactoryExecution, {
  runtimePolicyFor: () => Effect.succeed(undefined),
  assertSelectionFor: () => Effect.void,
  assertDelegationFor: () => Effect.void,
  qualify: () => Effect.die("This fixture cannot qualify managed factory execution."),
});
