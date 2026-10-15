import {
  deliverTurn,
  prepareTurnAttachments,
  type TurnAttachmentAdapter,
  type TurnDeliveryRequest,
} from "@t3tools/client-runtime/turn-delivery";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import type { ComposerThreadTarget } from "../composerDraftStore";
import { composerTurnAttachments, type ComposerTurnAttachment } from "../lib/turnAttachments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { issuesEnvironment } from "./issues";
import { environmentServerConfigsAtom } from "./server";
import { readEnvironmentScope } from "./session";
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
    (
      request: TurnDeliveryRequest<ComposerTurnAttachment>,
      attachments: TurnAttachmentAdapter<ComposerTurnAttachment> = composerTurnAttachments(
        draftTarget,
      ),
    ) =>
      deliverTurn(request, {
        commands: { updateMetadata, setRuntimeMode, setInteractionMode, startTurn },
        issues: { get, reserveAttempt, peerIdentity, grantPeer, registerPeer },
        attachments,
        environment: readEnvironment,
        canOperate: (environmentId) =>
          readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
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

/** Prepares composer attachments once, for a fan-out that hands them to several deliveries. */
export function usePrepareTurnAttachments(draftTarget?: ComposerThreadTarget) {
  return useCallback(
    (environmentId: EnvironmentId, attachments: ReadonlyArray<ComposerTurnAttachment>) =>
      prepareTurnAttachments(
        { environmentId, attachments },
        { attachments: composerTurnAttachments(draftTarget), environment: readEnvironment },
      ),
    [draftTarget],
  );
}
