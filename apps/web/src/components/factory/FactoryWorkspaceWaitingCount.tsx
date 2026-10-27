import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** On a manager's sidebar row: how many of its team threads wait on the user, who can't see them there. */
export function FactoryWorkspaceWaitingCount(props: { readonly count: number }) {
  const { count } = props;
  if (count === 0) return null;
  const label = `${count} ${count === 1 ? "team waits" : "teams wait"} on you`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className="shrink-0 text-xs font-medium tabular-nums text-info-foreground"
          />
        }
      >
        {count}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
