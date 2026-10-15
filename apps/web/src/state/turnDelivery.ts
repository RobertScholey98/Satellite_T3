import { deliverTurn, type TurnDeliveryRequest } from "@t3tools/client-runtime/turn-delivery";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";
import { threadEnvironment } from "./threads";
import { useOrchestrationCommand } from "./use-orchestration-command";

const readEnvironment = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment;

/** Binds turn delivery to this client's thread commands and server configs. */
export function useDeliverTurn() {
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  return useCallback(
    (request: TurnDeliveryRequest) =>
      deliverTurn(request, {
        commands: { updateMetadata, setRuntimeMode, setInteractionMode, startTurn },
        environment: readEnvironment,
      }),
    [setInteractionMode, setRuntimeMode, startTurn, updateMetadata],
  );
}
