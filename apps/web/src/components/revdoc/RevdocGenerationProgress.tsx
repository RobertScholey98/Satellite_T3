import type { RevdocGenerationProgress as Progress } from "@t3tools/contracts";
import { useEffect, useState } from "react";

const formatElapsed = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

/**
 * Batch progress as text. Elapsed times start from the server's measurement and advance once a
 * second locally; there is no animation. Key it by `revdocProgressKey` so each server update
 * restarts the local drift.
 */
export function RevdocGenerationProgress({ progress }: { readonly progress: Progress }) {
  const [receivedAt] = useState(() => Date.now());
  const [now, setNow] = useState(receivedAt);
  const ticking = progress.running.length > 0;
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const drift = Math.max(0, now - receivedAt);
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground" aria-live="polite">
      <span>
        {progress.stage === "reviewing" ? "Reviewing changes" : "Combining areas"}:{" "}
        {progress.completed} of {progress.total}{" "}
        {progress.stage === "reviewing" ? "batches" : "groups"} done
      </span>
      {progress.running.map((call) => (
        <span key={call.batch} className="tabular-nums">
          {progress.stage === "reviewing" ? "Batch" : "Group"} {call.batch}:{" "}
          {formatElapsed(call.elapsedMs + drift)}
        </span>
      ))}
    </div>
  );
}

export const revdocProgressKey = (progress: Progress) =>
  `${progress.stage}:${progress.completed}:${progress.total}:${progress.running.map((call) => `${call.batch}@${call.elapsedMs}`).join(",")}`;
