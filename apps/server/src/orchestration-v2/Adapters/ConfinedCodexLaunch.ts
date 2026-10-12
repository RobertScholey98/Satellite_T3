import type { CodexSettings, FactoryError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { ConfinedExecution } from "../ThreadGovernance.ts";

/** Where a confined Codex sees the thread's workspace. */
export const CONFINED_CODEX_WORKSPACE = "/workspace";

/** A loopback MCP endpoint as a confined Codex reaches it from inside its container. */
export function confinedCodexEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
  }
  return url.toString();
}

export class ConfinedCodexLaunchError extends Schema.TaggedError<ConfinedCodexLaunchError>()(
  "ConfinedCodexLaunchError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * Launches Codex inside the runtime a `ThreadGovernance` owner assigned. The Codex adapter calls
 * `prepare` when a confined session opens and `assertActive` before its handshake and each turn.
 */
export class ConfinedCodexLaunch extends Context.Service<
  ConfinedCodexLaunch,
  {
    /** The app-server command to spawn. `cleanup` removes the runtime when the session closes. */
    readonly prepare: (input: {
      readonly confinement: ConfinedExecution;
      readonly settings: CodexSettings;
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<
      {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly environment: Record<string, string | undefined>;
        readonly cleanup: { readonly command: string; readonly args: ReadonlyArray<string> };
      },
      ConfinedCodexLaunchError
    >;
    /** Fails while the owner holds or revoked the confinement. */
    readonly assertActive: (confinement: ConfinedExecution) => Effect.Effect<void, FactoryError>;
  }
>()("t3/orchestration-v2/Adapters/ConfinedCodexLaunch") {}

/**
 * No owner: nothing is confined, so a launch is refused. For tests and compositions without
 * engineering managers; the server provides the factory's implementation instead.
 */
export const layerUnconfined = Layer.succeed(
  ConfinedCodexLaunch,
  ConfinedCodexLaunch.of({
    prepare: () =>
      Effect.fail(
        new ConfinedCodexLaunchError({ detail: "No owner can launch a confined Codex session." }),
      ),
    assertActive: () => Effect.void,
  }),
);
