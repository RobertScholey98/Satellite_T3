import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import type { OpenWorkTarget } from "../components/work/openWork.logic";
import { OpenWorkView } from "../components/work/OpenWorkView";

export const Route = createFileRoute("/_chat/open-work")({
  validateSearch: (raw: Record<string, unknown>): OpenWorkTarget => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.worktreePath === "string" && raw.worktreePath
      ? { worktreePath: raw.worktreePath.slice(0, 4096) }
      : {}),
  }),
  component: OpenWorkRouteView,
});

function OpenWorkRouteView() {
  const target = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return <OpenWorkView target={target} onTargetChange={(search) => void navigate({ search })} />;
}
