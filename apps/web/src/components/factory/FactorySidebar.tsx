import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type FactoryAssignment,
  type FactoryManager,
  type FactoryOnboardingReport,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  PlusIcon,
  UsersIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";

import { factoryEnvironment, type FactoryEnvironmentView } from "../../state/factory";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from "../ui/sidebar";
const CreateManagerDialog = lazy(() =>
  import("./CreateManagerDialog").then((module) => ({ default: module.CreateManagerDialog })),
);
const RetryManagerDialog = lazy(() =>
  import("./CreateManagerDialog").then((module) => ({ default: module.RetryManagerDialog })),
);
const OnboardingReportDialog = lazy(() =>
  import("./OnboardingReportDialog").then((module) => ({ default: module.OnboardingReportDialog })),
);

const managerStatusLabels = {
  onboarding: "Onboarding",
  blocked: "Needs setup",
  active: "Ready",
  paused: "Paused",
} satisfies Record<FactoryManager["status"], string>;

const assignmentStatusLabels = {
  pending: "Preparing",
  running: "Working",
  waiting: "Waiting",
  complete: "Complete",
} satisfies Record<FactoryAssignment["status"], string>;

function threadUnavailableReason(
  status: FactoryManager["threadStatus"],
  shell: EnvironmentThreadShell | undefined,
) {
  if (status !== "created") return "Thread not created yet";
  if (!shell) return "Thread unavailable";
  if (shell.deletedAt !== null) return "Thread deleted";
  if (shell.archivedAt !== null) return "Thread archived";
  return null;
}

