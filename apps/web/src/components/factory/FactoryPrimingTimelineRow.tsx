import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { use, useState } from "react";

import { TimelineRowCtx, type TimelineRow } from "../chat/timelineRowContext";
import { Button } from "../ui/button";
import { FactoryManagerReady } from "./FactoryManagerReady";

/** The timeline's registration point for a primed manager thread's first exchange. */
export function FactoryPrimingTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "factory-priming" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const [open, setOpen] = useState(false);
  if (row.prompt === null) {
    return <p className="px-1 text-xs text-muted-foreground">Loading the manager's thread…</p>;
  }
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="space-y-3 px-1">
      <Button size="xs" variant="ghost-muted" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron />
        Primed from the approved onboarding result
      </Button>
      {open ? (
        <div className="space-y-3 rounded-lg border p-3 text-xs">
          <p className="whitespace-pre-wrap text-muted-foreground">{row.prompt.text}</p>
          {row.reply === null ? null : <p className="whitespace-pre-wrap">{row.reply.text}</p>}
        </div>
      ) : null}
      {/* Ready only once the manager has answered its priming, and until the user writes. */}
      {row.reply === null || row.continued ? null : (
        <FactoryManagerReady
          environmentId={ctx.activeThreadEnvironmentId}
          threadId={ctx.threadRef?.threadId ?? null}
        />
      )}
    </div>
  );
}
