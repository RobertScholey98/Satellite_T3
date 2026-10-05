import { useCallback } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isPendingDelivery,
  pendingRequestKey,
  recordPendingCommandResult,
  usePendingRequestStore,
  type PendingSubmission,
} from "../pendingRequestStore";
import { refreshThreadDetail, threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

export function usePendingRequestResponse() {
  const approve = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const answer = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, { reportFailure: false });
  return useCallback(
    async (submission: PendingSubmission) => {
      const ref = submission.summary.ref;
      if (ref.kind !== "approval" && ref.kind !== "question") return;
      const input = {
        threadId: ref.threadId,
        requestId: ref.requestId,
        commandId: submission.commandId,
        createdAt: submission.createdAt,
      };
      const response = submission.response;
      const result =
        response.kind === "approval"
          ? await approve({
              environmentId: ref.environmentId,
              input: { ...input, decision: response.decision },
            })
          : response.kind === "dismiss"
            ? await dismiss({ environmentId: ref.environmentId, input })
            : await answer({
                environmentId: ref.environmentId,
                input: {
                  ...input,
                  answers: response.answers,
                  ...(response.attachmentsByQuestionId
                    ? { attachmentsByQuestionId: response.attachmentsByQuestionId }
                    : {}),
                },
              });
      recordPendingCommandResult(pendingRequestKey(ref), submission, result);
      return result;
    },
    [approve, answer, dismiss],
  );
}

export function usePendingRequestStatus() {
  const read = useAtomCommand(threadEnvironment.getRequestLifecycle, { reportFailure: false });
  return useCallback(
    async (submission: PendingSubmission) => {
      const ref = submission.summary.ref;
      if (ref.kind !== "question" && ref.kind !== "approval") return;
      const result = await read({
        environmentId: ref.environmentId,
        input: {
          threadId: ref.threadId,
          audience: submission.audience,
          kind: ref.kind,
          requestId: ref.requestId,
          submittedAt: submission.createdAt,
        },
      });
      const store = usePendingRequestStore.getState();
      const current = store.drafts[pendingRequestKey(ref)]?.delivery;
      if (
        current &&
        isPendingDelivery(current) &&
        current.submission.commandId === submission.commandId
      ) {
        const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
        store.updateDraft(pendingRequestKey(ref), (draft) => ({
          ...draft,
          delivery: {
            phase: current.phase,
            submission: current.submission,
            ...(result._tag === "Failure"
              ? {
                  checkError:
                    error instanceof Error
                      ? error.message
                      : "Could not check this request. Try again.",
                }
              : {}),
          },
        }));
        if (result._tag === "Success") store.reconcile(ref, result.value);
      }
      refreshThreadDetail(ref.environmentId, ref.threadId, submission.audience);
    },
    [read],
  );
}
