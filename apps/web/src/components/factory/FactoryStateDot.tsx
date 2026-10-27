import type { FactoryAssignmentState } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

/** Every state gets a dot so the labels line up; only the states that need the user get colour. */
const STATE_DOT_CLASS: Record<FactoryAssignmentState, string> = {
  active: "bg-muted-foreground/45",
  blocked: "bg-destructive",
  "waiting-user": "bg-info",
  stalled: "bg-muted-foreground/45",
  retro: "bg-muted-foreground/45",
  completed: "bg-muted-foreground/45",
  cancelled: "bg-muted-foreground/45",
};

export function FactoryStateDot(props: { readonly state: FactoryAssignmentState }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT_CLASS[props.state])}
    />
  );
}
