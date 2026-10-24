import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  factoryThreadKind,
  resolveFactoryDetailsCardSide,
  resolveFactoryThreadStack,
} from "./factoryWorkspaceLogic";
import { useFactoryWorkspacePlace } from "./factoryWorkspaceState";
import { FACTORY_THREAD_STACK } from "./FactoryThreadStack";

/** For the details card: its placement on a factory thread; undefined on any other. */
export function useFactoryDetailsCardPlacement(environmentId: EnvironmentId, threadId: ThreadId) {
  const place = useFactoryWorkspacePlace(environmentId, threadId);
  if (place === null) return undefined;
  const topInset = resolveFactoryThreadStack(
    FACTORY_THREAD_STACK,
    factoryThreadKind(place),
  ).detailsTopInset;
  return (canvas: Omit<Parameters<typeof resolveFactoryDetailsCardSide>[0], "teamColumn">) => ({
    side: resolveFactoryDetailsCardSide({ ...canvas, teamColumn: place.teamColumn }),
    topInset,
  });
}
