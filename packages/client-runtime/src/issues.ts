import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "./connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./state/runtime.ts";

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
    retryMove: createEnvironmentRpcCommand(runtime, {
      label: "issues:moves:retry",
      tag: WS_METHODS.issuesMovesRetry,
    }),
    move: createEnvironmentRpcCommand(runtime, {
      label: "issues:boards:move",
      tag: WS_METHODS.issuesBoardsMove,
    }),
    reserveAttempt: createEnvironmentRpcCommand(runtime, {
      label: "issues:attempts:reserve",
      tag: WS_METHODS.issuesAttemptsReserve,
    }),
    listAttempts: createEnvironmentRpcCommand(runtime, {
      label: "issues:attempts:list",
      tag: WS_METHODS.issuesAttemptsList,
    }),
    peerIdentity: createEnvironmentRpcCommand(runtime, {
      label: "issues:peers:identity",
      tag: WS_METHODS.issuesPeersIdentity,
    }),
    grantPeer: createEnvironmentRpcCommand(runtime, {
      label: "issues:peers:grant",
      tag: WS_METHODS.issuesPeersGrant,
    }),
    registerPeer: createEnvironmentRpcCommand(runtime, {
      label: "issues:peers:register",
      tag: WS_METHODS.issuesPeersRegister,
    }),
    forgetPeer: createEnvironmentRpcCommand(runtime, {
      label: "issues:peers:forget",
      tag: WS_METHODS.issuesPeersForget,
    }),
    deliver: createEnvironmentRpcCommand(runtime, {
      label: "issues:deliveries:deliver",
      tag: WS_METHODS.issuesDeliveriesDeliver,
    }),
  };
}
