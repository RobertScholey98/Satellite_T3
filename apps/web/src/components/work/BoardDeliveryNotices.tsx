import type { EnvironmentId, IssueDeliveryPeer } from "@t3tools/contracts";

import { Button } from "../ui/button";

const STUCK_STATES: ReadonlySet<IssueDeliveryPeer["state"]> = new Set([
  "unreachable",
  "unauthorized",
  "failed",
  "unregistered",
]);

/** Why ticket updates from a worktree computer are not reaching this board, with the way out. */
export function BoardDeliveryNotices({
  deliveries,
  labelOf,
  disabled,
  onRetry,
  onForget,
}: {
  deliveries: ReadonlyArray<IssueDeliveryPeer> | undefined;
  labelOf: (environmentId: EnvironmentId) => string;
  disabled: boolean;
  onRetry: () => void;
  onForget: (environmentId: EnvironmentId) => void;
}) {
  const stuck = deliveries?.filter((delivery) => STUCK_STATES.has(delivery.state)) ?? [];
  return stuck.map((delivery) => (
    <div
      key={delivery.destinationEnvironmentId}
      role="status"
      className="flex items-center gap-2 text-xs"
    >
      <span>
        Updates from {labelOf(delivery.destinationEnvironmentId)} are not arriving.{" "}
        {delivery.state === "unregistered"
          ? "Start a ticket on it from a Satellite window connected to both computers."
          : delivery.error}
      </span>
      {delivery.state === "unregistered" ? null : (
        <>
          <Button size="xs" variant="outline" disabled={disabled} onClick={onRetry}>
            Retry
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => onForget(delivery.destinationEnvironmentId)}
          >
            Forget
          </Button>
        </>
      )}
    </div>
  ));
}
