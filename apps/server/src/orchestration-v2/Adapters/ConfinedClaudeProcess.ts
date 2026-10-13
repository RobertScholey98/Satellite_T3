// @effect-diagnostics-next-line nodeBuiltinImport:off -- the Agent SDK spawns Claude Code through a Node ChildProcess.
import * as NodeChildProcess from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";

import type { ConfinedProcess } from "./ConfinedProviderLaunch.ts";

// The built-in tools a managed team works with. An allow-list, so a tool a later Claude Code adds
// stays off until it is reviewed. Agent tools (`Agent`, `Workflow`, `SendMessage`) choose models
// that bypass FactoryModelAdmission, so teams delegate through `delegate_task`; scheduling,
// worktree, remote and claude.ai account tools reach outside the assignment. MCP tools are not
// built-ins and stay available. The live probe in FactoryClaudeLaunch.test.ts snapshots what the
// image's Claude Code offers; rerun it when that version changes.
export const CLAUDE_CONFINED_TOOLS: ReadonlyArray<string> = [
  "Bash",
  "Edit",
  "NotebookEdit",
  "Read",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "WebFetch",
  "WebSearch",
  "Write",
];

/**
 * The Agent SDK's identifying variables, which carry no secret. The launch forwards them by name,
 * and the spawner sets them from the SDK's environment.
 */
export const CLAUDE_SDK_IDENTITY_VARIABLES = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION"];

const STDERR_TAIL_LENGTH = 4_096;

/** One Claude Code process in a confined runtime, and the runtime's removal. */
export interface ConfinedClaudeRuntime {
  readonly name: string;
  /** When the runtime's credential needs a new launch, in epoch milliseconds. */
  readonly renewBy: number | undefined;
  /**
   * Starts the Agent SDK's Claude Code process in the runtime. The SDK's command, working
   * directory and environment describe the host, so only its CLI arguments cross into the
   * container. The runtime is removed when the process exits or fails to start.
   */
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  /**
   * The end of the process's stderr, where Docker and Claude Code explain a failed start. The
   * SDK keeps no stderr for a process it did not spawn. Waits for the output of an exited process.
   */
  readonly stderrTail: Effect.Effect<string>;
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
        { env: launch.cleanup.environment, timeout: 10_000, windowsHide: true },
        () => resolve(),
      );
    }));
  let stderr = "";
  let exited = false;
  const closed = Promise.withResolvers<void>();
  return {
    name: launch.name,
    renewBy: launch.renewBy,
    spawn: (options) => {
      const child = NodeChildProcess.spawn(launch.command, [...launch.args, ...options.args], {
        env: {
          ...launch.environment,
          ...Object.fromEntries(
            CLAUDE_SDK_IDENTITY_VARIABLES.flatMap((name) =>
              options.env[name] === undefined ? [] : [[name, options.env[name]]],
            ),
          ),
        },
        stdio: "pipe",
        windowsHide: true,
        signal: options.signal,
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_LENGTH);
      });
      child.once("exit", () => {
        exited = true;
        void remove();
      });
      child.once("close", () => closed.resolve());
      child.once("error", () => {
        closed.resolve();
        void remove();
      });
      return child;
    },
    stderrTail: Effect.promise(() => (exited ? closed.promise : Promise.resolve())).pipe(
      Effect.timeoutOption("2 seconds"),
      Effect.map(() => stderr.trim()),
    ),
    remove: Effect.promise(remove),
  };
}
