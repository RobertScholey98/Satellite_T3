import type {
  ClaudeSettings,
  CodexSettings,
  ConfinableProviderDriver,
  FactoryError,
} from "@t3tools/contracts";
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

interface ConfinableProviderSettings {
  readonly codex: CodexSettings;
  readonly claudeAgent: ClaudeSettings;
}

/** A confinable provider instance: its driver, settings and environment. */
export type ConfinedProvider = {
  readonly [Driver in ConfinableProviderDriver]: {
    readonly driver: Driver;
    readonly settings: ConfinableProviderSettings[Driver];
    readonly environment: NodeJS.ProcessEnv;
  };
}[ConfinableProviderDriver];

export type ConfinedLaunchRequest = ConfinedProvider & { readonly confinement: ConfinedExecution };

/**
 * The command that starts a provider inside its runtime, up to the provider's own arguments.
 * Codex's ends with the image and its `-c` overrides, since the image's entrypoint is its app
 * server. Claude's ends with the image run as `claude`, and the adapter appends the Agent SDK's
 * CLI arguments. `name` identifies the runtime in logs. `cleanup` removes the runtime when the
 * provider process ends; its environment carries no provider credential. `renewBy` (epoch
 * milliseconds) is when an expiring credential needs a new launch.
 */
export interface ConfinedProcess {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: Record<string, string | undefined>;
  readonly cleanup: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly environment: Record<string, string | undefined>;
  };
  readonly renewBy?: number;
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
    /** Fails unless `prepare` would find the provider's model credential. Starts nothing. */
    readonly checkCredential: (
      provider: ConfinedProvider,
    ) => Effect.Effect<void, ConfinedLaunchError>;
  }
>()("t3/orchestration-v2/Adapters/ConfinedProviderLaunch") {}

/**
 * No owner: nothing is confined, so a launch is refused. For tests and compositions without
 * engineering managers; the server provides the factory's implementation instead.
 */
const noOwner = new ConfinedLaunchError({
  detail: "No owner can launch a confined provider session.",
});

export const unconfined = ConfinedProviderLaunch.of({
  prepare: () => Effect.fail(noOwner),
  assertActive: () => Effect.void,
  checkCredential: () => Effect.fail(noOwner),
});

export const layerUnconfined = Layer.succeed(ConfinedProviderLaunch, unconfined);
