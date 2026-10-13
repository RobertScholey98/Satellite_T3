import type { CodexSettings, FactoryError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { ConfinedExecution } from "../ThreadGovernance.ts";

/** Where a confined provider sees the thread's workspace. */
export const CONFINED_WORKSPACE = "/workspace";

/** A loopback MCP endpoint as a confined provider reaches it from inside its container. */
export function confinedEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
  }
  return url.toString();
}

export class ConfinedLaunchError extends Schema.TaggedError<ConfinedLaunchError>()(
  "ConfinedLaunchError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export type ConfinedLaunchRequest = {
  readonly driver: "codex";
  readonly confinement: ConfinedExecution;
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
};

/**
 * The command that starts a provider inside its runtime, up to the provider's own arguments.
 * Codex's ends with the image and its `-c` overrides, since the image's entrypoint is its app
 * server. `cleanup` removes the runtime when the provider process ends.
 */
export interface ConfinedProcess {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: Record<string, string | undefined>;
  readonly cleanup: { readonly command: string; readonly args: ReadonlyArray<string> };
}

/**
 * Launches a provider inside the runtime a `ThreadGovernance` owner assigned. An adapter calls
 * `prepare` for each confined provider process it opens and `assertActive` before each turn.
 */
export class ConfinedProviderLaunch extends Context.Service<
  ConfinedProviderLaunch,
  {
    readonly prepare: (
      request: ConfinedLaunchRequest,
    ) => Effect.Effect<ConfinedProcess, ConfinedLaunchError>;
    /** Fails while the owner holds or revoked the confinement. */
    readonly assertActive: (confinement: ConfinedExecution) => Effect.Effect<void, FactoryError>;
  }
>()("t3/orchestration-v2/Adapters/ConfinedProviderLaunch") {}

/**
 * No owner: nothing is confined, so a launch is refused. For tests and compositions without
 * engineering managers; the server provides the factory's implementation instead.
 */
export const layerUnconfined = Layer.succeed(
  ConfinedProviderLaunch,
  ConfinedProviderLaunch.of({
    prepare: () =>
      Effect.fail(
        new ConfinedLaunchError({ detail: "No owner can launch a confined provider session." }),
      ),
    assertActive: () => Effect.void,
  }),
);
