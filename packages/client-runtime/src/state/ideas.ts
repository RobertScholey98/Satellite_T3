import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as Data from "effect/Data";
export class IdeaHttpConnectionNotReadyError extends Data.TaggedError(
  "IdeaHttpConnectionNotReadyError",
)<{ readonly message: string }> {}
import { IdeaArtifactHttp } from "./ideaArtifactHttp.ts";
export { IdeaArtifactHttp, ideaArtifactHttpLayer } from "./ideaArtifactHttp.ts";
import {
  IDEA_WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  IdeaArtifactReadInput,
  IdeaArtifactWriteInput,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createIdeaEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | IdeaArtifactHttp | R, E>,
) {
  const changes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:ideas:changes",
    tag: IDEA_WS_METHODS.subscribeChanges,
  });
  return {
    changes,
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:ideas:list",
      tag: IDEA_WS_METHODS.list,
      staleTimeMs: 0,
      refreshTrigger: ({ environmentId }) => changes({ environmentId, input: {} }),
    }),
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:ideas:get",
      tag: IDEA_WS_METHODS.get,
      staleTimeMs: 0,
      refreshTrigger: ({ environmentId }) => changes({ environmentId, input: {} }),
    }),
    readArtifact: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:ideas:artifact",
      idleTtlMs: 0,
      execute: (input: typeof IdeaArtifactReadInput.Type) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared))
            return yield* new IdeaHttpConnectionNotReadyError({
              message: "The environment HTTP connection is not ready.",
            });
          return yield* (yield* IdeaArtifactHttp).read(prepared.value, input);
        }),
    }),
    writeArtifact: createEnvironmentCommand(runtime, {
      label: "environment-data:ideas:upload",
      execute: (input: typeof IdeaArtifactWriteInput.Type) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared))
            return yield* new IdeaHttpConnectionNotReadyError({
              message: "The environment HTTP connection is not ready.",
            });
          return yield* (yield* IdeaArtifactHttp).write(prepared.value, input);
        }),
    }),
    dispatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ideas:edit",
      tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    }),
  };
}
