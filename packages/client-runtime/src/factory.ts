import { FACTORY_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "./connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./state/runtime.ts";

export function createFactoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factory:snapshot",
      tag: FACTORY_WS_METHODS.getSnapshot,
    }),
    live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:factory:live",
      tag: FACTORY_WS_METHODS.subscribe,
    }),
    dispatch: createEnvironmentRpcCommand(runtime, {
      label: "factory:dispatch",
      tag: FACTORY_WS_METHODS.dispatchCommand,
    }),
  };
}
