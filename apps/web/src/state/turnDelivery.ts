import { deliverTurn, type TurnDeliveryRequest } from "@t3tools/client-runtime/turn-delivery";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import type { ComposerThreadTarget } from "../composerDraftStore";
import { composerTurnAttachments, type ComposerTurnAttachment } from "../lib/turnAttachments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";
import { threadEnvironment } from "./threads";
import { useOrchestrationCommand } from "./use-orchestration-command";

const readEnvironment = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment;

/** Binds turn delivery to this client's thread commands, server configs, and upload queue. */
export function useDeliverTurn(draftTarget?: ComposerThreadTarget) {
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
    (request: TurnDeliveryRequest<ComposerTurnAttachment>) =>
      deliverTurn(request, {
        commands: { updateMetadata, setRuntimeMode, setInteractionMode, startTurn },
        attachments: composerTurnAttachments(draftTarget),
        environment: readEnvironment,
      }),
    [draftTarget, setInteractionMode, setRuntimeMode, startTurn, updateMetadata],
  );
}
