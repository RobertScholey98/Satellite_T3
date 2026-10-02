import type { IssueBoardSync } from "@t3tools/contracts";

import { useClientSettings } from "~/hooks/useSettings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "~/timestampFormat";
import { Button } from "../ui/button";

export function BoardSyncStatus({
  sync,
  retryDisabled,
  onRetry,
}: {
  sync: IssueBoardSync | undefined;
  retryDisabled: boolean;
  onRetry: () => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (!sync) return null;
  const failure = sync.syncing ? null : sync.failure;
  const at = failure?.at ?? sync.syncedAt;
  const shown = formatDayAwareTimestamp(at, timestampFormat);
  const label = sync.syncing
    ? "Syncing…"
    : failure
      ? `Sync failed ${shown}. ${failure.message}`
      : `Synced ${shown}`;
  return (
    <span
      role="status"
      title={sync.syncing ? undefined : formatChatTimestampTooltip(at, timestampFormat)}
      className="text-xs text-muted-foreground"
    >
      {label}
      {failure ? (
        <>
          {" "}
          <Button size="micro" variant="link" disabled={retryDisabled} onClick={onRetry}>
            Retry
          </Button>
        </>
      ) : null}
    </span>
  );
}
