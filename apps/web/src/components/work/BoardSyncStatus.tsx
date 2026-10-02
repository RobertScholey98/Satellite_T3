import type { IssueBoardSync } from "@t3tools/contracts";

import { Button } from "../ui/button";

const time = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function BoardSyncStatus({
  sync,
  retryDisabled,
  onRetry,
}: {
  sync: IssueBoardSync | undefined;
  retryDisabled: boolean;
  onRetry: () => void;
}) {
  if (!sync || sync.revision === 0) return null;
  if (sync.syncing)
    return (
      <span role="status" className="text-xs text-muted-foreground">
        Syncing…
      </span>
    );
  if (sync.failure)
    return (
      <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
        <span title={new Date(sync.failure.at).toLocaleString()}>
          Sync failed {time(sync.failure.at)}. {sync.failure.message}
        </span>
        <Button size="micro" variant="link" disabled={retryDisabled} onClick={onRetry}>
          Retry
        </Button>
      </span>
    );
  return (
    <span
      role="status"
      title={new Date(sync.syncedAt).toLocaleString()}
      className="text-xs text-muted-foreground"
    >
      Synced {time(sync.syncedAt)}
    </span>
  );
}
