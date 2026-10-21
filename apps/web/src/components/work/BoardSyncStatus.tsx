import type { IssueBoardSync } from "@t3tools/contracts";

import { useClientSettings } from "~/hooks/useSettings";
import { formatDayAwareTimestamp } from "~/timestampFormat";
import { Button } from "../ui/button";

/** Text-only freshness of a board's stored copy, with Retry after a failed refresh. */
export function BoardSyncStatus({
  sync,
  retryDisabled,
  onRetry,
}: {
  readonly sync: IssueBoardSync | null | undefined;
  readonly retryDisabled: boolean;
  readonly onRetry: () => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (!sync) return null;
  if (sync.syncing) {
    return (
      <span role="status" className="shrink-0 text-xs text-muted-foreground">
        Syncing
      </span>
    );
  }
  const failure = sync.failure;
  return (
    <span role="status" className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <span className="truncate">
        {failure
          ? `Sync failed at ${formatDayAwareTimestamp(failure.at, timestampFormat)}, ${failure.message}`
          : `Synced at ${formatDayAwareTimestamp(sync.syncedAt, timestampFormat)}`}
      </span>
      {failure ? (
        <Button size="micro" variant="link" disabled={retryDisabled} onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </span>
  );
}
