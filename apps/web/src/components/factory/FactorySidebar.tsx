import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type FactoryAssignmentId,
  type FactoryManager,
  type FactoryOnboardingReport,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  PlusIcon,
  Settings2Icon,
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
  factoryAssignmentStatus,
  factoryManagerPause,
  factoryPauseStatus,
  factoryProjectPause,
} from "./FactoryControlsReadModel";
import { factoryOversightSummary } from "./FactoryOversightReadModel";
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
const FactoryPolicyDialog = lazy(() =>
  import("./FactoryPolicyDialog").then((module) => ({ default: module.FactoryPolicyDialog })),
);
const FactoryBoundaryDialog = lazy(() =>
  import("./FactoryBoundaryDialog").then((module) => ({ default: module.FactoryBoundaryDialog })),
);
const FactoryModelPolicyDialog = lazy(() =>
  import("./FactoryModelPolicyDialog").then((module) => ({
    default: module.FactoryModelPolicyDialog,
  })),
);
const FactoryAssignmentDialog = lazy(() =>
  import("./FactoryAssignmentDialog").then((module) => ({
    default: module.FactoryAssignmentDialog,
  })),
);
const FactoryAssignmentDetailsDialog = lazy(() =>
  import("./FactoryAssignmentDialog").then((module) => ({
    default: module.FactoryAssignmentDetailsDialog,
  })),
);
const FactoryManagerControlsDialog = lazy(() =>
  import("./FactoryControls").then((module) => ({ default: module.FactoryManagerControlsDialog })),
);
const FactoryDeliverySettings = lazy(() =>
  import("./FactoryDeliverySettings").then((module) => ({
    default: module.FactoryDeliverySettings,
  })),
);