export function FactorySidebar({
  environments,
  projects,
  threads,
  scopedProjectKeys,
  activeThreadKey,
  onThreadActivate,
  onVisibleThreadsChange,
}: {
  readonly environments: readonly FactoryEnvironmentView[];
  readonly projects: readonly EnvironmentProject[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly activeThreadKey: string | null;
  readonly onThreadActivate: (thread: ScopedThreadRef) => unknown;
  readonly onVisibleThreadsChange: (keys: readonly string[]) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [collapsedManagers, setCollapsedManagers] = useState<ReadonlySet<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [report, setReport] = useState<FactoryOnboardingReport | null>(null);
  const [setupManagerKey, setSetupManagerKey] = useState<string | null>(null);
  const sectionId = useId();
  const threadsByKey = useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          thread,
        ]),
      ),
    [threads],
  );
  const scopedProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          scopedProjectKeys === null ||
          scopedProjectKeys.has(`${project.environmentId}:${project.id}`),
      ),
    [projects, scopedProjectKeys],
  );
  const entries = useMemo(
    () =>
      environments.flatMap((environment) =>
        (environment.data?.managers ?? []).flatMap((manager) => {
          if (
            manager.role !== "project" ||
            (scopedProjectKeys !== null &&
              !scopedProjectKeys.has(`${environment.environmentId}:${manager.projectId}`))
          )
            return [];
          return [
            {
              environment,
              manager,
              key: scopedThreadKey(scopeThreadRef(environment.environmentId, manager.threadId)),
              project: projects.find(
                (project) =>
                  project.environmentId === environment.environmentId &&
                  project.id === manager.projectId,
              ),
              assignments:
                environment.data?.assignments.filter(
                  (assignment) => assignment.managerId === manager.id,
                ) ?? [],
            },
          ];
        }),
      ),
    [environments, projects, scopedProjectKeys],
  );
  const visibleKeys = useMemo(
    () =>
      expanded
        ? entries
            .flatMap(({ environment, manager, key, assignments }) => [
              ...(manager.threadStatus === "created" ? [key] : []),
              ...(collapsedManagers.has(key)
                ? []
                : assignments
                    .filter((assignment) => assignment.threadStatus === "created")
                    .map((assignment) =>
                      scopedThreadKey(
                        scopeThreadRef(environment.environmentId, assignment.threadId),
                      ),
                    )),
            ])
            .filter((key) => threadUnavailableReason("created", threadsByKey.get(key)) === null)
        : [],
    [collapsedManagers, entries, expanded, threadsByKey],
  );
  useEffect(() => {
    onVisibleThreadsChange(visibleKeys);
  }, [onVisibleThreadsChange, visibleKeys]);
  useEffect(() => () => onVisibleThreadsChange([]), [onVisibleThreadsChange]);

  const canCreate = scopedProjects.some((project) => {
    const environment = environments.find((entry) => entry.environmentId === project.environmentId);
    return (
      environment?.connected &&
      environment.canOperate &&
      environment.data !== null &&
      !environment.data.managers.some(
        (manager) => manager.role === "project" && manager.projectId === project.id,
      )
    );
  });
  const relevantEnvironments = environments.filter((environment) =>
    scopedProjects.some((project) => project.environmentId === environment.environmentId),
  );
  const setupEntry = entries.find((entry) => entry.key === setupManagerKey);
  if (projects.length === 0) return null;

  return (
    <SidebarGroup aria-label="Engineering managers">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            expanded={expanded}
            aria-controls={sectionId}
            onClick={() => setExpanded((value) => !value)}
          >
            Engineering managers
          </CollapsibleSectionHeader>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Create engineering manager"
          title={
            canCreate ? "Create engineering manager" : "A connected unmanaged project is required"
          }
          disabled={!canCreate}
          onClick={() => setCreating(true)}
        >
          <PlusIcon aria-hidden />
        </Button>
      </div>
      {expanded ? (
        <div id={sectionId}>
          <SidebarMenu>
            {entries.map(({ environment, manager, key, project, assignments }) => {
              const childrenExpanded = !collapsedManagers.has(key);
              const unavailableReason = threadUnavailableReason(
                manager.threadStatus,
                threadsByKey.get(key),
              );
              return (
                <SidebarMenuItem key={key}>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${childrenExpanded ? "Collapse" : "Expand"} ${manager.name} assignments`}
                      aria-expanded={childrenExpanded}
                      onClick={() =>
                        setCollapsedManagers((current) => {
                          const next = new Set(current);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    >
                      {childrenExpanded ? (
                        <ChevronDownIcon aria-hidden />
                      ) : (
                        <ChevronRightIcon aria-hidden />
                      )}
                    </Button>
                    <div className="min-w-0 flex-1">
                      <SidebarMenuButton
                        isActive={unavailableReason === null && key === activeThreadKey}
                        disabled={unavailableReason !== null}
                        onClick={() =>
                          onThreadActivate(
                            scopeThreadRef(environment.environmentId, manager.threadId),
                          )
                        }
                        title={unavailableReason ?? manager.name}
                      >
                        <UsersIcon aria-hidden />
                        <span>{manager.name}</span>
                      </SidebarMenuButton>
                    </div>
                  </div>
                  <div className="ml-7 flex flex-wrap items-center gap-x-2 gap-y-1 pb-1">
                    <span className="truncate text-2xs text-sidebar-muted-foreground">
                      {project?.title ?? "Project"}
                      {environments.length > 1 ? ` · ${environment.label}` : ""}
                    </span>
                    <Badge variant={manager.wait ? "warning" : "secondary"} size="sm">
                      {managerStatusLabels[manager.status]}
                    </Badge>
                    {manager.threadStatus === "created" && unavailableReason ? (
                      <span className="text-2xs text-sidebar-muted-foreground">
                        {unavailableReason}
                      </span>
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
                  {childrenExpanded ? (
                    <SidebarMenuSub>
                      {assignments.map((assignment) => {
                        const threadRef = scopeThreadRef(
                          environment.environmentId,
                          assignment.threadId,
                        );
                        const assignmentKey = scopedThreadKey(threadRef);
                        const assignmentUnavailableReason = threadUnavailableReason(
                          assignment.threadStatus,
                          threadsByKey.get(assignmentKey),
                        );
                        return (
                          <SidebarMenuSubItem key={assignment.id}>
                            <SidebarMenuButton
                              size="sm"
                              disabled={assignmentUnavailableReason !== null}
                              title={assignmentUnavailableReason ?? "Project onboarding"}
                              isActive={
                                assignmentUnavailableReason === null &&
                                assignmentKey === activeThreadKey
                              }
                              onClick={() => onThreadActivate(threadRef)}
                            >
                              <ClipboardListIcon aria-hidden />
                              <span>Project onboarding</span>
                            </SidebarMenuButton>
                            <div className="ml-2 flex flex-wrap items-center gap-2 pb-1">
                              <span className="text-2xs text-sidebar-muted-foreground">
                                {assignmentStatusLabels[assignment.status]}
                              </span>
                              {assignment.threadStatus === "created" &&
                              assignmentUnavailableReason ? (
                                <span className="text-2xs text-sidebar-muted-foreground">
                                  {assignmentUnavailableReason}
                                </span>
                              ) : null}
                              {assignment.report ? (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => setReport(assignment.report)}
                                >
                                  View report
                                </Button>
                              ) : null}
                            </div>
                            {assignment.wait && assignment.wait.reason !== manager.wait?.reason ? (
                              <p className="mx-2 mb-2 break-words text-xs text-sidebar-muted-foreground">
                                {assignment.wait.reason}
                              </p>
                            ) : null}
                          </SidebarMenuSubItem>
                        );
                      })}
                      {manager.status === "blocked" &&
                      environment.canOperate &&
                      assignments.some((assignment) => assignment.report === null) &&
                      !assignments.some((assignment) => assignment.report !== null) ? (
                        <SidebarMenuSubItem>
                          {project &&
                          manager.threadStatus === "pending" &&
                          assignments.every(
                            (assignment) => assignment.threadStatus === "pending",
                          ) ? (
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={!environment.connected}
                              onClick={() => setSetupManagerKey(key)}
                            >
                              Edit setup and retry
                            </Button>
                          ) : (
                            <RetryOnboarding environment={environment} manager={manager} />
                          )}
                        </SidebarMenuSubItem>
                      ) : null}
                    </SidebarMenuSub>
                  ) : null}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
          {entries.length === 0 ? (
            <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">
              {relevantEnvironments.some((environment) => environment.pending)
                ? "Loading managers..."
                : "Delegate project delivery to an engineering manager."}
            </p>
          ) : null}
          {relevantEnvironments
            .filter((environment) => environment.error !== null)
            .map((environment) => (
              <p
                key={environment.environmentId}
                role="status"
                className="px-2 py-1 text-xs text-sidebar-muted-foreground"
              >
                {environment.label}: {environment.error}
              </p>
            ))}
        </div>
      ) : null}
      <Suspense fallback={null}>
        {creating ? (
          <CreateManagerDialog
            projects={scopedProjects}
            environments={environments}
            onClose={() => setCreating(false)}
          />
        ) : null}
        {report ? <OnboardingReportDialog report={report} onClose={() => setReport(null)} /> : null}
        {setupEntry?.project ? (
          <RetryManagerDialog
            key={setupEntry.key}
            project={setupEntry.project}
            environment={setupEntry.environment}
            manager={setupEntry.manager}
            onClose={() => setSetupManagerKey(null)}
          />
        ) : null}
      </Suspense>
    </SidebarGroup>
  );
}

function RetryOnboarding({
  environment,
  manager,
}: {
  readonly environment: FactoryEnvironmentView;
  readonly manager: FactoryManager;
}) {
  const dispatch = useAtomCommand(factoryEnvironment.dispatch, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commandId = useRef<CommandId | null>(null);
  const inFlight = useRef(false);
  const retry = async () => {
    if (inFlight.current || !environment.connected) return;
    inFlight.current = true;
    commandId.current ??= CommandId.make(randomUUID());
    setPending(true);
    setError(null);
    const result = await dispatch({
      environmentId: environment.environmentId,
      input: {
        command: {
          type: "manager.retry-onboarding",
          commandId: commandId.current,
          managerId: manager.id,
        },
      },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not retry onboarding.");
    } else commandId.current = null;
    inFlight.current = false;
    setPending(false);
  };
  return (
    <div className="space-y-1">
      <Button
        variant="ghost"
        size="xs"
        disabled={pending || !environment.connected}
        onClick={() => void retry()}
      >
        {pending ? "Checking setup..." : "Retry onboarding"}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
