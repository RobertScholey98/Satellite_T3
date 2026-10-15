import { deliverTurn, type TurnDeliveryRequest } from "@t3tools/client-runtime/turn-delivery";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import type { ComposerThreadTarget } from "../composerDraftStore";
import { composerTurnAttachments, type ComposerTurnAttachment } from "../lib/turnAttachments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { issuesEnvironment } from "./issues";
import { environmentServerConfigsAtom } from "./server";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import { useOrchestrationCommand } from "./use-orchestration-command";

const readEnvironment = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment;

/** Binds turn delivery to this client's thread and issue commands, server configs, and upload queue. */
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
  const get = useAtomCommand(issuesEnvironment.get, { reportFailure: false });
  const reserveAttempt = useAtomCommand(issuesEnvironment.reserveAttempt, { reportFailure: false });
  const peerIdentity = useAtomCommand(issuesEnvironment.peerIdentity, { reportFailure: false });
  const grantPeer = useAtomCommand(issuesEnvironment.grantPeer, { reportFailure: false });
  const registerPeer = useAtomCommand(issuesEnvironment.registerPeer, { reportFailure: false });
  return useCallback(
    (request: TurnDeliveryRequest<ComposerTurnAttachment>) =>
      deliverTurn(request, {
        commands: { updateMetadata, setRuntimeMode, setInteractionMode, startTurn },
        issues: { get, reserveAttempt, peerIdentity, grantPeer, registerPeer },
        attachments: composerTurnAttachments(draftTarget),
        environment: readEnvironment,
      }),
    [
      draftTarget,
      get,
      grantPeer,
      peerIdentity,
      registerPeer,
      reserveAttempt,
      setInteractionMode,
      setRuntimeMode,
      startTurn,
      updateMetadata,
    ],
  );
}
