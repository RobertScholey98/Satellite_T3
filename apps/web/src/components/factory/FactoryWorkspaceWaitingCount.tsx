import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { useFactoryManagerWaitingCount } from "./factoryWorkspaceState";

/** On a manager's sidebar row: how many of its team threads wait on the user, who can't see them there. */
export function FactoryWorkspaceWaitingCount(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const count = useFactoryManagerWaitingCount(props.environmentId, props.threadId);
  if (count === 0) return null;
  const label = `${count} ${count === 1 ? "team waits" : "teams wait"} on you`;
  return (
    <Badge size="sm" variant="warning" aria-label={label} title={label}>
      {count}
    </Badge>
  );
}
