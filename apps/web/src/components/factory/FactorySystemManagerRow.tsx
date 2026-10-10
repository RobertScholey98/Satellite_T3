import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { AuthSettingsWriteScope, type ThreadId } from "@t3tools/contracts";
import { NetworkIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { factoryManagerPause, factoryPauseStatus } from "./FactoryControlsReadModel";

const Setup = lazy(() =>
  import("./FactorySystemManagerSetup").then((module) => ({
    default: module.FactorySystemManagerSetup,
  })),
);
const Improvements = lazy(() =>
  import("./FactoryImprovementsDialog").then((module) => ({
    default: module.FactoryImprovementsDialog,
  })),
);

export function FactorySystemManagerRow({
  environment,
  projects,
  activeThreadId,
  canOpenThread,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  projects: readonly EnvironmentProject[];
  activeThreadId: ThreadId | null;
  canOpenThread: (id: ThreadId) => boolean;
  onOpenThread: (id: ThreadId) => void;
}) {
  const [dialog, setDialog] = useState<"setup" | "improvements" | null>(null);
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const manager = environment.data?.managers.find((entry) => entry.role === "system");
  const pause = manager ? factoryManagerPause(environment.data, manager.id) : undefined;
  const canSetup = environment.connected && environment.canOperate && settingsScope;
  const pendingReviews = [
    ...new Map(environment.data?.improvementProposals.map((entry) => [entry.id, entry])).values(),
  ].filter((entry) => entry.phase === "human-review").length;
  const openThread = (id: ThreadId) => {
    setDialog(null);
    onOpenThread(id);
  };
  if (!environment.data) return null;
  return (
    <>
      {manager ? (
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={activeThreadId === manager.threadId && canOpenThread(manager.threadId)}
              disabled={manager.threadStatus !== "created" || !canOpenThread(manager.threadId)}
              onClick={() => openThread(manager.threadId)}
              title={manager.name}
            >
              <NetworkIcon aria-hidden />
              <span>{manager.name}</span>
            </SidebarMenuButton>
            <div className="ml-7 flex flex-wrap items-center gap-2 pb-1">
              <span className="text-2xs text-sidebar-muted-foreground">
                Shared workflow · {environment.label}
              </span>
              <Badge size="sm" variant={manager.wait ? "warning" : "secondary"}>
                {pause
                  ? factoryPauseStatus(pause)
                  : manager.status === "active"
                    ? "Ready"
                    : manager.status === "blocked"
                      ? "Needs setup"
                      : manager.status === "onboarding"
                        ? "Preparing"
                        : "Paused"}
              </Badge>
              <Button size="xs" variant="ghost" onClick={() => setDialog("improvements")}>
                Shared improvements{pendingReviews ? ` (${pendingReviews})` : ""}
              </Button>
              {manager.status === "blocked" ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canSetup}
                  onClick={() => setDialog("setup")}
                >
                  Edit setup and retry
                </Button>
              ) : null}
              {!environment.connected ? (
                <span className="text-2xs text-sidebar-muted-foreground">Offline</span>
              ) : null}
            </div>
            {manager.wait ? (
              <p className="ml-7 mb-2 break-words text-xs text-sidebar-muted-foreground">
                {manager.wait.reason}
              </p>
            ) : null}
          </SidebarMenuItem>
        </SidebarMenu>
      ) : (
        <div className="px-1 py-1">
          <Button size="xs" variant="ghost" disabled={!canSetup} onClick={() => setDialog("setup")}>
            Create system manager · {environment.label}
          </Button>
        </div>
      )}
      <Suspense fallback={null}>
        {dialog === "setup" ? (
          <Setup
            environment={environment}
            projects={projects}
            {...(manager ? { manager } : {})}
            onClose={() => setDialog(null)}
          />
        ) : null}
        {dialog === "improvements" && manager ? (
          <Improvements
            environment={environment}
            projects={projects}
            manager={manager}
            canOpenThread={canOpenThread}
            onOpenThread={openThread}
            onClose={() => setDialog(null)}
          />
        ) : null}
      </Suspense>
    </>
  );
}
