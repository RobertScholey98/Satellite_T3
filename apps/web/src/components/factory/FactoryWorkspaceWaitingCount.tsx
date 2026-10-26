import { Badge } from "../ui/badge";

/** On a manager's sidebar row: how many of its team threads wait on the user, who can't see them there. */
export function FactoryWorkspaceWaitingCount(props: { readonly count: number }) {
  const { count } = props;
  if (count === 0) return null;
  const label = `${count} ${count === 1 ? "team waits" : "teams wait"} on you`;
  return (
    <Badge size="sm" variant="warning" aria-label={label} title={label}>
      {count}
    </Badge>
  );
}
