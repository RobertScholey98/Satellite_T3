import {
  usePendingRequestResponse,
  usePendingRequestStatus,
} from "../../state/usePendingRequestResponse";
import { isPendingDelivery, usePendingRequestStore } from "../../pendingRequestStore";
import { Button } from "../ui/button";

export function PendingRequestDelivery({
  requestKey,
  unavailable,
}: {
  requestKey: string;
  unavailable: boolean;
}) {
  const delivery = usePendingRequestStore((state) => state.drafts[requestKey]?.delivery);
  const send = usePendingRequestResponse();
  const checkStatus = usePendingRequestStatus();
  if (!delivery || !isPendingDelivery(delivery)) return null;
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground"
      role="status"
    >
      <span className="min-w-0 flex-1">
        {delivery.phase === "uncertain"
          ? "Response delivery is unconfirmed. Your answer is saved."
          : delivery.phase === "sending"
            ? "Sending response..."
            : "Waiting for the agent to confirm your response."}
      </span>
      {delivery.checkError ? <span role="alert">{delivery.checkError}</span> : null}
      {delivery.phase !== "sending" ? (
        <Button
          size="xs"
          variant="outline"
          disabled={unavailable}
          onClick={() => void checkStatus(delivery.submission)}
        >
          Check status
        </Button>
      ) : null}
      {delivery.phase === "uncertain" ? (
        <Button
          size="xs"
          variant="outline"
          disabled={unavailable}
          onClick={() => {
            const store = usePendingRequestStore.getState();
            const current = store.drafts[requestKey]?.delivery;
            if (current?.phase !== "uncertain") return;
            const submission = current.submission;
            store.updateDraft(requestKey, (draft) => ({
              ...draft,
              delivery: { phase: "sending", submission },
            }));
            void send(submission);
          }}
        >
          Retry saved response
        </Button>
      ) : null}
    </div>
  );
}
