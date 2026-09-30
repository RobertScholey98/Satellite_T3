import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "./connection/registry.ts";
import { createEnvironmentRpcCommand } from "./state/runtime.ts";

export function createOpenWorkEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcCommand(runtime, {
      label: "open-work:list",
      tag: WS_METHODS.openWorkList,
    }),
    timeline: createEnvironmentRpcCommand(runtime, {
      label: "open-work:timeline",
      tag: WS_METHODS.openWorkTimeline,
    }),
    linkFolder: createEnvironmentRpcCommand(runtime, {
      label: "open-work:link-folder",
      tag: WS_METHODS.openWorkLinkFolder,
    }),
    unlinkFolder: createEnvironmentRpcCommand(runtime, {
      label: "open-work:unlink-folder",
      tag: WS_METHODS.openWorkUnlinkFolder,
    }),
    assignDocument: createEnvironmentRpcCommand(runtime, {
      label: "open-work:assign-document",
      tag: WS_METHODS.openWorkAssignDocument,
    }),
    setFavorite: createEnvironmentRpcCommand(runtime, {
      label: "open-work:favorite-document",
      tag: WS_METHODS.openWorkFavoriteDocument,
    }),
    favorites: createEnvironmentRpcCommand(runtime, {
      label: "open-work:favorites",
      tag: WS_METHODS.openWorkFavorites,
    }),
    readLinked: createEnvironmentRpcCommand(runtime, {
      label: "open-work:read-linked",
      tag: WS_METHODS.openWorkReadLinkedDocument,
    }),
  };
}
