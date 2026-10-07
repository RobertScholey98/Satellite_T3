import type { RevdocBatchActivity, RevdocRunState } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useEffect, useState } from "react";

function batchLabel(state: RevdocRunState, entry: RevdocBatchActivity) {
  const total = state.total ?? 0;
  if (state.generationStage === "combining") return `Section group ${entry.batch} of ${total}`;
  return total > 1 ? `Batch ${entry.batch} of ${total}` : "Review";
}

function activityStatus(entry: RevdocBatchActivity) {
  if (entry.outputBytes > 0)
    return `Writing checklist · ${Math.max(1, Math.round(entry.outputBytes / 1024))} KB`;
  if (entry.thinkingTokens !== undefined)
    return `Thinking · ${entry.thinkingTokens.toLocaleString()} tokens`;
  if (entry.thinking) return "Thinking";
  return "Waiting for the model…";
}

/**
 * What each in-flight model call of a generation pass is doing. Elapsed time is
 * server-measured; a local once-a-second tick extends it so silent providers still move.
 */
export function RevdocGenerationProgress({ state }: { state: RevdocRunState }) {
  const entries = state.activity ?? [];
  const ticking = entries.length > 0;
  // Drift since the current state arrived; a newer state resets it until the next tick.
  const [tick, setTick] = useState<{ version: number; driftMs: number } | null>(null);
  useEffect(() => {
    if (!ticking) return;
    const startedAt = Date.now();
    const id = setInterval(
      () => setTick({ version: state.version, driftMs: Date.now() - startedAt }),
      1_000,
    );
    return () => clearInterval(id);
  }, [ticking, state.version]);
  const driftMs = tick?.version === state.version ? tick.driftMs : 0;
  if (entries.length === 0) {
    return (
      <p className="border-b border-border/60 px-4 py-3 text-xs text-muted-foreground">
        Preparing the worktree's changes…
      </p>
    );
  }
  return (
    <ul className="max-h-[40%] shrink-0 space-y-2 overflow-y-auto border-b border-border/60 px-4 py-3 text-xs">
      {entries.map((entry) => (
        <li key={entry.batch} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{batchLabel(state, entry)}</span>
            <span className="tabular-nums text-muted-foreground">
              {formatDuration(entry.elapsedMs + driftMs)}
            </span>
          </div>
          <p className="text-muted-foreground">{activityStatus(entry)}</p>
          {entry.thinking && (
            <p className="line-clamp-3 break-words text-muted-foreground/80">{entry.thinking}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
