import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { ThreadDetailsCardPlacement } from "../chat/threadDetailsCardPlacement";
import {
  factoryThreadKind,
  resolveFactoryDetailsCardSide,
  resolveFactoryThreadStack,
  type FactoryWorkspacePlace,
} from "./factoryWorkspaceLogic";
import { useFactoryWorkspacePlace } from "./factoryWorkspaceState";
import { FACTORY_THREAD_STACK } from "./FactoryThreadStack";

/**
 * The details card's placement on a factory thread. The card and the workspace panel around it
 * both read it, so they agree on where the card sits and whether it is inline.
 */
export function resolveFactoryDetailsCardPlacement(
  place: FactoryWorkspacePlace,
  canvas: Omit<Parameters<typeof resolveFactoryDetailsCardSide>[0], "teamColumn">,
): ThreadDetailsCardPlacement {
  return {
    side: resolveFactoryDetailsCardSide({ ...canvas, teamColumn: place.teamColumn }),
    topInset: resolveFactoryThreadStack(FACTORY_THREAD_STACK, factoryThreadKind(place))
      .detailsTopInset,
  };
}

/** For the details card: its placement on a factory thread; undefined on any other. */
export function useFactoryDetailsCardPlacement(environmentId: EnvironmentId, threadId: ThreadId) {
  const place = useFactoryWorkspacePlace(environmentId, threadId);
  if (place === null) return undefined;
  return (canvas: Parameters<typeof resolveFactoryDetailsCardPlacement>[1]) =>
    resolveFactoryDetailsCardPlacement(place, canvas);
}
