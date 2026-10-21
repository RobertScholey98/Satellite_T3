import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Issue board commands and the board sync subscription. Boards are read on demand: the server
 * keeps the stored copy fresh and the subscription says when to reopen.
 */
export function createIssuesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcCommand(runtime, {
      label: "issues:list",
      tag: WS_METHODS.issuesList,
    }),
    get: createEnvironmentRpcCommand(runtime, { label: "issues:get", tag: WS_METHODS.issuesGet }),
    listBoards: createEnvironmentRpcCommand(runtime, {
      label: "issues:boards:list",
      tag: WS_METHODS.issuesBoardsList,
    }),
    openBoard: createEnvironmentRpcCommand(runtime, {
      label: "issues:boards:open",
      tag: WS_METHODS.issuesBoardsOpen,
    }),
    boardSync: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:issues:board-sync",
      tag: WS_METHODS.issuesBoardsSubscribe,
    }),
    configureBoard: createEnvironmentRpcCommand(runtime, {
      label: "issues:boards:configure",
      tag: WS_METHODS.issuesBoardsConfigure,
    }),
    disconnectBoard: createEnvironmentRpcCommand(runtime, {
      label: "issues:boards:disconnect",
      tag: WS_METHODS.issuesBoardsDisconnect,
    }),
    move: createEnvironmentRpcCommand(runtime, {
      label: "issues:boards:move",
      tag: WS_METHODS.issuesBoardsMove,
    }),
    retryMove: createEnvironmentRpcCommand(runtime, {
      label: "issues:moves:retry",
      tag: WS_METHODS.issuesMovesRetry,
    }),
    listAttempts: createEnvironmentRpcCommand(runtime, {
      label: "issues:attempts:list",
      tag: WS_METHODS.issuesAttemptsList,
    }),
    startAttempt: createEnvironmentRpcCommand(runtime, {
      label: "issues:attempts:start",
      tag: WS_METHODS.issuesAttemptsStart,
    }),
    endAttempt: createEnvironmentRpcCommand(runtime, {
      label: "issues:attempts:end",
      tag: WS_METHODS.issuesAttemptsEnd,
    }),
    resumeAttempt: createEnvironmentRpcCommand(runtime, {
      label: "issues:attempts:resume",
      tag: WS_METHODS.issuesAttemptsResume,
    }),
  };
}