const managerStatusLabels = {
  onboarding: "Onboarding",
  blocked: "Needs setup",
  active: "Ready",
  paused: "Paused",
} satisfies Record<FactoryManager["status"], string>;

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
  const [boundaryManagerKey, setBoundaryManagerKey] = useState<string | null>(null);
  const [controlsManagerKey, setControlsManagerKey] = useState<string | null>(null);
  const [deliveryManagerKey, setDeliveryManagerKey] = useState<string | null>(null);
  const [policyTarget, setPolicyTarget] = useState<{
    readonly environmentId: EnvironmentId;
    readonly managerId: ThreadId | null;
  } | null>(null);
  const [modelTarget, setModelTarget] = useState<{
    environmentId: EnvironmentId;
    managerId: ThreadId | null;
  } | null>(null);
  const [assignmentTarget, setAssignmentTarget] = useState<{
    managerKey: string;
    mode: "commission" | "handover";
  } | null>(null);
  const [assignmentDetails, setAssignmentDetails] = useState<{
    environmentId: EnvironmentId;
    assignmentId: FactoryAssignmentId;
  } | null>(null);
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
  const controlsEntry = entries.find((entry) => entry.key === controlsManagerKey);
  const deliveryEntry = entries.find((entry) => entry.key === deliveryManagerKey);
  const boundaryEntry = entries.find((entry) => entry.key === boundaryManagerKey);
  const boundaryReport = boundaryEntry?.assignments.find(
    (assignment) => assignment.report !== null,
  )?.report;
  const policyEnvironment = environments.find(
    (environment) => environment.environmentId === policyTarget?.environmentId,
  );
  const policyManager = policyEnvironment?.data?.managers.find(
    (manager) => manager.id === policyTarget?.managerId,
  );
  const modelEnvironment = environments.find(
    (environment) => environment.environmentId === modelTarget?.environmentId,
  );
  const modelManager = modelEnvironment?.data?.managers.find(
    (manager) => manager.id === modelTarget?.managerId,
  );
  const assignmentEntry = entries.find((entry) => entry.key === assignmentTarget?.managerKey);
  const detailsEnvironment = environments.find(
    (environment) => environment.environmentId === assignmentDetails?.environmentId,
  );
  const detailsAssignment = detailsEnvironment?.data?.assignments.find(
    (assignment) => assignment.id === assignmentDetails?.assignmentId,
  );
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
          <div className="flex flex-wrap gap-1 px-1 py-1">
            {relevantEnvironments
              .filter((environment) => environment.data !== null)
              .map((environment) => (
                <div key={environment.environmentId} className="flex flex-wrap gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      setPolicyTarget({ environmentId: environment.environmentId, managerId: null })
                    }
                  >
                    Autonomy defaults
                    {relevantEnvironments.length > 1 ? ` · ${environment.label}` : ""}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      setModelTarget({ environmentId: environment.environmentId, managerId: null })
                    }
                  >
                    Model defaults{relevantEnvironments.length > 1 ? ` · ${environment.label}` : ""}
                  </Button>
                </div>
              ))}
          </div>
          <SidebarMenu>
            {entries.map(({ environment, manager, key, project, assignments }) => {
              const managerPause = factoryManagerPause(environment.data, manager.id);
              const projectPause = factoryProjectPause(environment.data, manager.projectId);
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
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Configure ${manager.name} autonomy`}
                      title="Manager autonomy"
                      onClick={() =>
                        setPolicyTarget({
                          environmentId: environment.environmentId,
                          managerId: manager.id,
                        })
                      }
                    >
                      <Settings2Icon aria-hidden />
                    </Button>
                  </div>
                  <div className="ml-7 flex flex-wrap items-center gap-x-2 gap-y-1 pb-1">
                    <span className="truncate text-2xs text-sidebar-muted-foreground">
                      {project?.title ?? "Project"}
                      {environments.length > 1 ? ` · ${environment.label}` : ""}
                    </span>
                    <Badge variant={manager.wait ? "warning" : "secondary"} size="sm">
                      {managerPause
                        ? `Manager: ${factoryPauseStatus(managerPause)}`
                        : managerStatusLabels[manager.status]}
                    </Badge>
                    {projectPause ? (
                      <Badge variant="warning" size="sm">
                        Project: {factoryPauseStatus(projectPause)}
                      </Badge>
                    ) : null}
                    {environment.data?.controls ? (
                      <Button size="xs" variant="ghost" onClick={() => setControlsManagerKey(key)}>
                        Controls
                      </Button>
                    ) : null}
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
                              title={
                                assignmentUnavailableReason ??
                                assignment.title ??
                                "Project onboarding"
                              }
                              isActive={
                                assignmentUnavailableReason === null &&
                                assignmentKey === activeThreadKey
                              }
                              onClick={() => onThreadActivate(threadRef)}
                            >
                              <ClipboardListIcon aria-hidden />
                              <span>
                                {assignment.title ??
                                  (assignment.kind === "onboarding"
                                    ? "Project onboarding"
                                    : assignment.kind === "rule-change"
                                      ? "Rule change"
                                      : "Implementation")}
                              </span>
                            </SidebarMenuButton>
                            <div className="ml-2 flex flex-wrap items-center gap-2 pb-1">
                              <span className="text-2xs text-sidebar-muted-foreground">
                                {factoryAssignmentStatus(environment.data, assignment)}
                                {assignment.preparation && assignment.preparation !== "ready"
                                  ? ` · ${assignment.preparation}`
                                  : ""}
                              </span>
                              {assignment.threadStatus === "created" &&
                              assignmentUnavailableReason ? (
                                <span className="text-2xs text-sidebar-muted-foreground">
                                  {assignmentUnavailableReason}
                                </span>
                              ) : null}
                              {assignment.report ? (
                                <>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => setReport(assignment.report)}
                                  >
                                    View report
                                  </Button>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => setBoundaryManagerKey(key)}
                                  >
                                    {manager.boundaryId ? "View boundary" : "Review boundary"}
                                  </Button>
                                </>
                              ) : null}
                              {assignment.kind !== "onboarding" || environment.data?.controls ? (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() =>
                                    setAssignmentDetails({
                                      environmentId: environment.environmentId,
                                      assignmentId: assignment.id,
                                    })
                                  }
                                >
                                  Assignment details
                                </Button>
                              ) : null}
                            </div>
                            {assignment.wait && assignment.wait.reason !== manager.wait?.reason ? (
                              <p className="mx-2 mb-2 break-words text-xs text-sidebar-muted-foreground">
                                {assignment.wait.reason}
                              </p>
                            ) : null}
                            {assignment.oversight?.recovery.incident ? (
                              <p className="px-2 text-xs text-muted-foreground">
                                {factoryOversightSummary(assignment)}
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
                      <SidebarMenuSubItem>
                        <div className="flex flex-wrap gap-1 py-1">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setModelTarget({
                                environmentId: environment.environmentId,
                                managerId: manager.id,
                              })
                            }
                          >
                            Team models
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => setDeliveryManagerKey(key)}
                          >
                            Delivery settings
                          </Button>
                          {manager.boundaryId ? (
                            <>
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={
                                  manager.status !== "active" ||
                                  projectPause !== undefined ||
                                  managerPause !== undefined ||
                                  !environment.connected ||
                                  !environment.canOperate
                                }
                                onClick={() =>
                                  setAssignmentTarget({ managerKey: key, mode: "commission" })
                                }
                              >
                                Assign work
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={
                                  manager.status !== "active" ||
                                  projectPause !== undefined ||
                                  managerPause !== undefined ||
                                  !environment.connected ||
                                  !environment.canOperate
                                }
                                onClick={() =>
                                  setAssignmentTarget({ managerKey: key, mode: "handover" })
                                }
                              >
                                Hand over thread
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </SidebarMenuSubItem>
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
        {deliveryEntry ? (
          <FactoryDeliverySettings
            key={deliveryEntry.key}
            environment={deliveryEntry.environment}
            manager={deliveryEntry.manager}
            onClose={() => setDeliveryManagerKey(null)}
          />
        ) : null}
        {controlsEntry ? (
          <FactoryManagerControlsDialog
            key={controlsEntry.key}
            environment={controlsEntry.environment}
            manager={controlsEntry.manager}
            onClose={() => setControlsManagerKey(null)}
          />
        ) : null}
        {creating ? (
          <CreateManagerDialog
            projects={scopedProjects}
            environments={environments}
            onClose={() => setCreating(false)}
          />
        ) : null}
        {report ? <OnboardingReportDialog report={report} onClose={() => setReport(null)} /> : null}
        {boundaryEntry && boundaryReport ? (
          <FactoryBoundaryDialog
            key={`${boundaryEntry.key}:${boundaryEntry.manager.boundaryId ?? "proposal"}`}
            environment={boundaryEntry.environment}
            manager={boundaryEntry.manager}
            report={boundaryReport}
            onClose={() => setBoundaryManagerKey(null)}
          />
        ) : null}
        {setupEntry?.project ? (
          <RetryManagerDialog
            key={setupEntry.key}
            project={setupEntry.project}
            environment={setupEntry.environment}
            manager={setupEntry.manager}
            onClose={() => setSetupManagerKey(null)}
          />
        ) : null}
        {policyEnvironment && (policyTarget?.managerId === null || policyManager) ? (
          <FactoryPolicyDialog
            key={`${policyEnvironment.environmentId}:${policyTarget?.managerId ?? "defaults"}`}
            environment={policyEnvironment}
            {...(policyManager ? { manager: policyManager } : {})}
            onClose={() => setPolicyTarget(null)}
          />
        ) : null}
        {modelEnvironment && (modelTarget?.managerId === null || modelManager) ? (
          <FactoryModelPolicyDialog
            key={`${modelEnvironment.environmentId}:${modelTarget?.managerId ?? "defaults"}`}
            environment={modelEnvironment}
            {...(modelManager ? { manager: modelManager } : {})}
            onClose={() => setModelTarget(null)}
          />
        ) : null}
        {assignmentEntry && assignmentTarget ? (
          <FactoryAssignmentDialog
            key={`${assignmentEntry.key}:${assignmentTarget.mode}`}
            environment={assignmentEntry.environment}
            manager={assignmentEntry.manager}
            projectTitle={assignmentEntry.project?.title ?? "Project"}
            threads={threads}
            mode={assignmentTarget.mode}
            onClose={() => setAssignmentTarget(null)}
          />
        ) : null}
        {detailsEnvironment && detailsAssignment ? (
          <FactoryAssignmentDetailsDialog
            key={`${detailsEnvironment.environmentId}:${detailsAssignment.id}`}
            environment={detailsEnvironment}
            assignment={detailsAssignment}
            canOpenThread={
              threadUnavailableReason(
                detailsAssignment.threadStatus,
                threadsByKey.get(
                  scopedThreadKey(
                    scopeThreadRef(detailsEnvironment.environmentId, detailsAssignment.threadId),
                  ),
                ),
              ) === null
            }
            onOpenThread={() => {
              setAssignmentDetails(null);
              onThreadActivate(
                scopeThreadRef(detailsEnvironment.environmentId, detailsAssignment.threadId),
              );
            }}
            onOpenRelatedThread={(threadId) => {
              setAssignmentDetails(null);
              onThreadActivate(scopeThreadRef(detailsEnvironment.environmentId, threadId));
            }}
            onClose={() => setAssignmentDetails(null)}
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
