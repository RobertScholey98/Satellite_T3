import { type OpenWorkListInput, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** The environment's server has no Open work methods, such as an upstream T3 Code server. */
export class OpenWorkUnsupportedError extends Schema.TaggedError<OpenWorkUnsupportedError>()(
  "OpenWorkUnsupportedError",
  {},
) {
  override get message(): string {
    return "This environment does not support Open work.";
  }
}

const isUnknownRequestTag = (defect: unknown) =>
  typeof defect === "string" && defect.startsWith("Unknown request tag:");

/** Open work queries. No refresh interval: the view rereads on demand. */
export function createOpenWorkEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:open-work:list",
      execute: (input: OpenWorkListInput) =>
        request(WS_METHODS.openWorkList, input).pipe(
          Effect.catchDefect((defect) =>
            isUnknownRequestTag(defect)
              ? Effect.fail(new OpenWorkUnsupportedError())
              : Effect.die(defect),
          ),
        ),
    }),
    timeline: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:open-work:timeline",
      tag: WS_METHODS.openWorkTimeline,
    }),
    diff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:open-work:diff",
      tag: WS_METHODS.openWorkDiff,
      staleTimeMs: 5_000,
    }),
  };
}
