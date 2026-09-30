import { useState } from "react";

import { SatelliteLoader } from "../SatelliteLoader";

/** Keep the mark mounted through its finish without implying a sync is still running. */
export function WorkSyncIndicator({ syncing }: { syncing: boolean }) {
  const [previousSyncing, setPreviousSyncing] = useState(syncing);
  const [finished, setFinished] = useState(!syncing);
  if (previousSyncing !== syncing) {
    setPreviousSyncing(syncing);
    if (syncing) setFinished(false);
  }

  if (!syncing && finished) return null;

  return (
    <span
      role="status"
      aria-live="polite"
      aria-busy={syncing}
      className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
    >
      <SatelliteLoader
        loading={syncing}
        onExitComplete={() => setFinished(true)}
        size={22}
        role="presentation"
        aria-label="Syncing"
      />
      <span className={syncing ? undefined : "invisible"} aria-hidden={!syncing}>
        Syncing
      </span>
    </span>
  );
}
