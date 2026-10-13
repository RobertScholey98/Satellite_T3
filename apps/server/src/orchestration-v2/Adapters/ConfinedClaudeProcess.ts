// @effect-diagnostics-next-line nodeBuiltinImport:off -- the Agent SDK spawns Claude Code through a Node ChildProcess.
import * as NodeChildProcess from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";

import type { ConfinedProcess } from "./ConfinedProviderLaunch.ts";

// Tools that start or message agents. `Agent` (alias `Task`) takes its own model choice and
// `Workflow` scripts choose models for the agents they spawn; `SendMessage` resumes agents and
// reaches the account's other sessions, with `ListAgents` to find them. Those choices bypass
// FactoryModelAdmission, so managed teams delegate through `delegate_task`. Rerun the live probe
// in FactoryClaudeLaunch.test.ts when the factory image's Claude Code changes.
export const CLAUDE_CONFINED_DISALLOWED_TOOLS: ReadonlyArray<string> = [
  "Agent",
  "Task",
  "Workflow",
  "SendMessage",
  "ListAgents",
];

/** One Claude Code process in a confined runtime, and the runtime's removal. */
export interface ConfinedClaudeRuntime {
  /**
   * Starts the Agent SDK's Claude Code process in the runtime. The SDK's command, working
   * directory and environment describe the host, so only its CLI arguments cross into the
   * container. The runtime is removed when the process exits or fails to start.
   */
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Removes the runtime at most once, ignoring failures such as an already-removed one. */
  readonly remove: Effect.Effect<void>;
}

export function makeConfinedClaudeRuntime(launch: ConfinedProcess): ConfinedClaudeRuntime {
  let removal: Promise<void> | undefined;
  const remove = () =>
    (removal ??= new Promise<void>((resolve) => {
      NodeChildProcess.execFile(
        launch.cleanup.command,
        [...launch.cleanup.args],
        { env: launch.environment, timeout: 10_000, windowsHide: true },
        () => resolve(),
      );
    }));
  return {
    spawn: (options) => {
      const child = NodeChildProcess.spawn(launch.command, [...launch.args, ...options.args], {
        env: launch.environment,
        stdio: "pipe",
        windowsHide: true,
        signal: options.signal,
      });
      // The SDK reads only stdout, so stderr is drained to keep a chatty runtime from blocking.
      child.stderr.resume();
      child.once("exit", () => void remove());
      child.once("error", () => void remove());
      return child;
    },
    remove: Effect.promise(remove),
  };
}
