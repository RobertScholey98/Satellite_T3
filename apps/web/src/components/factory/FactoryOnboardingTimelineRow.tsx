import { use } from "react";

import { TimelineRowCtx, type TimelineRow } from "../chat/timelineRowContext";
import { FactoryOnboardingCard } from "./FactoryOnboardingCard";

/** The timeline's registration point for the onboarding card; the card itself owns no chat state. */
export function FactoryOnboardingTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "factory-onboarding" }>;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <FactoryOnboardingCard
      environmentId={ctx.activeThreadEnvironmentId}
      threadId={ctx.threadRef?.threadId ?? null}
      latest={row.latest}
      onSendMessage={ctx.onSendAppMessage}
    />
  );
}
