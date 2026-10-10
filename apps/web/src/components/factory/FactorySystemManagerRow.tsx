import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  AuthSettingsWriteScope,
  type FactoryAssignmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, ClipboardListIcon, NetworkIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import {
  factoryAssignmentStatus,
  factoryManagerPause,
  factoryPauseStatus,
} from "./FactoryControlsReadModel";

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
const Workflow = lazy(() =>
  import("./FactoryWorkflowDialog").then((module) => ({ default: module.FactoryWorkflowDialog })),
);

export function FactorySystemManagerRow({
  environment,
  projects,
  activeThreadId,
  teamsExpanded,
  onToggleTeams,
  onAssignmentDetails,
  canOpenThread,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  projects: readonly EnvironmentProject[];
  activeThreadId: ThreadId | null;
  teamsExpanded: boolean;
  onToggleTeams: () => void;
  onAssignmentDetails: (assignmentId: FactoryAssignmentId) => void;
  canOpenThread: (id: ThreadId) => boolean;
  onOpenThread: (id: ThreadId) => void;
}) {
  const [dialog, setDialog] = useState<"setup" | "improvements" | "workflow" | null>(null);
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const manager = environment.data?.managers.find((entry) => entry.role === "system");
  const pause = manager ? factoryManagerPause(environment.data, manager.id) : undefined;
  const assignments =
    environment.data?.assignments.filter((entry) => entry.managerId === manager?.id) ?? [];
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
            <div className="flex items-center gap-1">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-expanded={teamsExpanded}
                aria-label={`${teamsExpanded ? "Collapse" : "Expand"} ${manager.name} assignments`}
                onClick={onToggleTeams}
              >
                {teamsExpanded ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
              </Button>
              <div className="min-w-0 flex-1">
                <SidebarMenuButton
                  isActive={activeThreadId === manager.threadId && canOpenThread(manager.threadId)}
                  disabled={manager.threadStatus !== "created" || !canOpenThread(manager.threadId)}
                  onClick={() => openThread(manager.threadId)}
                  title={manager.name}
                >
                  <NetworkIcon aria-hidden />
                  <span>{manager.name}</span>
                </SidebarMenuButton>
              </div>
            </div>
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
              <Button size="xs" variant="ghost" onClick={() => setDialog("workflow")}>
                Workflow delivery
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
            {teamsExpanded && assignments.length ? (
              <SidebarMenuSub>
                {assignments.map((assignment) => {
                  const retro = environment.data?.retros.find(
                    (entry) => entry.assignmentId === assignment.id,
                  );
                  return (
                    <SidebarMenuSubItem key={assignment.id}>
                      <SidebarMenuButton
                        size="sm"
                        isActive={
                          activeThreadId === assignment.threadId &&
                          canOpenThread(assignment.threadId)
                        }
                        disabled={
                          assignment.threadStatus !== "created" ||
                          !canOpenThread(assignment.threadId)
                        }
                        onClick={() => openThread(assignment.threadId)}
                      >
                        <ClipboardListIcon aria-hidden />
                        <span>{assignment.title ?? "Shared workflow implementation"}</span>
                      </SidebarMenuButton>
                      <div className="ml-2 flex flex-wrap items-center gap-2 pb-1">
                        <span className="text-2xs text-sidebar-muted-foreground">
                          {factoryAssignmentStatus(environment.data, assignment)}
                        </span>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => onAssignmentDetails(assignment.id)}
                        >
                          Assignment details
                        </Button>
                      </div>
                      {assignment.wait ? (
                        <p className="mx-2 mb-2 break-words text-xs text-sidebar-muted-foreground">
                          {assignment.wait.reason}
                        </p>
                      ) : null}
                      {retro ? (
                        <div className="ml-4 pb-1">
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={!canOpenThread(retro.threadId)}
                            onClick={() => openThread(retro.threadId)}
                          >
                            Team retro ·{" "}
                            {retro.reports.phase === "complete"
                              ? "Complete"
                              : retro.reports.phase === "manager-pending"
                                ? "Manager review"
                                : "In progress"}
                          </Button>
                        </div>
                      ) : null}
                    </SidebarMenuSubItem>
                  );
                })}
              </SidebarMenuSub>
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
        {dialog === "workflow" && manager ? (
          <Workflow
            environment={environment}
            projects={projects}
            manager={manager}
            canOpenThread={canOpenThread}
            onOpenThread={openThread}
            onClose={() => setDialog(null)}
          />
        ) : null}
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
