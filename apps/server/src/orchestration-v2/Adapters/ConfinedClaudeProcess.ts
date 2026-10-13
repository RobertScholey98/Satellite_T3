// @effect-diagnostics-next-line nodeBuiltinImport:off -- the Agent SDK spawns Claude Code through a Node ChildProcess.
import * as NodeChildProcess from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";

import type { ConfinedProcess } from "./ConfinedProviderLaunch.ts";

// The built-in tools a managed team works with. An allow-list, so a tool a later Claude Code adds
// stays off until it is reviewed. Agent tools (`Agent`, `Workflow`, `SendMessage`) choose models
// that bypass FactoryModelAdmission, so teams delegate through `delegate_task`; scheduling,
// worktree, remote and claude.ai account tools reach outside the assignment. MCP tools are not
// built-ins and stay available, but Claude Code can defer a large MCP tool set behind `ToolSearch`,
// and without it a manager would lose `delegate_task`. Plan mode and `AskUserQuestion` reach the
// human through T3. The live probe in FactoryClaudeLaunch.test.ts snapshots what the image's
// Claude Code offers; rerun it when that version changes.
export const CLAUDE_CONFINED_TOOLS: ReadonlyArray<string> = [
  "AskUserQuestion",
  "Bash",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "NotebookEdit",
  "Read",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "ToolSearch",
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
  /**
   * Removes the runtime at most once. Docker accepts an already-removed one, so a failure or
   * timeout means the container may still run, and is logged when first awaited.
   */
  readonly remove: Effect.Effect<void>;
}

export function makeConfinedClaudeRuntime(launch: ConfinedProcess): ConfinedClaudeRuntime {
  let removal:
    | Promise<{
        readonly timedOut: boolean;
        readonly code: string | number | null | undefined;
        readonly stderr: string;
      } | null>
    | undefined;
  let removalReported = false;
  const remove = () =>
    (removal ??= new Promise((resolve) => {
      NodeChildProcess.execFile(
        launch.cleanup.command,
        [...launch.cleanup.args],
        { env: launch.cleanup.environment, timeout: 10_000, windowsHide: true },
        (error, _stdout, stderr) =>
          resolve(
            error === null
              ? null
              : { timedOut: error.killed === true, code: error.code, stderr: stderr.trim() },
          ),
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
    remove: Effect.promise(remove).pipe(
      Effect.flatMap((failure) => {
        if (failure === null || removalReported) return Effect.void;
        removalReported = true;
        return Effect.logWarning("orchestration-v2.claude-confined-runtime-removal-failed", {
          runtime: launch.name,
          ...failure,
        });
      }),
    ),
  };
}
